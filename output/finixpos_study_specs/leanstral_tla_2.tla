---- MODULE finixpos ----
EXTENDS Integers

CONSTANTS
    OrderIds,
    Amounts,
    TransferIds,
    DeclineCodes,
    PaymentIds

VARIABLES
    txState,
    orderId,
    amountCents,
    transferId,
    declineCode,
    approvedAmountCents,
    paymentId

\* Sentinels
NONE == "none"
NOAMT == -1

\* State set
TxStates == {"IDLE", "INITIATING", "AWAITING_TAP", "AWAITING_VERIFICATION",
             "RECORDING", "COMPLETED", "DECLINED", "CANCELLING", "CANCELLED"}

\* Initial state
Init ==
    /\ txState = "IDLE"
    /\ orderId = NONE
    /\ amountCents = NOAMT
    /\ transferId = NONE
    /\ declineCode = NONE
    /\ approvedAmountCents = NOAMT
    /\ paymentId = NONE

\* Type invariant
TypeOK ==
    /\ txState \in TxStates
    /\ orderId \in OrderIds \cup {NONE}
    /\ amountCents \in Amounts \cup {NOAMT}
    /\ transferId \in TransferIds \cup {NONE}
    /\ declineCode \in DeclineCodes \cup {NONE}
    /\ approvedAmountCents \in Amounts \cup {NOAMT}
    /\ paymentId \in PaymentIds \cup {NONE}

\* Action: InitiatePayment
InitiatePayment(order, amount) ==
    /\ txState = "IDLE"
    /\ orderId' = order
    /\ amountCents' = amount
    /\ transferId' = NONE
    /\ declineCode' = NONE
    /\ approvedAmountCents' = NOAMT
    /\ paymentId' = NONE
    /\ txState' = "INITIATING"

\* Action: TransferCreated
TransferCreated(transfer) ==
    /\ txState = "INITIATING"
    /\ transferId' = transfer
    /\ txState' = "AWAITING_TAP"
    /\ UNCHANGED <<orderId, amountCents, declineCode, approvedAmountCents, paymentId>>

\* Action: VerificationStarted
VerificationStarted ==
    /\ txState = "INITIATING"
    /\ txState' = "AWAITING_VERIFICATION"
    /\ UNCHANGED <<orderId, amountCents, transferId, declineCode, approvedAmountCents, paymentId>>

\* Action: TapApproved
TapApproved(approvedAmount) ==
    /\ txState \in {"AWAITING_TAP", "AWAITING_VERIFICATION"}
    /\ approvedAmountCents' = approvedAmount
    /\ txState' = "RECORDING"
    /\ UNCHANGED <<orderId, amountCents, transferId, declineCode, paymentId>>

\* Action: TapDeclined
TapDeclined(code) ==
    /\ txState \in {"AWAITING_TAP", "AWAITING_VERIFICATION"}
    /\ declineCode' = code
    /\ txState' = "DECLINED"
    /\ UNCHANGED <<orderId, amountCents, transferId, approvedAmountCents, paymentId>>

\* Action: PaymentRecorded
PaymentRecorded(payment) ==
    /\ txState = "RECORDING"
    /\ paymentId' = payment
    /\ txState' = "COMPLETED"
    /\ UNCHANGED <<orderId, amountCents, transferId, declineCode, approvedAmountCents>>

\* Action: CancelPayment
CancelPayment ==
    /\ txState \in {"INITIATING", "AWAITING_TAP", "AWAITING_VERIFICATION", "RECORDING"}
    /\ txState' = "CANCELLING"
    /\ UNCHANGED <<orderId, amountCents, transferId, declineCode, approvedAmountCents, paymentId>>

\* Action: CancelConfirmed
CancelConfirmed ==
    /\ txState = "CANCELLING"
    /\ txState' = "CANCELLED"
    /\ UNCHANGED <<orderId, amountCents, transferId, declineCode, approvedAmountCents, paymentId>>

\* Action: CancelDeclined (internal - not exposed in WorkflowHandle, but used in FSM)
CancelDeclined ==
    /\ txState = "CANCELLING"
    /\ txState' = "CANCELLED"
    /\ UNCHANGED <<orderId, amountCents, transferId, declineCode, approvedAmountCents, paymentId>>

\* Action: ExitFlow
ExitFlow ==
    /\ txState \in {"COMPLETED", "DECLINED", "CANCELLED"}
    /\ txState' = "IDLE"
    /\ orderId' = NONE
    /\ amountCents' = NOAMT
    /\ transferId' = NONE
    /\ declineCode' = NONE
    /\ approvedAmountCents' = NOAMT
    /\ paymentId' = NONE

\* Next relation: all nine actions, with state-conditional dispatch
Next ==
    \/ InitiatePayment(order, amount) \* for some order \in OrderIds, amount \in Amounts
    \/ TransferCreated(transfer) \* for some transfer \in TransferIds
    \/ VerificationStarted
    \/ TapApproved(approvedAmount) \* for some approvedAmount \in Amounts
    \/ TapDeclined(code) \* for some code \in DeclineCodes \cup {NONE}
    \/ PaymentRecorded(payment) \* for some payment \in PaymentIds \cup {NONE}
    \/ CancelPayment
    \/ CancelConfirmed
    \/ ExitFlow

\* Specification
vars == <<txState, orderId, amountCents, transferId, declineCode, approvedAmountCents, paymentId>>
Spec == Init /\ [][Next]_vars
====
