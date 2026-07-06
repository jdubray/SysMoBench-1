---- MODULE finixpos ----
(* Hand-written reference constrained TLA+ spec of the finixpos payment
   workflow. Positive control for the study (docs/finixpos_study_plan.md §4).
   Contract: tla_eval/tasks/finixpos/prompts/direct_call_constrained_nosemantics.txt *)
EXTENDS Integers

CONSTANTS OrderIds, Amounts, TransferIds, DeclineCodes, PaymentIds

VARIABLES txState, orderId, amountCents, transferId, declineCode,
          approvedAmountCents, paymentId

NONE  == "none"
NOAMT == -1

TxStates == { "IDLE", "INITIATING", "AWAITING_TAP", "AWAITING_VERIFICATION",
              "RECORDING", "COMPLETED", "DECLINED", "CANCELLING", "CANCELLED" }

vars == <<txState, orderId, amountCents, transferId, declineCode,
          approvedAmountCents, paymentId>>

TypeOK == /\ txState \in TxStates
          /\ orderId \in (OrderIds \union {NONE})
          /\ amountCents \in (Amounts \union {NOAMT})
          /\ transferId \in (TransferIds \union {NONE})
          /\ declineCode \in (DeclineCodes \union {NONE})
          /\ approvedAmountCents \in (Amounts \union {NOAMT})
          /\ paymentId \in (PaymentIds \union {NONE})

Init == /\ txState = "IDLE"
        /\ orderId = NONE
        /\ amountCents = NOAMT
        /\ transferId = NONE
        /\ declineCode = NONE
        /\ approvedAmountCents = NOAMT
        /\ paymentId = NONE

(* Every action is TOTAL: when the workflow does not act on it in the current
   state, the step is an observable no-op (all variables unchanged). *)

InitiatePayment(order, amount) ==
  IF txState = "IDLE"
  THEN /\ txState' = "INITIATING"
       /\ orderId' = order
       /\ amountCents' = amount
       /\ transferId' = NONE
       /\ declineCode' = NONE
       /\ approvedAmountCents' = NOAMT
       /\ paymentId' = NONE
  ELSE UNCHANGED vars

TransferCreated(transfer) ==
  IF txState = "INITIATING"
  THEN /\ txState' = "AWAITING_TAP"
       /\ transferId' = transfer
       /\ UNCHANGED <<orderId, amountCents, declineCode, approvedAmountCents, paymentId>>
  ELSE UNCHANGED vars

VerificationStarted ==
  IF txState = "INITIATING"
  THEN /\ txState' = "AWAITING_VERIFICATION"
       /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                      approvedAmountCents, paymentId>>
  ELSE UNCHANGED vars

(* Partial-payment guard: in AWAITING_TAP, approvedAmount strictly below the
   requested amount is rewritten to a decline with code PARTIAL_PAYMENT
   (approvedAmountCents is NOT set). Overpayment (tip) is accepted. *)
TapApproved(approvedAmount) ==
  IF txState \in { "AWAITING_TAP", "AWAITING_VERIFICATION", "CANCELLING" }
  THEN /\ txState' = "RECORDING"
       /\ approvedAmountCents' = approvedAmount
       /\ UNCHANGED <<orderId, amountCents, transferId, declineCode, paymentId>>
  ELSE UNCHANGED vars

(* TAP_DECLINED in CANCELLING is rewritten to the internal CANCEL_DECLINED
   (-> CANCELLED); elsewhere it declines from the active states. *)
TapDeclined(code) ==
  IF txState = "CANCELLING"
  THEN /\ txState' = "CANCELLED"
       /\ declineCode' = code
       /\ UNCHANGED <<orderId, amountCents, transferId, approvedAmountCents, paymentId>>
  ELSE IF txState \in { "INITIATING", "AWAITING_TAP", "AWAITING_VERIFICATION" }
  THEN /\ txState' = "DECLINED"
       /\ declineCode' = code
       /\ UNCHANGED <<orderId, amountCents, transferId, approvedAmountCents, paymentId>>
  ELSE UNCHANGED vars

PaymentRecorded(payment) ==
  IF txState = "RECORDING"
  THEN /\ txState' = "COMPLETED"
       /\ paymentId' = payment
       /\ UNCHANGED <<orderId, amountCents, transferId, declineCode, approvedAmountCents>>
  ELSE UNCHANGED vars

CancelPayment ==
  IF txState \in { "INITIATING", "AWAITING_TAP" }
  THEN /\ txState' = "CANCELLING"
       /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                      approvedAmountCents, paymentId>>
  ELSE UNCHANGED vars

CancelConfirmed ==
  IF txState = "CANCELLING"
  THEN /\ txState' = "CANCELLED"
       /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                      approvedAmountCents, paymentId>>
  ELSE UNCHANGED vars

ExitFlow ==
  IF txState \in { "COMPLETED", "DECLINED", "CANCELLED" }
  THEN /\ txState' = "IDLE"
       /\ orderId' = NONE
       /\ amountCents' = NOAMT
       /\ transferId' = NONE
       /\ declineCode' = NONE
       /\ approvedAmountCents' = NOAMT
       /\ paymentId' = NONE
  ELSE UNCHANGED vars

Next == \/ \E o \in OrderIds, a \in Amounts : InitiatePayment(o, a)
        \/ \E t \in TransferIds : TransferCreated(t)
        \/ VerificationStarted
        \/ \E a \in Amounts : TapApproved(a)
        \/ \E c \in (DeclineCodes \union {NONE}) : TapDeclined(c)
        \/ \E p \in (PaymentIds \union {NONE}) : PaymentRecorded(p)
        \/ CancelPayment
        \/ CancelConfirmed
        \/ ExitFlow

Spec == Init /\ [][Next]_vars
====
