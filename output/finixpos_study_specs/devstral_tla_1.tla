---- MODULE finixpos ----
EXTENDS Integers

CONSTANTS OrderIds, Amounts, TransferIds, DeclineCodes, PaymentIds

NONE == "none"
NOAMT == -1

TxStates == { "IDLE", "INITIATING", "AWAITING_TAP", "AWAITING_VERIFICATION",
              "RECORDING", "COMPLETED", "DECLINED", "CANCELLING", "CANCELLED" }

VARIABLES txState, orderId, amountCents, transferId, declineCode,
          approvedAmountCents, paymentId

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
    /\ orderId' = order
    /\ amountCents' = amount
    /\ transferId' = NONE
    /\ declineCode' = NONE
    /\ approvedAmountCents' = NOAMT
    /\ paymentId' = NONE
    /\ txState' = "INITIATING"
    /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                   approvedAmountCents, paymentId>>

TransferCreated(transfer) ==
    /\ txState = "INITIATING"
    /\ transferId' = transfer
    /\ txState' = "AWAITING_TAP"
    /\ UNCHANGED <<orderId, amountCents, declineCode,
                   approvedAmountCents, paymentId>>

VerificationStarted ==
    /\ txState = "INITIATING"
    /\ txState' = "AWAITING_VERIFICATION"
    /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                   approvedAmountCents, paymentId>>

TapApproved(approvedAmount) ==
    \/ /\ txState = "AWAITING_TAP"
       /\ approvedAmount >= amountCents
       /\ approvedAmountCents' = approvedAmount
       /\ txState' = "RECORDING"
       /\ UNCHANGED <<orderId, amountCents, transferId, declineCode, paymentId>>
    \/ /\ txState = "CANCELLING"
       /\ approvedAmount >= amountCents
       /\ approvedAmountCents' = approvedAmount
       /\ txState' = "RECORDING"
       /\ UNCHANGED <<orderId, amountCents, transferId, declineCode, paymentId>>
    \/ /\ txState \in {"RECORDING", "COMPLETED"}
       /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                      approvedAmountCents, paymentId, txState>>

TapDeclined(code) ==
    \/ /\ txState = "AWAITING_TAP"
       /\ declineCode' = code
       /\ txState' = "DECLINED"
       /\ UNCHANGED <<orderId, amountCents, transferId,
                      approvedAmountCents, paymentId>>
    \/ /\ txState = "CANCELLING"
       /\ declineCode' = code
       /\ txState' = "CANCELLED"
       /\ UNCHANGED <<orderId, amountCents, transferId,
                      approvedAmountCents, paymentId>>
    \/ /\ txState \in {"RECORDING", "COMPLETED"}
       /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                      approvedAmountCents, paymentId, txState>>

PaymentRecorded(payment) ==
    /\ txState = "RECORDING"
    /\ paymentId' = payment
    /\ txState' = "COMPLETED"
    /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                   approvedAmountCents>>

CancelPayment ==
    /\ txState \in {"AWAITING_TAP", "AWAITING_VERIFICATION"}
    /\ txState' = "CANCELLING"
    /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                   approvedAmountCents, paymentId>>

CancelConfirmed ==
    /\ txState = "CANCELLING"
    /\ txState' = "CANCELLED"
    /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                   approvedAmountCents, paymentId>>

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
    \E order \in OrderIds:
    \E amount \in Amounts:
        InitiatePayment(order, amount)
    \/ \E transfer \in TransferIds:
        TransferCreated(transfer)
    \/ VerificationStarted
    \/ \E approvedAmount \in Amounts:
        TapApproved(approvedAmount)
    \/ \E code \in DeclineCodes \cup {NONE}:
        TapDeclined(code)
    \/ \E payment \in PaymentIds \cup {NONE}:
        PaymentRecorded(payment)
    \/ CancelPayment
    \/ CancelConfirmed
    \/ ExitFlow

Spec == Init /\ [][Next]_<<txState, orderId, amountCents, transferId,
                            declineCode, approvedAmountCents, paymentId>>
====