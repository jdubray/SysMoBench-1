------------------------- MODULE FinixPOSFixedV2Env -------------------------
(***************************************************************************)
(* FinixPOSFixed composed with the same environment as FinixPOSEnv, with   *)
(* the patch's env-visible behaviours added (preview:                      *)
(* terminal-payment-gapfix-preview.ts; hunk map: patches/GAP-FIXES.md):    *)
(*                                                                         *)
(*  Gap 1: DeliverCreateResp(PENDING) while CANCELLING/CANCELLED runs      *)
(*         handleCancelledMidCreate (device cancel -> honour a winning tap *)
(*         -> probe -> breadcrumb with transfer id if still live).         *)
(*         Belt-and-braces: the cancel NAP writes a breadcrumb by          *)
(*         idempotency key when CANCELLING is entered with no transferId   *)
(*         (preview 1225-1237) — modeled in CancelNap AND CancelNapBlind.  *)
(*  Gap 2: Deliver422FetchFail writes a breadcrumb carrying the existing   *)
(*         transfer id before declining (preview 695-707).                 *)
(*  Gap 4: Case-4 breadcrumb INSERT retried; still failing -> fail CLOSED  *)
(*         with TAP_DECLINED(VERIFICATION_UNAVAILABLE) (preview 626-651);  *)
(*         AWAITING_VERIFICATION is never entered without a breadcrumb.    *)
(*  Gap 5: SweepCancelledRecover — recoverChargedButCancelledPayments      *)
(*         probes CANCELLED ttx rows with a transfer id (preview 2082+).   *)
(*  Gap 6: blind cancel-confirm now requires BOTH probes failing; still    *)
(*         gated by CANCEL_BLIND_POSSIBLE, but the state it produces is    *)
(*         recoverable (transfer id on the CANCELLED row -> gap-5 sweep).  *)
(*  Gap 7: SweepResolve and RecordAndAdvance thread the transfer id        *)
(*         through TAP_APPROVED (DispatchTapApprovedTid).                  *)
(*  Gap 3: SurfacePartialNap — surfacePartialChargeForManualRefund on      *)
(*  PARTIAL_PAYMENT (owner amendment: the POS never calls the refund API;   *)
(*  refunds are manual via the Finix dashboard — access-control decision).  *)
(*         terminal states with a known transfer id (preview 963-1000).    *)
(*                                                                         *)
(* New state: dbFailed (the gated Case-4 INSERT double-failure — when the  *)
(* local DB is down, every DB-based recovery is void BY DEFINITION; see    *)
(* the Recoverable disjunct note), partialSurfaced.                           *)
(* Run TLC with -deadlock.                                                 *)
(***************************************************************************)
EXTENDS FinixPOSFixedV2

CONSTANTS EARLY_CANCEL, FETCH_CAN_FAIL, PARTIAL_POSSIBLE,
          DB_CAN_FAIL, CANCEL_BLIND_POSSIBLE

ORDER       == "O1"
TID         == "T1"
PID         == "P1"
REQ_AMT     == 10
PARTIAL_AMT == 5

VARIABLES
  finixState, finixCode, finixAmount,
  attempt, createdBy, cancelDone,
  breadcrumb, paymentRecorded,
  dbFailed,       \* Case-4 INSERT failed twice (gap-4 gate fired)
  partialSurfaced \* partial charge surfaced for MANUAL refund (payment_errors record)

envVars == <<finixState, finixCode, finixAmount, attempt, createdBy,
             cancelDone, breadcrumb, paymentRecorded, dbFailed, partialSurfaced>>

vars == <<txState, orderId, amountCents, transferId, declineCode,
          approvedAmountCents, paymentId,
          finixState, finixCode, finixAmount, attempt, createdBy,
          cancelDone, breadcrumb, paymentRecorded, dbFailed, partialSurfaced>>

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
  /\ dbFailed \in BOOLEAN
  /\ partialSurfaced \in BOOLEAN

Init ==
  /\ PosInit
  /\ finixState = NONE /\ finixCode = NONE /\ finixAmount = NUMNONE
  /\ attempt = 0 /\ createdBy = 0
  /\ cancelDone = FALSE /\ breadcrumb = FALSE /\ paymentRecorded = FALSE
  /\ dbFailed = FALSE /\ partialSurfaced = FALSE

-----------------------------------------------------------------------------
(* recordSucceededTransferAndAdvance, PATCH V2: the partial check runs      *)
(* BEFORE the DB write, so a recovery-path partial skips the row entirely   *)
(* and is declined+refunded (paymentRecorded stays FALSE on partial         *)
(* branches). Non-partial branches record as before. This closes the        *)
(* recovery-partial bookkeeping defect the post-fix re-check found.         *)
RecordAndAdvance ==
  IF txState = "INITIATING"
     THEN IF finixAmount < REQ_AMT
          THEN /\ txState' = "DECLINED" /\ declineCode' = "PARTIAL_PAYMENT"
               /\ transferId' = TID /\ approvedAmountCents' = finixAmount
               /\ paymentRecorded' = FALSE   \* v2: no row written for the partial
               /\ UNCHANGED <<orderId, amountCents, paymentId>>
          ELSE /\ txState' = "RECORDING" /\ transferId' = TID
               /\ approvedAmountCents' = finixAmount
               /\ paymentRecorded' = TRUE
               /\ UNCHANGED <<orderId, amountCents, declineCode, paymentId>>
     ELSE IF txState = "CANCELLING"
     THEN IF finixAmount < REQ_AMT
          THEN \* gap 3b: partial mid-cancel -> CANCELLED with stash, no row
               /\ txState' = "CANCELLED" /\ declineCode' = "PARTIAL_PAYMENT"
               /\ transferId' = IF transferId = NONE THEN TID ELSE transferId
               /\ approvedAmountCents' = finixAmount
               /\ paymentRecorded' = FALSE
               /\ UNCHANGED <<orderId, amountCents, paymentId>>
          ELSE /\ txState' = "RECORDING" /\ approvedAmountCents' = finixAmount
               /\ transferId' = IF transferId = NONE THEN TID ELSE transferId
               /\ paymentRecorded' = TRUE
               /\ UNCHANGED <<orderId, amountCents, declineCode, paymentId>>
     ELSE \* CANCELLED or terminal: dispatches are no-ops; nothing new recorded
          /\ paymentRecorded' = paymentRecorded
          /\ UNCHANGED posVars

-----------------------------------------------------------------------------
(* Create-sale ladder                                                       *)

NapCreateStart ==
  /\ txState = "INITIATING" /\ attempt = 0
  /\ attempt' = 1
  /\ UNCHANGED <<posVars, finixState, finixCode, finixAmount, createdBy,
                 cancelDone, breadcrumb, paymentRecorded, dbFailed, partialSurfaced>>

FinixCreates ==
  /\ attempt >= 1 /\ finixState = NONE
  /\ finixState' = "PENDING"
  /\ createdBy' = IF attempt <= 2 THEN attempt ELSE 0
  /\ UNCHANGED <<posVars, finixCode, finixAmount, attempt,
                 cancelDone, breadcrumb, paymentRecorded, dbFailed, partialSurfaced>>

(* Attempt N's own response arrives. Post-fix PENDING branch re-checks      *)
(* txState (preview 508-514): normal resume only from INITIATING.           *)
DeliverCreateRespNormal ==
  /\ attempt \in {1, 2} /\ finixState # NONE /\ createdBy = attempt
  /\ attempt' = 4
  /\ UNCHANGED <<finixState, finixCode, finixAmount, createdBy, cancelDone,
                 breadcrumb, dbFailed, partialSurfaced>>
  /\ CASE finixState = "PENDING" /\ txState = "INITIATING" ->
            /\ DispatchTransferCreated(TID)
            /\ UNCHANGED paymentRecorded
       [] finixState = "SUCCEEDED" ->
            RecordAndAdvance
       [] finixState \in {"FAILED", "CANCELED"} ->
            /\ DispatchTapDeclined("ISSUER_DECLINE")
            /\ UNCHANGED paymentRecorded
       [] OTHER -> FALSE   \* PENDING while cancelled: MidCreateCancel* owns it

(* Gap 1: PENDING response lands while CANCELLING/CANCELLED —               *)
(* handleCancelledMidCreate. Outcome (a): the device cancel reaches the     *)
(* still-pending transfer and kills it (dead, nothing to recover).          *)
MidCreateCancelKills ==
  /\ attempt \in {1, 2} /\ finixState = "PENDING" /\ createdBy = attempt
  /\ txState \in {"CANCELLING", "CANCELLED"}
  /\ attempt' = 4
  /\ finixState' = "FAILED" /\ finixCode' = "CANCELLATION_VIA_API"
  /\ UNCHANGED <<posVars, finixAmount, createdBy, cancelDone, breadcrumb,
                 paymentRecorded, dbFailed, partialSurfaced>>

(* Outcome (b): cancel throws / probe fails while the transfer stays        *)
(* PENDING -> breadcrumb with the transfer id; the customer may still tap.  *)
MidCreateCancelMisses ==
  /\ attempt \in {1, 2} /\ finixState = "PENDING" /\ createdBy = attempt
  /\ txState \in {"CANCELLING", "CANCELLED"}
  /\ attempt' = 4
  /\ breadcrumb' = TRUE
  /\ UNCHANGED <<posVars, finixState, finixCode, finixAmount, createdBy,
                 cancelDone, paymentRecorded, dbFailed, partialSurfaced>>

RespLost ==
  /\ attempt \in {1, 2}
  /\ attempt' = attempt + 1
  /\ UNCHANGED <<posVars, finixState, finixCode, finixAmount, createdBy,
                 cancelDone, breadcrumb, paymentRecorded, dbFailed, partialSurfaced>>

Deliver422FetchOK ==
  /\ attempt = 2 /\ finixState # NONE /\ createdBy = 1
  /\ attempt' = 4
  /\ UNCHANGED <<finixState, finixCode, finixAmount, createdBy, cancelDone,
                 breadcrumb, dbFailed, partialSurfaced>>
  /\ CASE finixState = "SUCCEEDED" ->
            RecordAndAdvance
       [] finixState = "PENDING" ->
            \* still an unguarded _transferCreated on the 422 path (no-op if
            \* cancelled meanwhile) — covered by the cancel NAP's
            \* breadcrumb-by-key, see Inv_I1.
            /\ DispatchTransferCreated(TID)
            /\ UNCHANGED paymentRecorded
       [] OTHER ->
            /\ DispatchTapDeclined(finixCode)
            /\ UNCHANGED paymentRecorded

(* Gap 2: fetch-failure now leaves a transfer-id breadcrumb before the      *)
(* conservative decline.                                                    *)
Deliver422FetchFail ==
  /\ FETCH_CAN_FAIL
  /\ attempt = 2 /\ finixState # NONE /\ createdBy = 1
  /\ attempt' = 4
  /\ breadcrumb' = TRUE
  /\ DispatchTapDeclined("CANCELLATION_VIA_API")
  /\ UNCHANGED <<finixState, finixCode, finixAmount, createdBy, cancelDone,
                 paymentRecorded, dbFailed, partialSurfaced>>

LastGaspResolve ==
  /\ attempt = 3
  /\ attempt' = 4
  /\ UNCHANGED <<finixAmount, createdBy, cancelDone, dbFailed, partialSurfaced>>
  /\ CASE finixState = "SUCCEEDED" ->
            /\ RecordAndAdvance
            /\ UNCHANGED <<finixState, finixCode, breadcrumb>>
       [] finixState = "PENDING" ->
            /\ finixState' = "FAILED" /\ finixCode' = "CANCELLATION_VIA_API"
            /\ breadcrumb' = TRUE
            /\ DispatchVerificationStarted
            /\ UNCHANGED paymentRecorded
       [] OTHER ->
            /\ breadcrumb' = TRUE
            /\ DispatchVerificationStarted
            /\ UNCHANGED <<finixState, finixCode, paymentRecorded>>

(* Gap 4: the INSERT double-failure now fails CLOSED — decline with         *)
(* VERIFICATION_UNAVAILABLE instead of entering AWAITING_VERIFICATION       *)
(* without a breadcrumb (preview 626-651).                                  *)
LastGaspResolveDbFail ==
  /\ DB_CAN_FAIL
  /\ attempt = 3
  /\ finixState # "SUCCEEDED"
  /\ attempt' = 4
  /\ dbFailed' = TRUE
  /\ DispatchTapDeclined("ISSUER_DECLINE")   \* VERIFICATION_UNAVAILABLE; code identity irrelevant
  /\ IF finixState = "PENDING"
     THEN finixState' = "FAILED" /\ finixCode' = "CANCELLATION_VIA_API"
     ELSE UNCHANGED <<finixState, finixCode>>
  /\ UNCHANGED <<finixAmount, createdBy, cancelDone, breadcrumb,
                 paymentRecorded, partialSurfaced>>

-----------------------------------------------------------------------------
(* Customer                                                                  *)

CustomerApprove ==
  /\ finixState = "PENDING"
  /\ finixState' = "SUCCEEDED" /\ finixAmount' = REQ_AMT
  /\ UNCHANGED <<posVars, finixCode, attempt, createdBy, cancelDone,
                 breadcrumb, paymentRecorded, dbFailed, partialSurfaced>>

CustomerApprovePartial ==
  /\ PARTIAL_POSSIBLE
  /\ finixState = "PENDING"
  /\ finixState' = "SUCCEEDED" /\ finixAmount' = PARTIAL_AMT
  /\ UNCHANGED <<posVars, finixCode, attempt, createdBy, cancelDone,
                 breadcrumb, paymentRecorded, dbFailed, partialSurfaced>>

CustomerDecline ==
  /\ finixState = "PENDING"
  /\ finixState' = "FAILED" /\ finixCode' = "ISSUER_DECLINE"
  /\ UNCHANGED <<posVars, finixAmount, attempt, createdBy, cancelDone,
                 breadcrumb, paymentRecorded, dbFailed, partialSurfaced>>

CustomerCancelOnDevice ==
  /\ finixState = "PENDING"
  /\ finixState' = "FAILED" /\ finixCode' = "CANCELLATION_VIA_DEVICE"
  /\ UNCHANGED <<posVars, finixAmount, attempt, createdBy, cancelDone,
                 breadcrumb, paymentRecorded, dbFailed, partialSurfaced>>

-----------------------------------------------------------------------------
(* Poll loop                                                                 *)

PollDeliver ==
  /\ txState \in {"AWAITING_TAP", "CANCELLING"} /\ transferId # NONE
  /\ UNCHANGED <<finixState, finixCode, finixAmount, attempt, createdBy,
                 cancelDone, breadcrumb, paymentRecorded, dbFailed, partialSurfaced>>
  /\ CASE finixState = "SUCCEEDED" -> DispatchTapApproved(finixAmount)
       [] finixState \in {"FAILED", "CANCELED"} -> DispatchTapDeclined(finixCode)
       [] OTHER -> FALSE

(* Staff cancel / timeout. Gap 4 adds the AWAITING_VERIFICATION exit.        *)
StaffCancelOrTimeout ==
  /\ \/ txState \in {"AWAITING_TAP", "AWAITING_VERIFICATION"}
     \/ (EARLY_CANCEL /\ txState = "INITIATING")
  /\ DispatchCancelPayment
  /\ UNCHANGED envVars

-----------------------------------------------------------------------------
(* Cancel NAP. Post-fix it writes the breadcrumb-by-key FIRST when no        *)
(* transferId is known (preview 1225-1237) — in both the normal and the     *)
(* blind variant (the write precedes verifyAndResolve).                      *)

CancelNap ==
  /\ txState = "CANCELLING" /\ ~cancelDone
  /\ cancelDone' = TRUE
  /\ breadcrumb' = (breadcrumb \/ transferId = NONE)
  /\ UNCHANGED <<finixAmount, attempt, createdBy, dbFailed, partialSurfaced>>
  /\ CASE finixState = "SUCCEEDED" ->
            /\ DispatchTapApprovedTid(finixAmount, TID)   \* gap 7: id threaded
            /\ UNCHANGED <<finixState, finixCode, paymentRecorded>>
       [] finixState = "PENDING" ->
            /\ finixState' = "FAILED" /\ finixCode' = "CANCELLATION_VIA_API"
            /\ DispatchCancelConfirmed
            /\ UNCHANGED paymentRecorded
       [] OTHER ->
            /\ DispatchCancelConfirmed
            /\ UNCHANGED <<finixState, finixCode, paymentRecorded>>

(* Gap 6 residual: BOTH probes fail while the transfer is SUCCEEDED. Still  *)
(* possible (network), but the resulting CANCELLED row carries whatever id  *)
(* the workflow knew, and the breadcrumb-by-key exists when it knew none —  *)
(* either way the state is sweep-recoverable (gap 5 / orphan sweep).        *)
CancelNapBlind ==
  /\ CANCEL_BLIND_POSSIBLE
  /\ txState = "CANCELLING" /\ ~cancelDone
  /\ finixState = "SUCCEEDED"
  /\ cancelDone' = TRUE
  /\ breadcrumb' = (breadcrumb \/ transferId = NONE)
  /\ DispatchCancelConfirmed
  /\ UNCHANGED <<finixState, finixCode, finixAmount, attempt, createdBy,
                 paymentRecorded, dbFailed, partialSurfaced>>

-----------------------------------------------------------------------------
(* Record NAP                                                                *)

RecordNap ==
  /\ txState = "RECORDING"
  /\ paymentRecorded' = TRUE
  /\ DispatchPaymentRecorded(PID)
  /\ UNCHANGED <<finixState, finixCode, finixAmount, attempt, createdBy,
                 cancelDone, breadcrumb, dbFailed, partialSurfaced>>

-----------------------------------------------------------------------------
(* Sweeps                                                                    *)

(* Orphan sweep resolving AWAITING_VERIFICATION — gap 7: the approved        *)
(* resolution now threads the transfer id.                                   *)
SweepResolve ==
  /\ txState = "AWAITING_VERIFICATION" /\ breadcrumb
  /\ UNCHANGED <<finixState, finixCode, finixAmount, attempt, createdBy,
                 cancelDone, breadcrumb, paymentRecorded, dbFailed, partialSurfaced>>
  /\ CASE finixState = "SUCCEEDED" -> DispatchTapApprovedTid(finixAmount, TID)
       [] finixState \in {"FAILED", "CANCELED"} -> DispatchTapDeclined(finixCode)
       [] finixState = NONE -> DispatchTapDeclined("ISSUER_DECLINE")
       [] OTHER -> FALSE

(* Gap 5: recoverChargedButCancelledPayments — CANCELLED ttx rows with a    *)
(* transfer id and a SUCCEEDED probe get their payments row written.        *)
(* PATCH V2: skip rows declined as PARTIAL_PAYMENT. TLC found the CANCELLED  *)
(* sweep would otherwise re-record a partial charge that the partial guard   *)
(* deliberately rejected (and that render-side refundPartialCharge already   *)
(* reversed) — a composition of the two v1 recovery fixes.                   *)
SweepCancelledRecover ==
  /\ txState = "CANCELLED" /\ transferId # NONE
  /\ declineCode # "PARTIAL_PAYMENT"
  /\ finixState = "SUCCEEDED" /\ ~paymentRecorded
  /\ paymentRecorded' = TRUE
  /\ UNCHANGED <<posVars, finixState, finixCode, finixAmount, attempt,
                 createdBy, cancelDone, breadcrumb, dbFailed, partialSurfaced>>

(* Breadcrumb-driven recovery of a terminal-state charge (the orphan sweep  *)
(* probes idempotency-key rows against Finix and writes via the DB path     *)
(* even after the workflow declined and was pruned — GAP-FIXES gap 2).      *)
SweepBreadcrumbRecover ==
  /\ txState \in {"DECLINED", "CANCELLED"} /\ breadcrumb
  \* v2: the reconcile sweep's partial guard (sweepOrphanedTerminalSales:
  \* status.amount < row.amount_cents -> decline PARTIAL_PAYMENT + refund,
  \* never record). Faithful to the patched reconcile.ts (reach-tested by
  \* reconcile-partial-guard-check.ts) - no longer an over-approximation
  \* workaround.
  /\ declineCode # "PARTIAL_PAYMENT"
  /\ finixState = "SUCCEEDED" /\ ~paymentRecorded
  /\ paymentRecorded' = TRUE
  /\ UNCHANGED <<posVars, finixState, finixCode, finixAmount, attempt,
                 createdBy, cancelDone, breadcrumb, dbFailed, partialSurfaced>>

(* Gap 3 (owner amendment): the render surfaces the settled partial for      *)
(* MANUAL refund (payment_errors + audit event with transfer id + amount);   *)
(* the POS deliberately never calls the refund API — refund authority stays  *)
(* behind the Finix dashboard's login/role restrictions. The surfaced record *)
(* is what makes the money recoverable (staff action), hence the Recoverable *)
(* disjunct. Fires for the no-transfer-id case too (message says locate      *)
(* manually), but the Recoverable disjunct keeps the tid requirement — a     *)
(* surfaced record without a tid is a weaker guarantee, matching the code.   *)
SurfacePartialNap ==
  /\ txState \in {"DECLINED", "CANCELLED"}
  /\ declineCode = "PARTIAL_PAYMENT" /\ transferId # NONE
  /\ ~partialSurfaced
  /\ partialSurfaced' = TRUE
  /\ UNCHANGED <<posVars, finixState, finixCode, finixAmount, attempt,
                 createdBy, cancelDone, breadcrumb, paymentRecorded, dbFailed>>

-----------------------------------------------------------------------------

Next ==
  \/ NapCreateStart
  \/ FinixCreates
  \/ DeliverCreateRespNormal
  \/ MidCreateCancelKills
  \/ MidCreateCancelMisses
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
  \/ SweepCancelledRecover
  \/ SweepBreadcrumbRecover
  \/ SurfacePartialNap
  \/ (txState = "IDLE" /\ DispatchInitiate(ORDER, REQ_AMT) /\ UNCHANGED envVars)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Invariants — post-fix formulation.                                        *)
(*                                                                           *)
(* "Recoverable" = the state is visible to at least one recovery mechanism:  *)
(*   - a payments row already exists;                                        *)
(*   - a pending_terminal_sales breadcrumb exists (orphan sweep);            *)
(*   - the CANCELLED ttx row carries a transfer id (gap-5 sweep);            *)
(*   - a PARTIAL_PAYMENT rejection with a known id (render refund +          *)
(*     reconcile_gap logging);                                               *)
(*   - dbFailed: the local DB is down — every DB-based recovery is void by   *)
(*     definition. This is the DOCUMENTED RESIDUAL of the gap-4 fail-closed  *)
(*     fix: if additionally a network-lost create materializes later and the *)
(*     customer taps it, the charge is invisible. Inherent to a dead local   *)
(*     DB; reported, not hidden. Remove this disjunct to see the trace.      *)
Recoverable ==
  \/ paymentRecorded
  \/ breadcrumb
  \/ partialSurfaced
  \/ (txState = "CANCELLED" /\ transferId # NONE)
  \/ (declineCode = "PARTIAL_PAYMENT" /\ transferId # NONE)
  \/ dbFailed

Inv_I1_NoLostCharge ==
  ~( /\ finixState = "SUCCEEDED"
     /\ txState \in {"DECLINED", "CANCELLED"}
     /\ ~Recoverable )

Inv_I3_CancelHonoured ==
  (txState = "CANCELLED") => (finixState # "SUCCEEDED" \/ Recoverable)

Inv_VerificationHasBreadcrumb ==
  (txState = "AWAITING_VERIFICATION") => breadcrumb

(* Gap 7: a RECORDING/COMPLETED workflow must know its transfer id, else    *)
(* the payments row is written with finix_transfer_id = NULL and the        *)
(* ON CONFLICT double-record guard is dead. (FAILS on the pre-fix model.)   *)
Inv_RecordingHasTransferId ==
  (txState \in {"RECORDING", "COMPLETED"}) => transferId # NONE

Inv_NoPartialRecorded ==
  paymentRecorded =>
    (approvedAmountCents = NUMNONE \/ approvedAmountCents >= REQ_AMT)


(* Strict variant WITHOUT the dead-DB exemption — used only to characterize *)
(* the documented gap-4 residual precisely (fixed_bug4_strict.cfg).         *)
RecoverableNoDbExemption ==
  \/ paymentRecorded
  \/ breadcrumb
  \/ partialSurfaced
  \/ (txState = "CANCELLED" /\ transferId # NONE)
  \/ (declineCode = "PARTIAL_PAYMENT" /\ transferId # NONE)

Inv_I1_Strict ==
  ~( /\ finixState = "SUCCEEDED"
     /\ txState \in {"DECLINED", "CANCELLED"}
     /\ ~RecoverableNoDbExemption )

=============================================================================
