--------------------------- MODULE FinixPOSStale ---------------------------
(***************************************************************************)
(* Poll-staleness extension (review point 2.2).                            *)
(*                                                                         *)
(* GET /transfers responses are no longer current-state snapshots: any     *)
(* read may return the transfer's PREVIOUS lifecycle state (one-step       *)
(* staleness — a read that raced the settlement).  Concretely, a transfer  *)
(* that is already SUCCEEDED/FAILED may still read as PENDING.             *)
(*                                                                         *)
(* Focus (per the review): a stale read racing the CANCEL ladder, and a    *)
(* stale read in the 422 duplicate-key handler.  The create ladder is      *)
(* compressed to attempt-1-delivered (the fuller ladder lives in           *)
(* FinixPOSEnv; staleness composes with it identically).                   *)
(*                                                                         *)
(* PATCHED gates the gap-fix semantics relevant here:                      *)
(*   - gap-6: verifyAndResolve probes cancel-response id THEN the polled   *)
(*     id (both probes can be stale — the fix does not defeat staleness);  *)
(*   - gap-5 sweep over CANCELLED rows with a transfer id (this is what    *)
(*     recovers the stale-defeated cancel);                                *)
(*   - cancel-NAP breadcrumb when no transferId is known.                  *)
(***************************************************************************)
EXTENDS FinixPOS

CONSTANTS PATCHED, STALE_READS

ORDER   == "O1"
TID     == "T1"
PID     == "P1"
REQ_AMT == 10

VARIABLES
  finixState,       \* actual transfer state at Finix
  finixCode,        \* actual failure code
  cancelDone,
  breadcrumb,
  paymentRecorded

envVars == <<finixState, finixCode, cancelDone, breadcrumb, paymentRecorded>>
vars    == <<txState, orderId, amountCents, transferId, declineCode,
             approvedAmountCents, paymentId,
             finixState, finixCode, cancelDone, breadcrumb, paymentRecorded>>

TypeOK ==
  /\ txState \in PosStates
  /\ finixState \in {NONE, "PENDING", "SUCCEEDED", "FAILED"}
  /\ finixCode \in {NONE, "ISSUER_DECLINE", "CANCELLATION_VIA_API"}
  /\ cancelDone \in BOOLEAN /\ breadcrumb \in BOOLEAN
  /\ paymentRecorded \in BOOLEAN

Init ==
  /\ PosInit
  /\ finixState = NONE /\ finixCode = NONE
  /\ cancelDone = FALSE /\ breadcrumb = FALSE /\ paymentRecorded = FALSE

-----------------------------------------------------------------------------
(* Compressed create: initiate -> transfer PENDING -> AWAITING_TAP.         *)

Initiate ==
  /\ txState = "IDLE"
  /\ DispatchInitiate(ORDER, REQ_AMT)
  /\ UNCHANGED envVars

CreateDelivered ==
  /\ txState = "INITIATING" /\ finixState = NONE
  /\ finixState' = "PENDING"
  /\ DispatchTransferCreated(TID)
  /\ UNCHANGED <<finixCode, cancelDone, breadcrumb, paymentRecorded>>

CustomerApprove ==
  /\ finixState = "PENDING"
  /\ finixState' = "SUCCEEDED"
  /\ UNCHANGED <<posVars, finixCode, cancelDone, breadcrumb, paymentRecorded>>

CustomerDecline ==
  /\ finixState = "PENDING"
  /\ finixState' = "FAILED" /\ finixCode' = "ISSUER_DECLINE"
  /\ UNCHANGED <<posVars, cancelDone, breadcrumb, paymentRecorded>>

-----------------------------------------------------------------------------
(* Poll: a FRESH read behaves as in FinixPOSEnv.  A STALE read of a settled *)
(* transfer returns PENDING -> no observable dispatch -> the poll loop      *)
(* simply ticks again (self-healing; modeled implicitly by fresh reads      *)
(* remaining enabled).  Staleness therefore matters only where a SINGLE     *)
(* read decides an irreversible step: the cancel ladder.                    *)

PollDeliverFresh ==
  /\ txState \in {"AWAITING_TAP", "CANCELLING"} /\ transferId # NONE
  /\ UNCHANGED envVars
  /\ CASE finixState = "SUCCEEDED" -> DispatchTapApproved(REQ_AMT)
       [] finixState = "FAILED"    -> DispatchTapDeclined(finixCode)
       [] OTHER -> FALSE

StaffCancelOrTimeout ==
  /\ txState = "AWAITING_TAP"
  /\ DispatchCancelPayment
  /\ UNCHANGED envVars

(* Cancel NAP, fresh reads: identical to FinixPOSEnv.CancelNap.             *)
CancelNapFresh ==
  /\ txState = "CANCELLING" /\ ~cancelDone
  /\ cancelDone' = TRUE
  /\ UNCHANGED breadcrumb
  /\ CASE finixState = "SUCCEEDED" ->
            /\ DispatchTapApproved(REQ_AMT)
            /\ UNCHANGED <<finixState, finixCode, paymentRecorded>>
       [] finixState = "PENDING" ->
            /\ finixState' = "FAILED" /\ finixCode' = "CANCELLATION_VIA_API"
            /\ DispatchCancelConfirmed
            /\ UNCHANGED paymentRecorded
       [] OTHER ->
            /\ DispatchCancelConfirmed
            /\ UNCHANGED <<finixState, finixCode, paymentRecorded>>

(* Cancel NAP defeated by staleness: the transfer is ALREADY SUCCEEDED, but *)
(* every read in the ladder returns the stale PENDING:                      *)
(*   - cancelTerminalSale hits a settled transfer: Finix rejects the cancel *)
(*     and echoes FAILED/CANCELLATION_VIA_API (the documented bug-2         *)
(*     companion behaviour, finix.ts lines 941-943);                        *)
(*   - verifyAndResolve's probe(s) — response id, then (PATCHED) the polled *)
(*     id — read stale PENDING;                                             *)
(*   - non-SUCCEEDED everywhere -> _cancelConfirmed.                        *)
(* One stale read suffices pre-fix; post-fix BOTH probes must be stale (a   *)
(* strictly smaller window, but still reachable — gap 6's fix reduces, not  *)
(* removes, the race).                                                      *)
CancelNapStale ==
  /\ STALE_READS
  /\ txState = "CANCELLING" /\ ~cancelDone
  /\ finixState = "SUCCEEDED"
  /\ cancelDone' = TRUE
  /\ DispatchCancelConfirmed
  /\ breadcrumb' = IF PATCHED /\ transferId = NONE THEN TRUE ELSE breadcrumb
  /\ UNCHANGED <<finixState, finixCode, paymentRecorded>>

(* 422-handler stale read (handleDuplicateKey422, lines 648-654): the       *)
(* existing transfer is SUCCEEDED but reads stale PENDING -> the code       *)
(* resumes awaiting-tap on it.  The poll then re-reads (fresh) and records. *)
(* Modeled by CreateDelivered422: enter AWAITING_TAP while already          *)
(* SUCCEEDED — the poll path recovers it, so this is benign; included to    *)
(* document why.                                                            *)
CreateDelivered422Stale ==
  /\ STALE_READS
  /\ txState = "INITIATING" /\ finixState = "SUCCEEDED"
  /\ DispatchTransferCreated(TID)
  /\ UNCHANGED envVars

RecordNap ==
  /\ txState = "RECORDING"
  /\ paymentRecorded' = TRUE
  /\ DispatchPaymentRecorded(PID)
  /\ UNCHANGED <<finixState, finixCode, cancelDone, breadcrumb>>

-----------------------------------------------------------------------------
(* Sweeps                                                                   *)

SweepBreadcrumb ==
  /\ breadcrumb /\ finixState = "SUCCEEDED" /\ ~paymentRecorded
  /\ paymentRecorded' = TRUE
  /\ UNCHANGED <<posVars, finixState, finixCode, cancelDone, breadcrumb>>

SweepCancelledCharged ==
  /\ PATCHED
  /\ txState = "CANCELLED" /\ transferId # NONE
  /\ finixState = "SUCCEEDED" /\ ~paymentRecorded
  /\ paymentRecorded' = TRUE
  /\ UNCHANGED <<posVars, finixState, finixCode, cancelDone, breadcrumb>>

-----------------------------------------------------------------------------

Next ==
  \/ Initiate \/ CreateDelivered
  \/ CustomerApprove \/ CustomerDecline
  \/ PollDeliverFresh \/ StaffCancelOrTimeout
  \/ CancelNapFresh \/ CancelNapStale \/ CreateDelivered422Stale
  \/ RecordNap
  \/ SweepBreadcrumb \/ SweepCancelledCharged

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------

Recoverable ==
  \/ breadcrumb
  \/ (PATCHED /\ txState = "CANCELLED" /\ transferId # NONE)

Inv_I1_NoLostCharge ==
  ~( /\ finixState = "SUCCEEDED"
     /\ txState \in {"DECLINED", "CANCELLED"}
     /\ ~paymentRecorded
     /\ ~Recoverable )

Inv_I3_CancelHonoured ==
  (txState = "CANCELLED")
    => (finixState # "SUCCEEDED" \/ paymentRecorded \/ Recoverable)

=============================================================================
