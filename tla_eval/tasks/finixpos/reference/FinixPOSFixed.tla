-------------------------- MODULE FinixPOSFixed --------------------------
(***************************************************************************)
(* Post-fix dispatch relation: FinixPOS.tla updated to the semantics of    *)
(* patches/terminal-payment-gap-fixes.patch (preview:                      *)
(* src/workflows/terminal-payment-gapfix-preview.ts). Deltas vs FinixPOS:  *)
(*                                                                         *)
(*  - Gap 3b: the partial-approval rewrite fires in AWAITING_TAP,          *)
(*    CANCELLING and AWAITING_VERIFICATION (preview lines 1044-1067),      *)
(*    ordered before the CANCELLING+TAP_DECLINED->CANCEL_DECLINED rewrite, *)
(*    so a partial mid-cancel lands in CANCELLED with the code preserved.  *)
(*  - Gap 3: PARTIAL_PAYMENT rejections stash the settled amount and the   *)
(*    transfer id on the model (preview lines 1129-1142) so the render     *)
(*    refund can reverse the charge.                                       *)
(*  - Gap 4: AWAITING_VERIFICATION accepts CANCEL_PAYMENT (preview 244).   *)
(*  - Gap 7: TAP_APPROVED proposals may carry a transferId (recovery       *)
(*    paths); the acceptor never clobbers an existing id (preview 1124).   *)
(***************************************************************************)
EXTENDS Integers

NONE    == "none"
NUMNONE == -1

VARIABLES
  txState, orderId, amountCents, transferId, declineCode,
  approvedAmountCents, paymentId

posVars == <<txState, orderId, amountCents, transferId, declineCode,
             approvedAmountCents, paymentId>>

PosStates == {"IDLE", "INITIATING", "AWAITING_TAP", "AWAITING_VERIFICATION",
              "RECORDING", "COMPLETED", "DECLINED", "CANCELLING", "CANCELLED"}

PosInit ==
  /\ txState             = "IDLE"
  /\ orderId             = NONE
  /\ amountCents         = NUMNONE
  /\ transferId          = NONE
  /\ declineCode         = NONE
  /\ approvedAmountCents = NUMNONE
  /\ paymentId           = NONE

PosNoOp == UNCHANGED posVars

DispatchInitiate(oid, amt) ==
  IF txState = "IDLE"
  THEN /\ txState'             = "INITIATING"
       /\ orderId'             = oid
       /\ amountCents'         = amt
       /\ transferId'          = NONE
       /\ declineCode'         = NONE
       /\ approvedAmountCents' = NUMNONE
       /\ paymentId'           = NONE
  ELSE PosNoOp

DispatchTransferCreated(tid) ==
  IF txState = "INITIATING"
  THEN /\ txState'    = "AWAITING_TAP"
       /\ transferId' = tid
       /\ UNCHANGED <<orderId, amountCents, declineCode,
                      approvedAmountCents, paymentId>>
  ELSE PosNoOp

DispatchVerificationStarted ==
  IF txState = "INITIATING"
  THEN /\ txState' = "AWAITING_VERIFICATION"
       /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                      approvedAmountCents, paymentId>>
  ELSE PosNoOp

(* TAP_APPROVED(amt) carrying an optional transfer id (NONE = poll path).   *)
(* Partial rewrite in all three approvable states (gap 3b); stash of amount *)
(* + id on the rejection (gap 3); id threaded on acceptance (gap 7).        *)
KeepOrTake(tid) == IF transferId = NONE THEN tid ELSE transferId

DispatchTapApprovedTid(amt, tid) ==
  IF txState \in {"AWAITING_TAP", "CANCELLING", "AWAITING_VERIFICATION"}
     /\ amt < amountCents
  THEN /\ txState'             = IF txState = "CANCELLING"
                                 THEN "CANCELLED" ELSE "DECLINED"
       /\ declineCode'         = "PARTIAL_PAYMENT"
       /\ approvedAmountCents' = amt                    \* gap-3 stash
       /\ transferId'          = KeepOrTake(tid)
       /\ UNCHANGED <<orderId, amountCents, paymentId>>
  ELSE IF txState \in {"AWAITING_TAP", "AWAITING_VERIFICATION", "CANCELLING"}
  THEN /\ txState'             = "RECORDING"
       /\ approvedAmountCents' = amt
       /\ transferId'          = KeepOrTake(tid)        \* gap 7
       /\ UNCHANGED <<orderId, amountCents, declineCode, paymentId>>
  ELSE PosNoOp

DispatchTapApproved(amt) == DispatchTapApprovedTid(amt, NONE)

DispatchTapDeclined(code) ==
  IF txState = "CANCELLING"
  THEN /\ txState'     = "CANCELLED"
       /\ declineCode' = code
       /\ UNCHANGED <<orderId, amountCents, transferId,
                      approvedAmountCents, paymentId>>
  ELSE IF txState \in {"INITIATING", "AWAITING_TAP", "AWAITING_VERIFICATION"}
  THEN /\ txState'     = "DECLINED"
       /\ declineCode' = code
       /\ UNCHANGED <<orderId, amountCents, transferId,
                      approvedAmountCents, paymentId>>
  ELSE PosNoOp

DispatchPaymentRecorded(pid) ==
  IF txState = "RECORDING"
  THEN /\ txState'   = "COMPLETED"
       /\ paymentId' = pid
       /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                      approvedAmountCents>>
  ELSE PosNoOp

(* Gap 4: CANCEL_PAYMENT now also allowed from AWAITING_VERIFICATION.       *)
DispatchCancelPayment ==
  IF txState \in {"INITIATING", "AWAITING_TAP", "AWAITING_VERIFICATION"}
  THEN /\ txState' = "CANCELLING"
       /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                      approvedAmountCents, paymentId>>
  ELSE PosNoOp

DispatchCancelConfirmed ==
  IF txState = "CANCELLING"
  THEN /\ txState' = "CANCELLED"
       /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                      approvedAmountCents, paymentId>>
  ELSE PosNoOp

DispatchExitFlow ==
  IF txState \in {"COMPLETED", "DECLINED", "CANCELLED"}
  THEN /\ txState'             = "IDLE"
       /\ orderId'             = NONE
       /\ amountCents'         = NUMNONE
       /\ transferId'          = NONE
       /\ declineCode'         = NONE
       /\ approvedAmountCents' = NUMNONE
       /\ paymentId'           = NONE
  ELSE PosNoOp

=============================================================================
