---- MODULE finixpos ----
EXTENDS Integers

CONSTANTS OrderIds, Amounts, TransferIds, DeclineCodes, PaymentIds

NONE  == "none"
NOAMT == -1

TxStates == { "IDLE", "INITIATING", "AWAITING_TAP", "AWAITING_VERIFICATION",
              "RECORDING", "COMPLETED", "DECLINED", "CANCELLING", "CANCELLED" }

VARIABLES txState, orderId, amountCents, transferId, declineCode,
          approvedAmountCents, paymentId

vars == <<txState, orderId, amountCents, transferId, declineCode,
          approvedAmountCents, paymentId>>

Init ==
    /\ txState = "IDLE"
    /\ orderId = NONE
    /\ amountCents = NOAMT
    /\ transferId = NONE
    /\ declineCode = NONE
    /\ approvedAmountCents = NOAMT
    /\ paymentId = NONE

TypeOK ==
    /\ txState ∈ TxStates
    /\ orderId ∈ OrderIds ∪ {NONE}
    /\ amountCents ∈ Amounts ∪ {NOAMT}
    /\ transferId ∈ TransferIds ∪ {NONE}
    /\ declineCode ∈ DeclineCodes ∪ {NONE}
    /\ approvedAmountCents ∈ Amounts ∪ {NOAMT}
    /\ paymentId ∈ PaymentIds ∪ {NONE}

InitiatePayment(order, amount) ==
    /\ txState = "IDLE"
    /\ txState' = "INITIATING"
    /\ orderId' = order
    /\ amountCents' = amount
    /\ transferId' = NONE
    /\ declineCode' = NONE
    /\ approvedAmountCents' = NOAMT
    /\ paymentId' = NONE
    /\ UNCHANGED <<txState>> \* Override above

TransferCreated(transfer) ==
    /\ txState = "INITIATING"
    /\ txState' = "AWAITING_TAP"
    /\ transferId' = transfer
    /\ UNCHANGED <<orderId, amountCents, declineCode, approvedAmountCents, paymentId>>

VerificationStarted ==
    /\ txState = "INITIATING"
    /\ txState' = "AWAITING_VERIFICATION"
    /\ UNCHANGED <<orderId, amountCents, transferId, declineCode, approvedAmountCents, paymentId>>

TapApproved(approvedAmount) ==
    /\ txState ∈ {"AWAITING_TAP", "AWAITING_VERIFICATION", "CANCELLING"}
    /\ IF txState = "CANCELLING"
       THEN /\ txState' = "RECORDING"
            /\ approvedAmountCents' = approvedAmount
            /\ UNCHANGED <<orderId, amountCents, transferId, declineCode, paymentId>>
       ELSE /\ txState' = "RECORDING"
            /\ approvedAmountCents' = approvedAmount
            /\ UNCHANGED <<orderId, amountCents, transferId, declineCode, paymentId>>
    /\ UNCHANGED <<txState, orderId, amountCents, transferId, declineCode, approvedAmountCents, paymentId>>

TapDeclined(code) ==
    /\ txState ∈ {"AWAITING_TAP", "AWAITING_VERIFICATION", "INITIATING", "CANCELLING"}
    /\ IF txState = "CANCELLING"
       THEN /\ txState' = "CANCELLED"
            /\ declineCode' = code
       ELSE /\ txState' = "DECLINED"
            /\ declineCode' = code
    /\ UNCHANGED <<orderId, amountCents, transferId, approvedAmountCents, paymentId>>

PaymentRecorded(payment) ==
    /\ txState = "RECORDING"
    /\ txState' = "COMPLETED"
    /\ paymentId' = payment
    /\ UNCHANGED <<orderId, amountCents, transferId, declineCode, approvedAmountCents>>

CancelPayment ==
    /\ txState ∈ {"INITIATING", "AWAITING_TAP"}
    /\ txState' = "CANCELLING"
    /\ UNCHANGED <<orderId, amountCents, transferId, declineCode, approvedAmountCents, paymentId>>

CancelConfirmed ==
    /\ txState = "CANCELLING"
    /\ txState' = "CANCELLED"
    /\ UNCHANGED <<orderId, amountCents, transferId, declineCode, approvedAmountCents, paymentId>>

ExitFlow ==
    /\ txState ∈ {"COMPLETED", "DECLINED", "CANCELLED"}
    /\ txState' = "IDLE"
    /\ orderId' = NONE
    /\ amountCents' = NOAMT
    /\ transferId' = NONE
    /\ declineCode' = NONE
    /\ approvedAmountCents' = NOAMT
    /\ paymentId' = NONE

Next ==
    \E order ∈ OrderIds, amount ∈ Amounts:
        InitiatePayment(order, amount)
    \/ \E transfer ∈ TransferIds:
        TransferCreated(transfer)
    \/ VerificationStarted
    \/ \E approvedAmount ∈ Amounts:
        TapApproved(approvedAmount)
    \/ \E code ∈ DeclineCodes ∪ {NONE}:
        TapDeclined(code)
    \/ \E payment ∈ PaymentIds ∪ {NONE}:
        PaymentRecorded(payment)
    \/ CancelPayment
    \/ CancelConfirmed
    \/ ExitFlow

Spec == Init /\ [][Next]_vars
====