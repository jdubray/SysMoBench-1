---- MODULE finixpos ----
EXTENDS Integers

CONSTANTS OrderIds, Amounts, TransferIds, DeclineCodes, PaymentIds

VARIABLES txState, orderId, amountCents, transferId, declineCode,
          approvedAmountCents, paymentId

TxStates == { "IDLE", "INITIATING", "AWAITING_TAP", "AWAITING_VERIFICATION",
              "RECORDING", "COMPLETED", "DECLINED", "CANCELLING", "CANCELLED" }

NONE == "none"
NOAMT == -1

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
\* Stores order and amount; clears transaction fields
InitiatePayment(order, amount) ==
  /\ txState = "IDLE"
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
  /\ txState' = "AWAITING_TAP"
  /\ transferId' = transfer
  /\ orderId' = orderId
  /\ amountCents' = amountCents
  /\ declineCode' = NONE
  /\ approvedAmountCents' = NOAMT
  /\ paymentId' = NONE

\* VerificationStarted: INITIATING → AWAITING_VERIFICATION
\* Finix API call failed; awaiting orphan sweep resolution
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
\* Card approved; records approved amount and transitions to recording
TapApproved(approvedAmount) ==
  /\ (txState = "AWAITING_TAP" \/ txState = "AWAITING_VERIFICATION")
  /\ txState' = "RECORDING"
  /\ approvedAmountCents' = approvedAmount
  /\ orderId' = orderId
  /\ amountCents' = amountCents
  /\ transferId' = transferId
  /\ declineCode' = NONE
  /\ paymentId' = NONE

\* TapDeclined: AWAITING_TAP → DECLINED or AWAITING_VERIFICATION → DECLINED
\* Card declined; records decline code
TapDeclined(code) ==
  /\ (txState = "AWAITING_TAP" \/ txState = "AWAITING_VERIFICATION")
  /\ txState' = "DECLINED"
  /\ declineCode' = code
  /\ orderId' = orderId
  /\ amountCents' = amountCents
  /\ transferId' = transferId
  /\ approvedAmountCents' = NOAMT
  /\ paymentId' = NONE

\* PaymentRecorded: RECORDING → COMPLETED
\* Payment row written to database
PaymentRecorded(payment) ==
  /\ txState = "RECORDING"
  /\ txState' = "COMPLETED"
  /\ paymentId' = payment
  /\ orderId' = orderId
  /\ amountCents' = amountCents
  /\ transferId' = transferId
  /\ declineCode' = NONE
  /\ approvedAmountCents' = approvedAmountCents

\* CancelPayment: AWAITING_TAP → CANCELLING or AWAITING_VERIFICATION → CANCELLING
\* Initiates cancellation on the terminal
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
\* Cancel succeeded; no charge was made
CancelConfirmed ==
  /\ txState = "CANCELLING"
  /\ txState' = "CANCELLED"
  /\ declineCode' = NONE
  /\ orderId' = orderId
  /\ amountCents' = amountCents
  /\ transferId' = transferId
  /\ approvedAmountCents' = NOAMT
  /\ paymentId' = NONE

\* ExitFlow: terminal state → IDLE
\* Resets the workflow to idle after a completed, declined, or cancelled transaction
ExitFlow ==
  /\ (txState = "COMPLETED" \/ txState = "DECLINED" \/ txState = "CANCELLED")
  /\ txState' = "IDLE"
  /\ orderId' = NONE
  /\ amountCents' = NOAMT
  /\ transferId' = NONE
  /\ declineCode' = NONE
  /\ approvedAmountCents' = NOAMT
  /\ paymentId' = NONE

\* Next: any action can fire if its precondition is met
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

vars == <<txState, orderId, amountCents, transferId, declineCode,
           approvedAmountCents, paymentId>>

Spec == Init /\ [][Next]_vars

====