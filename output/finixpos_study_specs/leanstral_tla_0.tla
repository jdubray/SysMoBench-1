---- MODULE finixpos ----
EXTENDS Integers

CONSTANTS
    OrderIds = {"O1"},
    Amounts = {500, 1000, 1500},
    TransferIds = {"TR1", "TR2"},
    DeclineCodes = {"INSUFFICIENT_FUNDS", "CANCELLATION_VIA_API",
                    "CANCELLATION_VIA_DEVICE", "IMMEDIATE_FAILURE",
                    "PARTIAL_PAYMENT", "VERIFICATION_FAILED"},
    PaymentIds = {"P1"}

VARIABLES txState, orderId, amountCents, transferId, declineCode,
          approvedAmountCents, paymentId

vars == <<txState, orderId, amountCents, transferId, declineCode,
          approvedAmountCents, paymentId>>

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

InitiatePayment(order, amount) ==
    /\ txState = "IDLE"
    /\ order \in OrderIds
    /\ amount \in Amounts
    /\ orderId' = order
    /\ amountCents' = amount
    /\ transferId' = NONE
    /\ declineCode' = NONE
    /\ approvedAmountCents' = NOAMT
    /\ paymentId' = NONE
    /\ txState' = "INITIATING"

TransferCreated(transfer) ==
    /\ txState = "INITIATING"
    /\ transfer \in TransferIds
    /\ transferId' = transfer
    /\ txState' = "AWAITING_TAP"
    /\ UNCHANGED <<orderId, amountCents, declineCode, approvedAmountCents, paymentId>>

VerificationStarted ==
    /\ txState = "INITIATING"
    /\ txState' = "AWAITING_VERIFICATION"
    /\ UNCHANGED <<orderId, amountCents, transferId, declineCode, approvedAmountCents, paymentId>>

TapApproved(approvedAmount) ==
    /\ txState \in {"AWAITING_TAP", "AWAITING_VERIFICATION", "RECORDING"}
    /\ approvedAmount \in Amounts
    /\ IF txState = "AWAITING_TAP" THEN
           /\ txState' = "RECORDING"
           /\ approvedAmountCents' = approvedAmount
           /\ UNCHANGED <<orderId, amountCents, transferId, declineCode, paymentId>>
       ELSE IF txState = "AWAITING_VERIFICATION" THEN
           /\ txState' = "RECORDING"
           /\ approvedAmountCents' = approvedAmount
           /\ UNCHANGED <<orderId, amountCents, transferId, declineCode, paymentId>>
       ELSE /\ txState = "RECORDING"
           /\ txState' = "RECORDING"
           /\ approvedAmountCents' = approvedAmount
           /\ UNCHANGED <<orderId, amountCents, transferId, declineCode, paymentId>>

TapDeclined(code) ==
    /\ txState \in {"AWAITING_TAP", "AWAITING_VERIFICATION", "CANCELLING"}
    /\ code \in DeclineCodes \cup {NONE}
    /\ IF txState = "AWAITING_TAP" THEN
           /\ txState' = "DECLINED"
           /\ declineCode' = code
           /\ UNCHANGED <<orderId, amountCents, transferId, approvedAmountCents, paymentId>>
       ELSE IF txState = "AWAITING_VERIFICATION" THEN
           /\ txState' = "DECLINED"
           /\ declineCode' = code
           /\ UNCHANGED <<orderId, amountCents, transferId, approvedAmountCents, paymentId>>
       ELSE /\ txState = "CANCELLING"
           /\ txState' = "CANCELLED"
           /\ declineCode' = code
           /\ UNCHANGED <<orderId, amountCents, transferId, approvedAmountCents, paymentId>>

PaymentRecorded(payment) ==
    /\ txState = "RECORDING"
    /\ payment \in PaymentIds \cup {NONE}
    /\ IF payment = NONE THEN
           /\ txState' = "COMPLETED"
           /\ paymentId' = NONE
           /\ UNCHANGED <<orderId, amountCents, transferId, declineCode, approvedAmountCents>>
       ELSE
           /\ txState' = "COMPLETED"
           /\ paymentId' = payment
           /\ UNCHANGED <<orderId, amountCents, transferId, declineCode, approvedAmountCents>>

CancelPayment ==
    /\ txState \in {"INITIATING", "AWAITING_TAP", "AWAITING_VERIFICATION",
                    "RECORDING", "CANCELLING"}
    /\ txState' = "CANCELLING"
    /\ UNCHANGED <<orderId, amountCents, transferId, declineCode, approvedAmountCents, paymentId>>

CancelConfirmed ==
    /\ txState = "CANCELLING"
    /\ txState' = "CANCELLED"
    /\ UNCHANGED <<orderId, amountCents, transferId, declineCode, approvedAmountCents, paymentId>>

ExitFlow ==
    /\ txState \in {"IDLE", "COMPLETED", "DECLINED", "CANCELLED"}
    /\ txState' = "IDLE"
    /\ orderId' = NONE
    /\ amountCents' = NOAMT
    /\ transferId' = NONE
    /\ declineCode' = NONE
    /\ approvedAmountCents' = NOAMT
    /\ paymentId' = NONE

Next ==
    \/ InitiatePayment(orderId, amountCents)  \* re-use bound variables for simplicity
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