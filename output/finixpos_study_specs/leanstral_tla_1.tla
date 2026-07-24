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
    /\ UNCHANGED <<orderId, amountCents, declineCode, approvedAmountCents, paymentId>>

VerificationStarted ==
    /\ txState = "INITIATING"
    /\ txState' = "AWAITING_VERIFICATION"
    /\ UNCHANGED <<orderId, amountCents, transferId, declineCode, approvedAmountCents, paymentId>>

TapApproved(approvedAmount) ==
    /\ txState \in {"AWAITING_TAP", "AWAITING_VERIFICATION"}
    /\ approvedAmountCents' = approvedAmount
    /\ txState' = "RECORDING"
    /\ UNCHANGED <<orderId, amountCents, transferId, declineCode, paymentId>>

TapDeclined(code) ==
    /\ txState \in {"AWAITING_TAP", "AWAITING_VERIFICATION"}
    /\ declineCode' = code
    /\ txState' = "DECLINED"
    /\ UNCHANGED <<orderId, amountCents, transferId, approvedAmountCents, paymentId>>

PaymentRecorded(payment) ==
    /\ txState = "RECORDING"
    /\ paymentId' = payment
    /\ txState' = "COMPLETED"
    /\ UNCHANGED <<orderId, amountCents, transferId, declineCode, approvedAmountCents>>

CancelPayment ==
    /\ txState \in {"INITIATING", "AWAITING_TAP", "AWAITING_VERIFICATION", "RECORDING"}
    /\ txState' = "CANCELLING"
    /\ UNCHANGED <<orderId, amountCents, transferId, declineCode, approvedAmountCents, paymentId>>

CancelConfirmed ==
    /\ txState = "CANCELLING"
    /\ txState' = "CANCELLED"
    /\ UNCHANGED <<orderId, amountCents, transferId, declineCode, approvedAmountCents, paymentId>>

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
    \/ InitiatePayment(\E o \in OrderIds: TRUE, \E a \in Amounts: TRUE)
    \/ TransferCreated(\E t \in TransferIds: TRUE)
    \/ VerificationStarted
    \/ TapApproved(\E a \in Amounts: TRUE)
    \/ TapDeclined(\E c \in DeclineCodes: TRUE)
    \/ PaymentRecorded(\E p \in PaymentIds: TRUE)
    \/ CancelPayment
    \/ CancelConfirmed
    \/ ExitFlow

Spec == Init /\ [][Next]_vars
====