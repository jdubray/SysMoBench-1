---- MODULE finixpos ----
EXTENDS Integers

CONSTANTS OrderIds, Amounts, TransferIds, DeclineCodes, PaymentIds

VARIABLES txState, orderId, amountCents, transferId, declineCode,
          approvedAmountCents, paymentId

vars == <<txState, orderId, amountCents, transferId, declineCode,
          approvedAmountCents, paymentId>>

NONE == "none"
NOAMT == -1

TxStates == { "IDLE", "INITIATING", "AWAITING_TAP", "AWAITING_VERIFICATION",
              "RECORDING", "COMPLETED", "DECLINED", "CANCELLING", "CANCELLED" }

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

\* InitiatePayment: IDLE → INITIATING
\* Stores order and amount; resets transaction fields
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

\* TransferCreated: INITIATING → AWAITING_TAP
\* Records the Finix transfer ID
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

\* VerificationStarted: INITIATING → AWAITING_VERIFICATION
\* Finix API call timed out; awaiting orphan sweep resolution
VerificationStarted ==
  /\ txState = "INITIATING"
  /\ txState' = "AWAITING_VERIFICATION"
  /\ orderId' = orderId
  /\ amountCents' = amountCents
  /\ transferId' = NONE
  /\ declineCode' = NONE
  /\ approvedAmountCents' = NOAMT
  /\ paymentId' = NONE

\* TapApproved: AWAITING_TAP → RECORDING or AWAITING_VERIFICATION → RECORDING
\* Card approved; records approved amount and transitions to recording state
TapApproved(approvedAmount) ==
  /\ approvedAmount \in Amounts
  /\ (txState = "AWAITING_TAP" \/ txState = "AWAITING_VERIFICATION")
  /\ txState' = "RECORDING"
  /\ orderId' = orderId
  /\ amountCents' = amountCents
  /\ transferId' = transferId
  /\ declineCode' = NONE
  /\ approvedAmountCents' = approvedAmount
  /\ paymentId' = NONE

\* TapDeclined: AWAITING_TAP → DECLINED or AWAITING_VERIFICATION → DECLINED
\* Card declined; records decline code
TapDeclined(code) ==
  /\ code \in DeclineCodes \cup {NONE}
  /\ (txState = "AWAITING_TAP" \/ txState = "AWAITING_VERIFICATION")
  /\ txState' = "DECLINED"
  /\ orderId' = orderId
  /\ amountCents' = amountCents
  /\ transferId' = transferId
  /\ declineCode' = code
  /\ approvedAmountCents' = NOAMT
  /\ paymentId' = NONE

\* PaymentRecorded: RECORDING → COMPLETED
\* Payment row written to database; records payment ID
PaymentRecorded(payment) ==
  /\ txState = "RECORDING"
  /\ payment \in PaymentIds \cup {NONE}
  /\ txState' = "COMPLETED"
  /\ orderId' = orderId
  /\ amountCents' = amountCents
  /\ transferId' = transferId
  /\ declineCode' = NONE
  /\ approvedAmountCents' = approvedAmountCents
  /\ paymentId' = payment

\* CancelPayment: AWAITING_TAP → CANCELLING or AWAITING_VERIFICATION → CANCELLING
\* Initiates cancellation of in-progress transaction
CancelPayment ==
  /\ (txState = "AWAITING_TAP" \/ txState = "AWAITING_VERIFICATION")
  /\ txState' = "CANCELLING"
  /\ orderId' = orderId
  /\ amountCents' = amountCents
  /\ transferId' = transferId
  /\ declineCode' = NONE
  /\ approvedAmountCents' = NOAMT
  /\ paymentId' = NONE

\* CancelConfirmed: CANCELLING → CANCELLED
\* Finix cancel API succeeded; transaction is cancelled
CancelConfirmed ==
  /\ txState = "CANCELLING"
  /\ txState' = "CANCELLED"
  /\ orderId' = orderId
  /\ amountCents' = amountCents
  /\ transferId' = transferId
  /\ declineCode' = NONE
  /\ approvedAmountCents' = NOAMT
  /\ paymentId' = NONE

\* ExitFlow: COMPLETED → IDLE or DECLINED → IDLE or CANCELLED → IDLE
\* Resets workflow to idle state for next transaction
ExitFlow ==
  /\ (txState = "COMPLETED" \/ txState = "DECLINED" \/ txState = "CANCELLED")
  /\ txState' = "IDLE"
  /\ orderId' = NONE
  /\ amountCents' = NOAMT
  /\ transferId' = NONE
  /\ declineCode' = NONE
  /\ approvedAmountCents' = NOAMT
  /\ paymentId' = NONE

\* Next: any enabled action
Next ==
  \/ \E order \in OrderIds, amount \in Amounts : InitiatePayment(order, amount)
  \/ \E transfer \in TransferIds : TransferCreated(transfer)
  \/ VerificationStarted
  \/ \E approvedAmount \in Amounts : TapApproved(approvedAmount)
  \/ \E code \in DeclineCodes \cup {NONE} : TapDeclined(code)
  \/ \E payment \in PaymentIds \cup {NONE} : PaymentRecorded(payment)
  \/ CancelPayment
  \/ CancelConfirmed
  \/ ExitFlow

Spec == Init /\ [][Next]_vars

====