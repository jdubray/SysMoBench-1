---- MODULE finixpos ----
EXTENDS Integers

CONSTANTS OrderIds, Amounts, TransferIds, DeclineCodes, PaymentIds

VARIABLES txState, orderId, amountCents, transferId, declineCode,
          approvedAmountCents, paymentId

TxStates == { "IDLE", "INITIATING", "AWAITING_TAP", "AWAITING_VERIFICATION",
              "RECORDING", "COMPLETED", "DECLINED", "CANCELLING", "CANCELLED" }

NONE == "none"
NOAMT == -1

TypeOK ==
  /\ txState \in TxStates
  /\ orderId \in OrderIds \cup {NONE}
  /\ amountCents \in Amounts \cup {NOAMT}
  /\ transferId \in TransferIds \cup {NONE}
  /\ declineCode \in DeclineCodes \cup {NONE}
  /\ approvedAmountCents \in Amounts \cup {NOAMT}
  /\ paymentId \in PaymentIds \cup {NONE}

Init ==
  /\ txState = "IDLE"
  /\ orderId = NONE
  /\ amountCents = NOAMT
  /\ transferId = NONE
  /\ declineCode = NONE
  /\ approvedAmountCents = NOAMT
  /\ paymentId = NONE

InitiatePayment(order, amount) ==
  /\ txState = "IDLE"
  /\ order \in OrderIds
  /\ amount \in Amounts
  /\ txState' = "INITIATING"
  /\ orderId' = order
  /\ amountCents' = amount
  /\ transferId' = NONE
  /\ declineCode' = NONE
  /\ approvedAmountCents' = NOAMT
  /\ paymentId' = NONE

TransferCreated(transfer) ==
  /\ txState = "INITIATING"
  /\ transfer \in TransferIds
  /\ txState' = "AWAITING_TAP"
  /\ transferId' = transfer
  /\ orderId' = orderId
  /\ amountCents' = amountCents
  /\ declineCode' = NONE
  /\ approvedAmountCents' = NOAMT
  /\ paymentId' = NONE

VerificationStarted ==
  /\ txState = "INITIATING"
  /\ txState' = "AWAITING_VERIFICATION"
  /\ orderId' = orderId
  /\ amountCents' = amountCents
  /\ transferId' = NONE
  /\ declineCode' = NONE
  /\ approvedAmountCents' = NOAMT
  /\ paymentId' = NONE

TapApproved(approvedAmount) ==
  /\ txState \in {"AWAITING_TAP", "CANCELLING"}
  /\ approvedAmount \in Amounts
  /\ approvedAmount >= amountCents
  /\ txState' = "RECORDING"
  /\ approvedAmountCents' = approvedAmount
  /\ orderId' = orderId
  /\ amountCents' = amountCents
  /\ transferId' = transferId
  /\ declineCode' = NONE
  /\ paymentId' = NONE

TapDeclined(code) ==
  /\ txState \in {"AWAITING_TAP", "AWAITING_VERIFICATION", "CANCELLING"}
  /\ code \in DeclineCodes \cup {NONE}
  /\ (txState = "CANCELLING" => txState' = "CANCELLED")
  /\ (txState \in {"AWAITING_TAP", "AWAITING_VERIFICATION"} => txState' = "DECLINED")
  /\ declineCode' = code
  /\ orderId' = orderId
  /\ amountCents' = amountCents
  /\ transferId' = transferId
  /\ approvedAmountCents' = NOAMT
  /\ paymentId' = NONE

PaymentRecorded(payment) ==
  /\ txState = "RECORDING"
  /\ payment \in PaymentIds \cup {NONE}
  /\ txState' = "COMPLETED"
  /\ paymentId' = payment
  /\ orderId' = orderId
  /\ amountCents' = amountCents
  /\ transferId' = transferId
  /\ declineCode' = NONE
  /\ approvedAmountCents' = approvedAmountCents

CancelPayment ==
  /\ txState \in {"AWAITING_TAP", "AWAITING_VERIFICATION"}
  /\ txState' = "CANCELLING"
  /\ orderId' = orderId
  /\ amountCents' = amountCents
  /\ transferId' = transferId
  /\ declineCode' = NONE
  /\ approvedAmountCents' = NOAMT
  /\ paymentId' = NONE

CancelConfirmed ==
  /\ txState = "CANCELLING"
  /\ txState' = "CANCELLED"
  /\ declineCode' = NONE
  /\ orderId' = orderId
  /\ amountCents' = amountCents
  /\ transferId' = transferId
  /\ approvedAmountCents' = NOAMT
  /\ paymentId' = NONE

ExitFlow ==
  /\ txState \in {"COMPLETED", "DECLINED", "CANCELLED"}
  /\ txState' = "IDLE"
  /\ orderId' = NONE
  /\ amountCents' = NOAMT
  /\ transferId' = NONE
  /\ declineCode' = NONE
  /\ approvedAmountCents' = NOAMT
  /\ paymentId' = NONE

Next ==
  \/ \exists order \in OrderIds, amount \in Amounts : InitiatePayment(order, amount)
  \/ \exists transfer \in TransferIds : TransferCreated(transfer)
  \/ VerificationStarted
  \/ \exists approvedAmount \in Amounts : TapApproved(approvedAmount)
  \/ \exists code \in DeclineCodes \cup {NONE} : TapDeclined(code)
  \/ \exists payment \in PaymentIds \cup {NONE} : PaymentRecorded(payment)
  \/ CancelPayment
  \/ CancelConfirmed
  \/ ExitFlow

vars == <<txState, orderId, amountCents, transferId, declineCode,
           approvedAmountCents, paymentId>>

Spec == Init /\ [][Next]_vars
====