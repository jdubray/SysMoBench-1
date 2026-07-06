---- MODULE finixpos ----
EXTENDS Integers

CONSTANTS
    OrderIds,
    Amounts,
    TransferIds,
    DeclineCodes,
    PaymentIds

VARIABLES txState, orderId, amountCents, transferId, declineCode,
          approvedAmountCents, paymentId

NONE == "none"
NOAMT == -1

TxStates == {"IDLE", "INITIATING", "AWAITING_TAP", "AWAITING_VERIFICATION",
             "RECORDING", "COMPLETED", "DECLINED", "CANCELLING", "CANCELLED"}

Init ==
    /\ txState = "IDLE"
    /\ orderId = NONE
    /\ amountCents = NOAMT
    /\ transferId = NONE
    /\ declineCode = NONE
    /\ approvedAmountCents = NOAMT
    /\ paymentId = NONE

TypeOK ==
    /\ txState \in TxStates
    /\ orderId \in OrderIds \cup {NONE}
    /\ amountCents \in Amounts \cup {NOAMT}
    /\ transferId \in TransferIds \cup {NONE}
    /\ declineCode \in DeclineCodes \cup {NONE}
    /\ approvedAmountCents \in Amounts \cup {NOAMT}
    /\ paymentId \in PaymentIds \cup {NONE}

vars == <<txState, orderId, amountCents, transferId, declineCode,
          approvedAmountCents, paymentId>>

InitiatePayment(order, amount) ==
    /\ txState = "IDLE"
    /\ orderId' = order
    /\ amountCents' = amount
    /\ transferId' = NONE
    /\ declineCode' = NONE
    /\ approvedAmountCents' = NOAMT
    /\ paymentId' = NONE
    /\ txState' = "INITIATING"

TransferCreated(transfer) ==
    /\ txState = "INITIATING"
    /\ transferId' = transfer
    /\ txState' = "AWAITING_TAP"
    /\ orderId' = orderId
    /\ amountCents' = amountCents
    /\ declineCode' = declineCode
    /\ approvedAmountCents' = approvedAmountCents
    /\ paymentId' = paymentId

VerificationStarted ==
    /\ txState = "INITIATING"
    /\ txState' = "AWAITING_VERIFICATION"
    /\ orderId' = orderId
    /\ amountCents' = amountCents
    /\ transferId' = transferId
    /\ declineCode' = declineCode
    /\ approvedAmountCents' = approvedAmountCents
    /\ paymentId' = paymentId

TapApproved(approvedAmount) ==
    /\ txState \in {"AWAITING_TAP", "AWAITING_VERIFICATION", "CANCELLING"}
    /\ IF txState = "CANCELLING" THEN
           /\ txState' = "CANCELLED"
           /\ declineCode' = NONE
       ELSE
           /\ txState' = "RECORDING"
           /\ approvedAmountCents' = approvedAmount
           /\ declineCode' = declineCode
       /\ orderId' = orderId
       /\ amountCents' = amountCents
       /\ transferId' = transferId
       /\ paymentId' = paymentId

TapDeclined(code) ==
    /\ txState \in {"AWAITING_TAP", "AWAITING_VERIFICATION", "CANCELLING"}
    /\ IF txState = "CANCELLING" THEN
           /\ txState' = "CANCELLED"
           /\ declineCode' = code
       ELSE
           /\ txState' = "DECLINED"
           /\ declineCode' = code
       /\ orderId' = orderId
       /\ amountCents' = amountCents
       /\ transferId' = transferId
       /\ approvedAmountCents' = approvedAmountCents
       /\ paymentId' = paymentId

PaymentRecorded(payment) ==
    /\ txState = "RECORDING"
    /\ txState' = "COMPLETED"
    /\ paymentId' = payment
    /\ orderId' = orderId
    /\ amountCents' = amountCents
    /\ transferId' = transferId
    /\ declineCode' = declineCode
    /\ approvedAmountCents' = approvedAmountCents

CancelPayment ==
    /\ txState \in {"INITIATING", "AWAITING_TAP", "AWAITING_VERIFICATION",
                    "RECORDING", "COMPLETED", "DECLINED", "CANCELLING"}
    /\ txState' = "CANCELLING"
    /\ orderId' = orderId
    /\ amountCents' = amountCents
    /\ transferId' = transferId
    /\ declineCode' = declineCode
    /\ approvedAmountCents' = approvedAmountCents
    /\ paymentId' = paymentId

CancelConfirmed ==
    /\ txState = "CANCELLING"
    /\ txState' = "CANCELLED"
    /\ orderId' = orderId
    /\ amountCents' = amountCents
    /\ transferId' = transferId
    /\ declineCode' = NONE
    /\ approvedAmountCents' = approvedAmountCents
    /\ paymentId' = paymentId

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
    \/ InitiatePayment(orderId, amountCents)
    \/ TransferCreated(transferId)
    \/ VerificationStarted
    \/ TapApproved(approvedAmountCents)
    \/ TapDeclined(declineCode)
    \/ PaymentRecorded(paymentId)
    \/ CancelPayment
    \/ CancelConfirmed
    \/ ExitFlow

Spec == Init /\ [][Next]_vars
====