--------------------------- MODULE FinixPOSCrash ---------------------------
(***************************************************************************)
(* Crash-restart / durability extension (review point 2.2).                *)
(*                                                                         *)
(* Adds to the single-attempt environment:                                 *)
(*   - dehydration: the row terminal_transactions mirrors the live model   *)
(*     on every transition (dehydrateTerminalTx, lines 2129-2203) — here   *)
(*     the row is captured at crash time (it is identical to the live      *)
(*     state at every step, so only the crash snapshot matters);           *)
(*   - a POS crash at any non-IDLE point, then restart running the actual  *)
(*     rehydration logic (rehydrateTerminalWorkflows 1574-1704 + factory   *)
(*     boot 1312-1350):                                                    *)
(*       AWAITING_TAP + transferId -> fast-forward, poll resumes (live);   *)
(*       INITIATING -> row either rehydrated as a ZOMBIE (fresh row: the   *)
(*         factory does NOT fast-forward INITIATING, no NAP ever fires) or *)
(*         rewritten tx_state='CANCELLED' in the DB with NO Finix probe    *)
(*         (stale >5 min, lines 1588-1613);                                *)
(*       RECORDING / CANCELLING / AWAITING_VERIFICATION -> ZOMBIE (the     *)
(*         rehydration SELECT loads them but the factory fast-forwards     *)
(*         only AWAITING_TAP, so the live FSM sits at pc0=IDLE and no NAP  *)
(*         or poll ever fires again);                                      *)
(*       COMPLETED/DECLINED/CANCELLED -> not rehydrated (terminal rows).   *)
(*   - the in-flight createTerminalSale POST survives the crash on the     *)
(*     network: Finix may still create the transfer AFTER the restart, and *)
(*     the customer can still tap it (the device prompt is independent of  *)
(*     the POS process).                                                   *)
(*                                                                         *)
(* PATCHED gates the gap-fix patch semantics that matter here:             *)
(*   - gap-5 sweep: recoverChargedButCancelledPayments probes CANCELLED    *)
(*     rows THAT CARRY a finix_transfer_id;                                *)
(*   - cancel-NAP breadcrumb when cancelling with no transferId.           *)
(* The patch does NOT touch rehydration — that is exactly what this model  *)
(* probes.                                                                 *)
(*                                                                         *)
(* txState value "ZOMBIE" = live workflow present but inert (FSM at IDLE,  *)
(* _lastModel stale, no NAP/poll).  The DB row keeps rowTx/rowTid.         *)
(***************************************************************************)
EXTENDS FinixPOS

CONSTANT PATCHED

ORDER   == "O1"
TID     == "T1"
PID     == "P1"
REQ_AMT == 10

VARIABLES
  finixState,       \* NONE PENDING SUCCEEDED FAILED
  reqSent,          \* a create POST was handed to the network
  attempt,          \* 0 idle | 1 in flight | 4 ladder dead
  cancelDone,       \* cancel NAP fired for this CANCELLING entry
  breadcrumb,       \* pending_terminal_sales row exists
  paymentRecorded,  \* payments row exists for this order's transfer
  crashed,          \* 0 = never crashed, 1 = crashed once (bound)
  rowTx, rowTid     \* the persisted terminal_transactions row after crash
                    \* (before a crash the row mirrors the live model)

envVars == <<finixState, reqSent, attempt, cancelDone, breadcrumb,
             paymentRecorded, crashed, rowTx, rowTid>>
vars    == <<txState, orderId, amountCents, transferId, declineCode,
             approvedAmountCents, paymentId,
             finixState, reqSent, attempt, cancelDone, breadcrumb,
             paymentRecorded, crashed, rowTx, rowTid>>

\* Effective DB row: mirrors the live model until a crash freezes it.
EffTx  == IF crashed = 1 THEN rowTx  ELSE txState
EffTid == IF crashed = 1 THEN rowTid ELSE transferId

TypeOK ==
  /\ txState \in PosStates \union {"ZOMBIE"}
  /\ finixState \in {NONE, "PENDING", "SUCCEEDED", "FAILED"}
  /\ reqSent \in BOOLEAN /\ attempt \in {0, 1, 4}
  /\ cancelDone \in BOOLEAN /\ breadcrumb \in BOOLEAN
  /\ paymentRecorded \in BOOLEAN /\ crashed \in {0, 1}
  /\ rowTx \in PosStates \union {NONE} /\ rowTid \in {NONE, TID}

Init ==
  /\ PosInit
  /\ finixState = NONE /\ reqSent = FALSE /\ attempt = 0
  /\ cancelDone = FALSE /\ breadcrumb = FALSE /\ paymentRecorded = FALSE
  /\ crashed = 0 /\ rowTx = NONE /\ rowTid = NONE

-----------------------------------------------------------------------------
(* Pre-crash single-attempt ladder (compressed from FinixPOSEnv: one       *)
(* request; a lost response goes straight to the Case-4 resolution).       *)

Initiate ==
  /\ txState = "IDLE" /\ crashed = 0
  /\ DispatchInitiate(ORDER, REQ_AMT)
  /\ UNCHANGED envVars

NapCreateStart ==
  /\ txState = "INITIATING" /\ attempt = 0
  /\ attempt' = 1 /\ reqSent' = TRUE
  /\ UNCHANGED <<posVars, finixState, cancelDone, breadcrumb,
                 paymentRecorded, crashed, rowTx, rowTid>>

\* Finix processes the request — possibly AFTER the POS crashed (the whole
\* point): the POST is on the wire, the process that sent it is gone.
FinixCreates ==
  /\ reqSent /\ finixState = NONE
  /\ finixState' = "PENDING"
  /\ UNCHANGED <<posVars, reqSent, attempt, cancelDone, breadcrumb,
                 paymentRecorded, crashed, rowTx, rowTid>>

DeliverCreateResp ==
  /\ attempt = 1 /\ finixState = "PENDING" /\ txState = "INITIATING"
  /\ attempt' = 4
  /\ DispatchTransferCreated(TID)
  /\ UNCHANGED <<finixState, reqSent, cancelDone, breadcrumb,
                 paymentRecorded, crashed, rowTx, rowTid>>

\* Response lost -> last-gasp + Case 4 (lines 525-625): probe; a SUCCEEDED
\* probe records; a PENDING transfer is device-cancelled; else breadcrumb +
\* AWAITING_VERIFICATION.  (Compressed; the FinixPOSEnv model covers the
\* fuller ladder — this model's focus is the crash.)
RespLostResolve ==
  /\ attempt = 1 /\ txState = "INITIATING"
  /\ attempt' = 4
  /\ UNCHANGED <<reqSent, cancelDone, crashed, rowTx, rowTid>>
  /\ CASE finixState = "SUCCEEDED" ->
            /\ paymentRecorded' = TRUE
            /\ txState' = "RECORDING" /\ transferId' = TID
            /\ approvedAmountCents' = REQ_AMT
            /\ UNCHANGED <<orderId, amountCents, declineCode, paymentId,
                           finixState, breadcrumb>>
       [] finixState = "PENDING" ->
            /\ finixState' = "FAILED"
            /\ breadcrumb' = TRUE
            /\ DispatchVerificationStarted
            /\ UNCHANGED paymentRecorded
       [] OTHER ->
            /\ breadcrumb' = TRUE
            /\ DispatchVerificationStarted
            /\ UNCHANGED <<finixState, paymentRecorded>>

-----------------------------------------------------------------------------
(* Customer at the terminal — independent of the POS process.               *)

CustomerApprove ==
  /\ finixState = "PENDING"
  /\ finixState' = "SUCCEEDED"
  /\ UNCHANGED <<posVars, reqSent, attempt, cancelDone, breadcrumb,
                 paymentRecorded, crashed, rowTx, rowTid>>

CustomerDecline ==
  /\ finixState = "PENDING"
  /\ finixState' = "FAILED"
  /\ UNCHANGED <<posVars, reqSent, attempt, cancelDone, breadcrumb,
                 paymentRecorded, crashed, rowTx, rowTid>>

-----------------------------------------------------------------------------
(* Live POS behaviour (poll / staff cancel / cancel NAP / record NAP).      *)
(* All of these require a LIVE state — a ZOMBIE has none of them.           *)

PollDeliver ==
  /\ txState = "AWAITING_TAP" /\ transferId # NONE
  /\ UNCHANGED <<finixState, reqSent, attempt, cancelDone, breadcrumb,
                 paymentRecorded, crashed, rowTx, rowTid>>
  /\ CASE finixState = "SUCCEEDED" -> DispatchTapApproved(REQ_AMT)
       [] finixState = "FAILED"    -> DispatchTapDeclined("ISSUER_DECLINE")
       [] OTHER -> FALSE

StaffCancel ==
  /\ txState = "AWAITING_TAP"
  /\ DispatchCancelPayment
  /\ UNCHANGED envVars

CancelNap ==
  /\ txState = "CANCELLING" /\ ~cancelDone
  /\ cancelDone' = TRUE
  /\ UNCHANGED <<reqSent, attempt, crashed, rowTx, rowTid>>
  /\ CASE finixState = "SUCCEEDED" ->
            /\ DispatchTapApproved(REQ_AMT)
            /\ UNCHANGED <<finixState, breadcrumb, paymentRecorded>>
       [] finixState = "PENDING" ->
            /\ finixState' = "FAILED"
            /\ DispatchCancelConfirmed
            /\ breadcrumb' = IF PATCHED /\ transferId = NONE
                             THEN TRUE ELSE breadcrumb
            /\ UNCHANGED paymentRecorded
       [] OTHER ->
            /\ DispatchCancelConfirmed
            /\ breadcrumb' = IF PATCHED /\ transferId = NONE
                             THEN TRUE ELSE breadcrumb
            /\ UNCHANGED <<finixState, paymentRecorded>>

RecordNap ==
  /\ txState = "RECORDING"
  /\ paymentRecorded' = TRUE
  /\ DispatchPaymentRecorded(PID)
  /\ UNCHANGED <<finixState, reqSent, attempt, cancelDone, breadcrumb,
                 crashed, rowTx, rowTid>>

-----------------------------------------------------------------------------
(* Crash + restart (at most one crash; the rehydration mapping is applied   *)
(* atomically as part of the crash step).                                   *)

CrashRestart ==
  /\ crashed = 0 /\ txState \notin {"IDLE"}
  /\ crashed' = 1
  /\ rowTid'  = transferId
  /\ attempt' = 4          \* in-flight response is never delivered
  /\ cancelDone' = TRUE    \* transient NAP flags are process-local and lost
  /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                 approvedAmountCents, paymentId,
                 finixState, reqSent, breadcrumb, paymentRecorded>>
  /\ CASE txState = "AWAITING_TAP" /\ transferId # NONE ->
            \* factory fast-forward: poll resumes on the persisted transfer
            /\ rowTx' = "AWAITING_TAP"
            /\ txState' = "AWAITING_TAP"
       [] txState = "INITIATING" ->
            \* fresh row: rehydrated but never fast-forwarded (ZOMBIE);
            \* stale row (>5 min): tx_state = 'CANCELLED' with NO probe
            \* (lines 1588-1613).  Both orderings reachable.
            /\ \/ rowTx' = "INITIATING"
               \/ rowTx' = "CANCELLED"
            /\ txState' = "ZOMBIE"
       [] txState \in {"COMPLETED", "DECLINED", "CANCELLED"} ->
            \* terminal rows are not rehydrated; row keeps its state
            /\ rowTx' = txState
            /\ txState' = txState
       [] OTHER ->
            \* RECORDING / CANCELLING / AWAITING_VERIFICATION: rehydrated,
            \* no fast-forward, live FSM at pc0 -> inert
            /\ rowTx' = txState
            /\ txState' = "ZOMBIE"

-----------------------------------------------------------------------------
(* Sweeps — these operate on DB rows, so they work on EffTx/EffTid and are  *)
(* independent of whether the workflow is live, pruned, or a zombie.        *)

\* sweepOrphanedTerminalSales via the breadcrumb (idempotency_id or
\* transfer_id): the DB path records a SUCCEEDED transfer directly.
SweepBreadcrumb ==
  /\ breadcrumb /\ finixState = "SUCCEEDED" /\ ~paymentRecorded
  /\ paymentRecorded' = TRUE
  /\ UNCHANGED <<posVars, finixState, reqSent, attempt, cancelDone,
                 breadcrumb, crashed, rowTx, rowTid>>

\* recoverOrphanedCompletedPayments: COMPLETED row, no payments row,
\* finix_transfer_id NOT NULL (lines 1706-1820).
SweepCompletedOrphan ==
  /\ EffTx = "COMPLETED" /\ EffTid # NONE /\ ~paymentRecorded
  /\ paymentRecorded' = TRUE
  /\ UNCHANGED <<posVars, finixState, reqSent, attempt, cancelDone,
                 breadcrumb, crashed, rowTx, rowTid>>

\* recoverChargedButCancelledPayments (patch, gap 5): CANCELLED row WITH a
\* transfer id whose probe is SUCCEEDED.
SweepCancelledCharged ==
  /\ PATCHED
  /\ EffTx = "CANCELLED" /\ EffTid # NONE
  /\ finixState = "SUCCEEDED" /\ ~paymentRecorded
  /\ paymentRecorded' = TRUE
  /\ UNCHANGED <<posVars, finixState, reqSent, attempt, cancelDone,
                 breadcrumb, crashed, rowTx, rowTid>>

-----------------------------------------------------------------------------

Next ==
  \/ Initiate \/ NapCreateStart \/ FinixCreates \/ DeliverCreateResp
  \/ RespLostResolve
  \/ CustomerApprove \/ CustomerDecline
  \/ PollDeliver \/ StaffCancel \/ CancelNap \/ RecordNap
  \/ CrashRestart
  \/ SweepBreadcrumb \/ SweepCompletedOrphan \/ SweepCancelledCharged

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Invariants                                                               *)

\* A DB row from which some existing recovery mechanism can still reach the
\* charge:  breadcrumb sweep, COMPLETED-orphan sweep, patched CANCELLED
\* sweep, or a live resumed poll.
Recoverable ==
  \/ breadcrumb
  \/ (EffTx = "COMPLETED" /\ EffTid # NONE)
  \/ (PATCHED /\ EffTx = "CANCELLED" /\ EffTid # NONE)
  \/ (txState = "AWAITING_TAP" /\ transferId # NONE)   \* live poll

\* Dead ends: live terminal failure states, or crash zombies (whose rows the
\* rehydration/sweep machinery never advances).
DeadEnd ==
  \/ (txState \in {"DECLINED", "CANCELLED"})
  \/ (txState = "ZOMBIE")

Inv_I1_NoLostCharge ==
  ~( /\ finixState = "SUCCEEDED"
     /\ ~paymentRecorded
     /\ DeadEnd
     /\ ~Recoverable )

Inv_I3_CancelHonoured ==
  (txState = "CANCELLED" \/ (crashed = 1 /\ rowTx = "CANCELLED"))
    => (finixState # "SUCCEEDED" \/ paymentRecorded \/ Recoverable)

\* Wedge probe: a zombie is a stuck workflow whose modal shows 'waiting'
\* forever; acceptable only if no live money is at stake and a sweep will
\* eventually clear the row (post-fix this is still violated -> UX wedge).
Inv_NoZombieWithMoney ==
  ~( /\ txState = "ZOMBIE"
     /\ finixState = "SUCCEEDED"
     /\ ~paymentRecorded
     /\ ~Recoverable )


\* Reachability probes for the individual crash scenarios (gap numbering)
Probe_Gap8_InitiatingCrash ==
  ~( /\ txState = "ZOMBIE" \/ (txState = "ZOMBIE")
     /\ rowTx \in {"INITIATING", "CANCELLED"} /\ rowTid = NONE
     /\ finixState = "SUCCEEDED" /\ ~paymentRecorded /\ ~breadcrumb )
Probe_Gap9_RecordingCrash ==
  ~( /\ txState = "ZOMBIE" /\ rowTx = "RECORDING"
     /\ finixState = "SUCCEEDED" /\ ~paymentRecorded )
Probe_Gap9b_CancellingCrash ==
  ~( /\ txState = "ZOMBIE" /\ rowTx = "CANCELLING"
     /\ finixState = "SUCCEEDED" /\ ~paymentRecorded /\ ~breadcrumb )

=============================================================================
