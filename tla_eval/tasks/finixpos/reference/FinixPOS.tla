---------------------------- MODULE FinixPOS ----------------------------
(***************************************************************************)
(* Hand-written faithful model of the POS dispatch-level transition        *)
(* relation in baanbaan Merchant/v2 src/workflows/terminal-payment.ts      *)
(* (copy: tla_eval/tasks/finixpos/source/terminal-payment.ts).             *)
(*                                                                         *)
(* One Dispatch* operator per SAM action, with TOTAL semantics: an action  *)
(* rejected by the FSM (enforceAllowedTransitions, lines 217-246) is an    *)
(* observable no-op (PosNoOp), matching the anti-glitch invariant in the   *)
(* file header (lines 23-25) and the post-state-guarded mutation acceptor  *)
(* (lines 890-954).                                                        *)
(*                                                                         *)
(* The two pre-FSM acceptor rewrites (lines 846-877) are folded in:        *)
(*   - CANCELLING + TAP_DECLINED  -> CANCEL_DECLINED -> CANCELLED          *)
(*   - AWAITING_TAP + TAP_APPROVED(amt < amountCents)                      *)
(*       -> TAP_DECLINED(declineCode = "PARTIAL_PAYMENT") -> DECLINED      *)
(* CANCEL_DECLINED itself is internal and never a dispatched action.      *)
(***************************************************************************)
EXTENDS Integers

NONE    == "none"
NUMNONE == -1

VARIABLES
  txState,              \* FSM program counter (lines 65-75)
  orderId,              \* current order, NONE when idle
  amountCents,          \* requested amount, NUMNONE when idle
  transferId,           \* Finix transfer id once TRANSFER_CREATED accepted
  declineCode,          \* failure code on DECLINED / CANCELLED
  approvedAmountCents,  \* Finix-reported charge once TAP_APPROVED accepted
  paymentId             \* payments row id once PAYMENT_RECORDED accepted

posVars == <<txState, orderId, amountCents, transferId, declineCode,
             approvedAmountCents, paymentId>>

PosStates == {"IDLE", "INITIATING", "AWAITING_TAP", "AWAITING_VERIFICATION",
              "RECORDING", "COMPLETED", "DECLINED", "CANCELLING", "CANCELLED"}
\* "PROCESSING" is reserved/unreachable in v1 (line 70) and omitted.

PosInit ==
  /\ txState             = "IDLE"
  /\ orderId             = NONE
  /\ amountCents         = NUMNONE
  /\ transferId          = NONE
  /\ declineCode         = NONE
  /\ approvedAmountCents = NUMNONE
  /\ paymentId           = NONE

PosNoOp == UNCHANGED posVars

(* INITIATE_PAYMENT: IDLE -> INITIATING; resets transaction fields          *)
(* (component action lines 738-778, mutation acceptor lines 893-913).       *)
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

(* TRANSFER_CREATED: INITIATING -> AWAITING_TAP; sets transferId            *)
(* (lines 915-917). Rejected anywhere else -> no-op (this is the window the *)
(* cancel-during-INITIATING race exploits).                                 *)
DispatchTransferCreated(tid) ==
  IF txState = "INITIATING"
  THEN /\ txState'    = "AWAITING_TAP"
       /\ transferId' = tid
       /\ UNCHANGED <<orderId, amountCents, declineCode,
                      approvedAmountCents, paymentId>>
  ELSE PosNoOp

(* VERIFICATION_STARTED: INITIATING -> AWAITING_VERIFICATION (line 223/234) *)
DispatchVerificationStarted ==
  IF txState = "INITIATING"
  THEN /\ txState' = "AWAITING_VERIFICATION"
       /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                      approvedAmountCents, paymentId>>
  ELSE PosNoOp

(* TAP_APPROVED(amt):                                                       *)
(*  - partial rewrite ONLY from AWAITING_TAP (acceptor guard line 866):     *)
(*    amt < amountCents -> DECLINED with PARTIAL_PAYMENT (lines 864-876)    *)
(*  - else allowed from AWAITING_TAP, AWAITING_VERIFICATION, CANCELLING     *)
(*    (FSM lines 235, 236, 241) -> RECORDING, data applied (lines 919-926)  *)
(*  - else no-op (e.g. late approval in RECORDING/COMPLETED).               *)
DispatchTapApproved(amt) ==
  IF txState = "AWAITING_TAP" /\ amt < amountCents
  THEN /\ txState'     = "DECLINED"
       /\ declineCode' = "PARTIAL_PAYMENT"
       /\ UNCHANGED <<orderId, amountCents, transferId,
                      approvedAmountCents, paymentId>>
  ELSE IF txState \in {"AWAITING_TAP", "AWAITING_VERIFICATION", "CANCELLING"}
  THEN /\ txState'             = "RECORDING"
       /\ approvedAmountCents' = amt
       /\ UNCHANGED <<orderId, amountCents, transferId, declineCode, paymentId>>
  ELSE PosNoOp

(* TAP_DECLINED(code):                                                      *)
(*  - from CANCELLING: rewritten to CANCEL_DECLINED -> CANCELLED            *)
(*    (acceptor lines 854-857; declineCode applied lines 928-932)           *)
(*  - from INITIATING / AWAITING_TAP / AWAITING_VERIFICATION -> DECLINED    *)
(*  - else no-op.                                                           *)
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

(* PAYMENT_RECORDED: RECORDING -> COMPLETED (lines 227/238, 934-936)        *)
DispatchPaymentRecorded(pid) ==
  IF txState = "RECORDING"
  THEN /\ txState'   = "COMPLETED"
       /\ paymentId' = pid
       /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                      approvedAmountCents>>
  ELSE PosNoOp

(* CANCEL_PAYMENT: INITIATING | AWAITING_TAP -> CANCELLING (lines 234-235)  *)
DispatchCancelPayment ==
  IF txState \in {"INITIATING", "AWAITING_TAP"}
  THEN /\ txState' = "CANCELLING"
       /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                      approvedAmountCents, paymentId>>
  ELSE PosNoOp

(* CANCEL_CONFIRMED: CANCELLING -> CANCELLED (line 241)                     *)
DispatchCancelConfirmed ==
  IF txState = "CANCELLING"
  THEN /\ txState' = "CANCELLED"
       /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                      approvedAmountCents, paymentId>>
  ELSE PosNoOp

(* EXIT_FLOW: COMPLETED | DECLINED | CANCELLED -> IDLE, nulls the           *)
(* transaction (lines 797-816, 938-953)                                     *)
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
