---- MODULE finixpos ----
EXTENDS Integers, FiniteSets

CONSTANTS OrderIds, Amounts, TransferIds, DeclineCodes, PaymentIds

NONE  == "none"
NOAMT == -1

TxStates == { "IDLE", "INITIATING", "AWAITING_TAP", "AWAITING_VERIFICATION",
              "RECORDING", "COMPLETED", "DECLINED", "CANCELLING", "CANCELLED" }

(* Observable state variables *)
VARIABLES txState, orderId, amountCents, transferId, declineCode,
          approvedAmountCents, paymentId

vars == <<txState, orderId, amountCents, transferId, declineCode,
          approvedAmountCents, paymentId>>

(* Type invariant *)
TypeOK ==
    /\ txState ∈ TxStates
    /\ orderId ∈ OrderIds ∪ {NONE}
    /\ amountCents ∈ Amounts ∪ {NOAMT}
    /\ transferId ∈ TransferIds ∪ {NONE}
    /\ declineCode ∈ DeclineCodes ∪ {NONE}
    /\ approvedAmountCents ∈ Amounts ∪ {NOAMT}
    /\ paymentId ∈ PaymentIds ∪ {NONE}

(* Initial state *)
Init ==
    /\ txState = "IDLE"
    /\ orderId = NONE
    /\ amountCents = NOAMT
    /\ transferId = NONE
    /\ declineCode = NONE
    /\ approvedAmountCents = NOAMT
    /\ paymentId = NONE

(* Action operators *)
InitiatePayment(order, amount) ==
    /\ txState = "IDLE"
    /\ txState' = "INITIATING"
    /\ orderId' = order
    /\ amountCents' = amount
    /\ transferId' = NONE
    /\ declineCode' = NONE
    /\ approvedAmountCents' = NOAMT
    /\ paymentId' = NONE
    /\ UNCHANGED <<txState>>  \* Overridden above, but needed for TLC

InitiatePaymentIgnored(order, amount) ==
    /\ txState ≠ "IDLE"
    /\ UNCHANGED vars

TransferCreated(transfer) ==
    /\ txState = "INITIATING"
    /\ txState' = "AWAITING_TAP"
    /\ transferId' = transfer
    /\ UNCHANGED <<orderId, amountCents, declineCode, approvedAmountCents, paymentId>>

TransferCreatedIgnored(transfer) ==
    /\ txState ≠ "INITIATING"
    /\ UNCHANGED vars

VerificationStarted ==
    /\ txState = "INITIATING"
    /\ txState' = "AWAITING_VERIFICATION"
    /\ UNCHANGED <<orderId, amountCents, transferId, declineCode, approvedAmountCents, paymentId>>

VerificationStartedIgnored ==
    /\ txState ≠ "INITIATING"
    /\ UNCHANGED vars

TapApproved(approvedAmount) ==
    /\ txState ∈ {"AWAITING_TAP", "AWAITING_VERIFICATION", "CANCELLING"}
    /\ txState' =
        IF txState = "CANCELLING" THEN "RECORDING"
        ELSE "RECORDING"
    /\ approvedAmountCents' = approvedAmount
    /\ UNCHANGED <<orderId, amountCents, transferId, declineCode, paymentId>>

TapApprovedIgnored(approvedAmount) ==
    /\ txState ∉ {"AWAITING_TAP", "AWAITING_VERIFICATION", "CANCELLING"}
    /\ UNCHANGED vars

TapDeclined(code) ==
    /\ txState ∈ {"AWAITING_TAP", "AWAITING_VERIFICATION", "INITIATING", "CANCELLING"}
    /\ txState' =
        IF txState = "CANCELLING" THEN "CANCELLED"
        ELSE "DECLINED"
    /\ declineCode' = code
    /\ UNCHANGED <<orderId, amountCents, transferId, approvedAmountCents, paymentId>>

TapDeclinedIgnored(code) ==
    /\ txState ∉ {"AWAITING_TAP", "AWAITING_VERIFICATION", "INITIATING", "CANCELLING"}
    /\ UNCHANGED vars

PaymentRecorded(payment) ==
    /\ txState = "RECORDING"
    /\ txState' = "COMPLETED"
    /\ paymentId' = payment
    /\ UNCHANGED <<orderId, amountCents, transferId, declineCode, approvedAmountCents>>

PaymentRecordedIgnored(payment) ==
    /\ txState ≠ "RECORDING"
    /\ UNCHANGED vars

CancelPayment ==
    /\ txState ∈ {"INITIATING", "AWAITING_TAP"}
    /\ txState' = "CANCELLING"
    /\ UNCHANGED <<orderId, amountCents, transferId, declineCode, approvedAmountCents, paymentId>>

CancelPaymentIgnored ==
    /\ txState ∉ {"INITIATING", "AWAITING_TAP"}
    /\ UNCHANGED vars

CancelConfirmed ==
    /\ txState = "CANCELLING"
    /\ txState' = "CANCELLED"
    /\ UNCHANGED <<orderId, amountCents, transferId, declineCode, approvedAmountCents, paymentId>>

CancelConfirmedIgnored ==
    /\ txState ≠ "CANCELLING"
    /\ UNCHANGED vars

ExitFlow ==
    /\ txState ∈ {"COMPLETED", "DECLINED", "CANCELLED"}
    /\ txState' = "IDLE"
    /\ orderId' = NONE
    /\ amountCents' = NOAMT
    /\ transferId' = NONE
    /\ declineCode' = NONE
    /\ approvedAmountCents' = NOAMT
    /\ paymentId' = NONE

ExitFlowIgnored ==
    /\ txState ∉ {"COMPLETED", "DECLINED", "CANCELLED"}
    /\ UNCHANGED vars

(* Next-state relation *)
Next ==
    \E order ∈ OrderIds, amount ∈ Amounts:
        InitiatePayment(order, amount) ∨ InitiatePaymentIgnored(order, amount)
    \/ \E transfer ∈ TransferIds:
        TransferCreated(transfer) ∨ TransferCreatedIgnored(transfer)
    \/ VerificationStarted ∨ VerificationStartedIgnored
    \/ \E approvedAmount ∈ Amounts:
        TapApproved(approvedAmount) ∨ TapApprovedIgnored(approvedAmount)
    \/ \E code ∈ DeclineCodes ∪ {NONE}:
        TapDeclined(code) ∨ TapDeclinedIgnored(code)
    \/ \E payment ∈ PaymentIds ∪ {NONE}:
        PaymentRecorded(payment) ∨ PaymentRecordedIgnored(payment)
    \/ CancelPayment ∨ CancelPaymentIgnored
    \/ CancelConfirmed ∨ CancelConfirmedIgnored
    \/ ExitFlow ∨ ExitFlowIgnored

Spec == Init /\ [][Next]_vars

====