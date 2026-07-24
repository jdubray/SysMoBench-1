--------------------------- MODULE FinixPOSEnv ---------------------------
(***************************************************************************)
(* POS (FinixPOS.tla) composed with an explicit environment:               *)
(*   - the Finix transfer lifecycle (single order, single idempotency key) *)
(*   - the async create-sale ladder    (runCreateSale, lines 442-625)      *)
(*   - the 422 duplicate-key handler   (handleDuplicateKey422, 630-674)    *)
(*   - the poll loop                   (pollTick, 345-416)                 *)
(*   - the cancel NAP + verify ladder  (lines 1011-1070)                   *)
(*   - the record NAP                  (lines 1077-1100)                   *)
(*   - customer / staff / orphan-sweep actions                             *)
(*                                                                         *)
(* One payment attempt (no EXIT_FLOW re-initiation): the invariants are    *)
(* judged at terminal states. Run TLC with -deadlock.                      *)
(*                                                                         *)
(* Failure-mode gates (CONSTANTS, all BOOLEAN) so each candidate bug from  *)
(* EXTRACTION.md sec.8 is probed by its own cfg:                           *)
(*   EARLY_CANCEL          staff may cancel while INITIATING (bug 1 race)  *)
(*   FETCH_CAN_FAIL        422-path status fetch may fail   (bug 2)        *)
(*   PARTIAL_POSSIBLE      Finix may approve amt < requested (bug 3)       *)
(*   DB_CAN_FAIL           pending_terminal_sales INSERT may fail (bug 4,  *)
(*                         code lines 604-617: dispatches anyway)          *)
(*   CANCEL_BLIND_POSSIBLE cancel response AND probe both miss a           *)
(*                         SUCCEEDED transfer (bug 5, lines 1036-1040:     *)
(*                         probe catch -> _cancelConfirmed "conservative") *)
(***************************************************************************)
EXTENDS FinixPOS

CONSTANTS EARLY_CANCEL, FETCH_CAN_FAIL, PARTIAL_POSSIBLE,
          DB_CAN_FAIL, CANCEL_BLIND_POSSIBLE

ORDER      == "O1"
TID        == "T1"
PID        == "P1"
REQ_AMT    == 10
PARTIAL_AMT == 5

VARIABLES
  finixState,       \* transfer state at Finix: NONE PENDING SUCCEEDED FAILED CANCELED
  finixCode,        \* failure_code at Finix
  finixAmount,      \* amount Finix approved (set on SUCCEEDED)
  attempt,          \* create ladder phase: 0 idle, 1/2 request in flight,
                    \* 3 last-gasp cancel probe, 4 ladder done
  createdBy,        \* which attempt's request created the transfer (0 = n/a)
  cancelDone,       \* cancel NAP fired for this CANCELLING entry (_cancelInFlight)
  breadcrumb,       \* pending_terminal_sales row exists (idempotency_key)
  paymentRecorded   \* a payments row exists for this transfer

envVars == <<finixState, finixCode, finixAmount, attempt, createdBy,
             cancelDone, breadcrumb, paymentRecorded>>

vars == <<txState, orderId, amountCents, transferId, declineCode,
          approvedAmountCents, paymentId,
          finixState, finixCode, finixAmount, attempt, createdBy,
          cancelDone, breadcrumb, paymentRecorded>>

TypeOK ==
  /\ txState \in PosStates
  /\ finixState \in {NONE, "PENDING", "SUCCEEDED", "FAILED", "CANCELED"}
  /\ finixCode \in {NONE, "ISSUER_DECLINE", "CANCELLATION_VIA_DEVICE",
                    "CANCELLATION_VIA_API"}
  /\ finixAmount \in {NUMNONE, REQ_AMT, PARTIAL_AMT}
  /\ attempt \in 0..4
  /\ createdBy \in 0..2
  /\ cancelDone \in BOOLEAN
  /\ breadcrumb \in BOOLEAN
  /\ paymentRecorded \in BOOLEAN

Init ==
  /\ PosInit
  /\ finixState = NONE /\ finixCode = NONE /\ finixAmount = NUMNONE
  /\ attempt = 0 /\ createdBy = 0
  /\ cancelDone = FALSE /\ breadcrumb = FALSE /\ paymentRecorded = FALSE

-----------------------------------------------------------------------------
(* recordSucceededTransferAndAdvance (686-733): direct DB write (payments   *)
(* row) THEN dispatch TRANSFER_CREATED + TAP_APPROVED. The DB write happens *)
(* regardless of what the FSM then accepts. Modeled as one atomic step:    *)
(* the two dispatches applied sequentially to the POS state.               *)
RecordAndAdvance ==
  /\ paymentRecorded' = TRUE
  /\ IF txState = "INITIATING"
     THEN \* TRANSFER_CREATED accepted -> AWAITING_TAP; then TAP_APPROVED
          \* (full amount context: finixAmount >= REQ_AMT can be partial too,
          \*  the partial rewrite applies in AWAITING_TAP)
          IF finixAmount < REQ_AMT
          THEN /\ txState' = "DECLINED" /\ declineCode' = "PARTIAL_PAYMENT"
               /\ transferId' = TID
               /\ UNCHANGED <<orderId, amountCents, approvedAmountCents, paymentId>>
          ELSE /\ txState' = "RECORDING" /\ transferId' = TID
               /\ approvedAmountCents' = finixAmount
               /\ UNCHANGED <<orderId, amountCents, declineCode, paymentId>>
     ELSE IF txState = "CANCELLING"
     THEN \* TRANSFER_CREATED rejected (no-op); TAP_APPROVED from CANCELLING
          \* -> RECORDING (partial guard does NOT apply outside AWAITING_TAP)
          /\ txState' = "RECORDING" /\ approvedAmountCents' = finixAmount
          /\ UNCHANGED <<orderId, amountCents, transferId, declineCode, paymentId>>
     ELSE \* terminal or other: both dispatches are no-ops, but the DB row
          \* was already written (the code wrote it before dispatching).
          UNCHANGED posVars

-----------------------------------------------------------------------------
(* Create-sale ladder                                                       *)

\* createSale NAP fires on entering INITIATING (lines 980-987)
NapCreateStart ==
  /\ txState = "INITIATING" /\ attempt = 0
  /\ attempt' = 1
  /\ UNCHANGED <<posVars, finixState, finixCode, finixAmount, createdBy,
                 cancelDone, breadcrumb, paymentRecorded>>

\* Finix processes an in-flight (or lost-but-delivered-late) request.
\* A request "lost" from the POS's perspective (RespLost) may still be
\* processed by Finix afterwards — that is the whole idempotency ambiguity.
FinixCreates ==
  /\ attempt >= 1 /\ finixState = NONE
  /\ finixState' = "PENDING"
  /\ createdBy' = IF attempt <= 2 THEN attempt ELSE 0
  /\ UNCHANGED <<posVars, finixCode, finixAmount, attempt,
                 cancelDone, breadcrumb, paymentRecorded>>

\* The POS receives attempt N's own response (created by the same attempt):
\* runCreateSale lines 458-501, response reflects the transfer state.
DeliverCreateResp ==
  /\ attempt \in {1, 2} /\ finixState # NONE /\ createdBy = attempt
  /\ attempt' = 4
  /\ UNCHANGED <<finixState, finixCode, finixAmount, createdBy, cancelDone, breadcrumb>>
  /\ CASE finixState = "PENDING" ->
            /\ DispatchTransferCreated(TID)             \* line 500
            /\ UNCHANGED paymentRecorded
       [] finixState = "SUCCEEDED" ->
            RecordAndAdvance                            \* lines 461-489
       [] OTHER ->                                      \* FAILED / CANCELED
            /\ DispatchTapDeclined("ISSUER_DECLINE")    \* IMMEDIATE_FAILURE,
            /\ UNCHANGED paymentRecorded                \* lines 491-497

\* Attempt N's response is lost (network error / HTTP timeout):
\* attempt 1 -> retry with SAME key (line 513-521); attempt 2 -> last gasp.
RespLost ==
  /\ attempt \in {1, 2}
  /\ attempt' = attempt + 1
  /\ UNCHANGED <<posVars, finixState, finixCode, finixAmount, createdBy,
                 cancelDone, breadcrumb, paymentRecorded>>

\* Attempt 2 hits the 422 duplicate-idempotency-key path because attempt 1's
\* request created the transfer (handleDuplicateKey422, lines 630-674).
Deliver422FetchOK ==
  /\ attempt = 2 /\ finixState # NONE /\ createdBy = 1
  /\ attempt' = 4
  /\ UNCHANGED <<finixState, finixCode, finixAmount, createdBy, cancelDone, breadcrumb>>
  /\ CASE finixState = "SUCCEEDED" ->
            RecordAndAdvance                            \* lines 633-647
       [] finixState = "PENDING" ->
            /\ DispatchTransferCreated(TID)             \* lines 648-654
            /\ UNCHANGED paymentRecorded
       [] OTHER ->
            /\ DispatchTapDeclined(finixCode)           \* lines 655-659
            /\ UNCHANGED paymentRecorded

\* Same 422, but the status fetch of the existing transfer FAILS: the code
\* declines conservatively and writes NO breadcrumb (lines 660-673).
Deliver422FetchFail ==
  /\ FETCH_CAN_FAIL
  /\ attempt = 2 /\ finixState # NONE /\ createdBy = 1
  /\ attempt' = 4
  /\ DispatchTapDeclined("CANCELLATION_VIA_API")
  /\ UNCHANGED <<finixState, finixCode, finixAmount, createdBy, cancelDone,
                 breadcrumb, paymentRecorded>>

\* Both attempts lost -> last-gasp device cancel probe (lines 525-597), then
\* Case 4: breadcrumb + VERIFICATION_STARTED (lines 599-625).
LastGaspResolve ==
  /\ attempt = 3
  /\ attempt' = 4
  /\ UNCHANGED <<finixAmount, createdBy, cancelDone>>
  /\ CASE finixState = "SUCCEEDED" ->
            \* customer tapped during the network window (lines 531-569)
            /\ RecordAndAdvance
            /\ UNCHANGED <<finixState, finixCode, breadcrumb>>
       [] finixState = "PENDING" ->
            \* device cancel aborts the pending transfer; cancel returns
            \* FAILED/CANCELLATION_VIA_API -> falls through to Case 4
            /\ finixState' = "FAILED" /\ finixCode' = "CANCELLATION_VIA_API"
            /\ breadcrumb' = TRUE
            /\ DispatchVerificationStarted
            /\ UNCHANGED paymentRecorded
       [] OTHER ->
            \* nothing at Finix (or already FAILED/CANCELED): Case 4
            /\ breadcrumb' = TRUE
            /\ DispatchVerificationStarted
            /\ UNCHANGED <<finixState, finixCode, paymentRecorded>>

\* Case 4 with the pending_terminal_sales INSERT failing: the code logs and
\* STILL dispatches VERIFICATION_STARTED (lines 612-617, 624) — the workflow
\* enters AWAITING_VERIFICATION with no breadcrumb for the sweep to find.
LastGaspResolveDbFail ==
  /\ DB_CAN_FAIL
  /\ attempt = 3
  /\ finixState # "SUCCEEDED"
  /\ attempt' = 4
  /\ DispatchVerificationStarted
  /\ IF finixState = "PENDING"
     THEN finixState' = "FAILED" /\ finixCode' = "CANCELLATION_VIA_API"
     ELSE UNCHANGED <<finixState, finixCode>>
  /\ UNCHANGED <<finixAmount, createdBy, cancelDone, breadcrumb, paymentRecorded>>

-----------------------------------------------------------------------------
(* Customer at the terminal (only while the transfer is PENDING)            *)

CustomerApprove ==
  /\ finixState = "PENDING"
  /\ finixState' = "SUCCEEDED" /\ finixAmount' = REQ_AMT
  /\ UNCHANGED <<posVars, finixCode, attempt, createdBy, cancelDone,
                 breadcrumb, paymentRecorded>>

CustomerApprovePartial ==
  /\ PARTIAL_POSSIBLE
  /\ finixState = "PENDING"
  /\ finixState' = "SUCCEEDED" /\ finixAmount' = PARTIAL_AMT
  /\ UNCHANGED <<posVars, finixCode, attempt, createdBy, cancelDone,
                 breadcrumb, paymentRecorded>>

CustomerDecline ==
  /\ finixState = "PENDING"
  /\ finixState' = "FAILED" /\ finixCode' = "ISSUER_DECLINE"
  /\ UNCHANGED <<posVars, finixAmount, attempt, createdBy, cancelDone,
                 breadcrumb, paymentRecorded>>

CustomerCancelOnDevice ==
  /\ finixState = "PENDING"
  /\ finixState' = "FAILED" /\ finixCode' = "CANCELLATION_VIA_DEVICE"
  /\ UNCHANGED <<posVars, finixAmount, attempt, createdBy, cancelDone,
                 breadcrumb, paymentRecorded>>

-----------------------------------------------------------------------------
(* Poll loop: pollTick (345-416) runs in AWAITING_TAP and CANCELLING and    *)
(* only once a transferId is known.                                         *)

PollDeliver ==
  /\ txState \in {"AWAITING_TAP", "CANCELLING"} /\ transferId # NONE
  /\ UNCHANGED <<finixState, finixCode, finixAmount, attempt, createdBy,
                 cancelDone, breadcrumb, paymentRecorded>>
  /\ CASE finixState = "SUCCEEDED" -> DispatchTapApproved(finixAmount)  \* 382-399
       [] finixState \in {"FAILED", "CANCELED"} ->
            DispatchTapDeclined(finixCode)                              \* 400-406
       [] OTHER -> FALSE   \* PENDING/NONE: nothing observable

(* Staff cancel (cancelTerminalPayment) or the 180 s timeout (lines 352-376):*)
(* both dispatch CANCEL_PAYMENT. From INITIATING only if EARLY_CANCEL.       *)
StaffCancelOrTimeout ==
  /\ \/ txState = "AWAITING_TAP"
     \/ (EARLY_CANCEL /\ txState = "INITIATING")
  /\ DispatchCancelPayment
  /\ UNCHANGED envVars

-----------------------------------------------------------------------------
(* Cancel NAP (1011-1070): fires once per CANCELLING entry.                 *)

CancelNap ==
  /\ txState = "CANCELLING" /\ ~cancelDone
  /\ cancelDone' = TRUE
  /\ UNCHANGED <<finixAmount, attempt, createdBy, breadcrumb>>
  /\ CASE finixState = "SUCCEEDED" ->
            \* tap beat cancel: response (1045-1055) or probe (1023-1035)
            \* reports SUCCEEDED -> honour the charge
            /\ DispatchTapApproved(finixAmount)
            /\ UNCHANGED <<finixState, finixCode, paymentRecorded>>
       [] finixState = "PENDING" ->
            \* device cancel aborts the prompt; Finix marks the transfer
            \* FAILED/CANCELLATION_VIA_API; verifyAndResolve confirms
            /\ finixState' = "FAILED" /\ finixCode' = "CANCELLATION_VIA_API"
            /\ DispatchCancelConfirmed
            /\ UNCHANGED paymentRecorded
       [] OTHER ->
            \* nothing at Finix yet (NONE) or already FAILED/CANCELED:
            \* probe finds nothing to honour -> CANCEL_CONFIRMED (1040)
            /\ DispatchCancelConfirmed
            /\ UNCHANGED <<finixState, finixCode, paymentRecorded>>

\* The acknowledged-conservative double-failure path (1036-1040, 1061-1066):
\* the cancel call throws AND the verification probe fails while the transfer
\* is actually SUCCEEDED -> _cancelConfirmed despite a real charge.
CancelNapBlind ==
  /\ CANCEL_BLIND_POSSIBLE
  /\ txState = "CANCELLING" /\ ~cancelDone
  /\ finixState = "SUCCEEDED"
  /\ cancelDone' = TRUE
  /\ DispatchCancelConfirmed
  /\ UNCHANGED <<finixState, finixCode, finixAmount, attempt, createdBy,
                 breadcrumb, paymentRecorded>>

-----------------------------------------------------------------------------
(* Record NAP (1077-1100): RECORDING -> recordTerminalPayment -> COMPLETED. *)
(* Idempotent (ON CONFLICT DO NOTHING + already-paid check, 1896-1909,      *)
(* 2017-2028): recording when a row exists returns the existing id.         *)

RecordNap ==
  /\ txState = "RECORDING"
  /\ paymentRecorded' = TRUE
  /\ DispatchPaymentRecorded(PID)
  /\ UNCHANGED <<finixState, finixCode, finixAmount, attempt, createdBy,
                 cancelDone, breadcrumb>>

-----------------------------------------------------------------------------
(* Orphan sweep (reconcile.ts sweepOrphanedTerminalSales -> handle          *)
(* .resolveVerification, lines 1385-1408): resolves AWAITING_VERIFICATION   *)
(* by querying Finix by idempotency_id — possible ONLY via the breadcrumb.  *)

SweepResolve ==
  /\ txState = "AWAITING_VERIFICATION" /\ breadcrumb
  /\ UNCHANGED <<finixState, finixCode, finixAmount, attempt, createdBy,
                 cancelDone, breadcrumb, paymentRecorded>>
  /\ CASE finixState = "SUCCEEDED" -> DispatchTapApproved(finixAmount)
       [] finixState \in {"FAILED", "CANCELED"} -> DispatchTapDeclined(finixCode)
       [] finixState = NONE -> DispatchTapDeclined("ISSUER_DECLINE")
            \* VERIFICATION_FAILED in the code; code identity irrelevant here
       [] OTHER -> FALSE    \* PENDING: sweep waits

-----------------------------------------------------------------------------

Next ==
  \/ NapCreateStart
  \/ FinixCreates
  \/ DeliverCreateResp
  \/ RespLost
  \/ Deliver422FetchOK
  \/ Deliver422FetchFail
  \/ LastGaspResolve
  \/ LastGaspResolveDbFail
  \/ CustomerApprove
  \/ CustomerApprovePartial
  \/ CustomerDecline
  \/ CustomerCancelOnDevice
  \/ PollDeliver
  \/ StaffCancelOrTimeout
  \/ CancelNap
  \/ CancelNapBlind
  \/ RecordNap
  \/ SweepResolve
  \/ (txState = "IDLE" /\ DispatchInitiate(ORDER, REQ_AMT) /\ UNCHANGED envVars)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Invariants (EXTRACTION.md sec.7)                                         *)

\* I1 No lost charge: a SUCCEEDED transfer with the POS in a terminal
\* failure state must leave either a payments row or a breadcrumb some
\* sweep can recover from. (COMPLETED-without-payment is recoverable via
\* recoverOrphanedCompletedPayments and is not a violation.)
Inv_I1_NoLostCharge ==
  ~( /\ finixState = "SUCCEEDED"
     /\ txState \in {"DECLINED", "CANCELLED"}
     /\ ~paymentRecorded
     /\ ~breadcrumb )

\* I3 Cancel honoured: CANCELLED implies the charge did not go through
\* (or was recorded anyway by a recovery path).
Inv_I3_CancelHonoured ==
  (txState = "CANCELLED") => (finixState # "SUCCEEDED" \/ paymentRecorded)

\* Bug-4 probe: AWAITING_VERIFICATION must always carry its breadcrumb,
\* otherwise the orphan sweep can never resolve it (stuck forever).
Inv_VerificationHasBreadcrumb ==
  (txState = "AWAITING_VERIFICATION") => breadcrumb

\* Partial-approval bookkeeping (I2-adjacent): any recorded payment matches
\* at least the requested amount (NUMNONE = recovery wrote the row directly
\* before the model saw an approval amount — exempt).
Inv_NoPartialRecorded ==
  paymentRecorded =>
    (approvedAmountCents = NUMNONE \/ approvedAmountCents >= REQ_AMT)

=============================================================================
