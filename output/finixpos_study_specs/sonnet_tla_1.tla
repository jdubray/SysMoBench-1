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

TypeOK ==
  /\ txState             \in TxStates
  /\ orderId             \in OrderIds \cup {NONE}
  /\ amountCents         \in Amounts  \cup {NOAMT}
  /\ transferId          \in TransferIds \cup {NONE}
  /\ declineCode         \in DeclineCodes \cup {NONE}
  /\ approvedAmountCents \in Amounts  \cup {NOAMT}
  /\ paymentId           \in PaymentIds \cup {NONE}

Init ==
  /\ txState             = "IDLE"
  /\ orderId             = NONE
  /\ amountCents         = NOAMT
  /\ transferId          = NONE
  /\ declineCode         = NONE
  /\ approvedAmountCents = NOAMT
  /\ paymentId           = NONE

\* INITIATE_PAYMENT: only accepted from IDLE; clears all transaction fields.
InitiatePayment(order, amount) ==
  /\ txState = "IDLE"
  /\ order   \in OrderIds
  /\ amount  \in Amounts
  /\ txState'             = "INITIATING"
  /\ orderId'             = order
  /\ amountCents'         = amount
  /\ transferId'          = NONE
  /\ declineCode'         = NONE
  /\ approvedAmountCents' = NOAMT
  /\ paymentId'           = NONE

\* TRANSFER_CREATED: only accepted from INITIATING; records the transfer id.
TransferCreated(transfer) ==
  /\ txState  = "INITIATING"
  /\ transfer \in TransferIds
  /\ txState'             = "AWAITING_TAP"
  /\ transferId'          = transfer
  /\ orderId'             = orderId
  /\ amountCents'         = amountCents
  /\ declineCode'         = NONE
  /\ approvedAmountCents' = NOAMT
  /\ paymentId'           = NONE

\* VERIFICATION_STARTED: only accepted from INITIATING.
VerificationStarted ==
  /\ txState = "INITIATING"
  /\ txState'             = "AWAITING_VERIFICATION"
  /\ orderId'             = orderId
  /\ amountCents'         = amountCents
  /\ transferId'          = transferId
  /\ declineCode'         = NONE
  /\ approvedAmountCents' = NOAMT
  /\ paymentId'           = NONE

\* TAP_APPROVED: accepted from AWAITING_TAP, AWAITING_VERIFICATION, or CANCELLING.
\*
\* From AWAITING_TAP or AWAITING_VERIFICATION: advance to RECORDING, record
\* approvedAmount.  The partial-payment guard (approvedAmount < amountCents)
\* is handled by TapDeclined in the source; here TapApproved only fires when
\* the amount is valid (the harness will call TapDeclined for partial cases).
\*
\* From CANCELLING (tap beat cancel): advance to RECORDING.
\*
\* From RECORDING or COMPLETED: silently discard (enforceAllowedTransitions
\* drops the action; observable state is unchanged).
\*
\* From any other state: no-op (UNCHANGED).
TapApproved(approvedAmount) ==
  /\ approvedAmount \in Amounts
  /\
    \/ \* Normal approval from AWAITING_TAP
       /\ txState = "AWAITING_TAP"
       /\ txState'             = "RECORDING"
       /\ approvedAmountCents' = approvedAmount
       /\ orderId'             = orderId
       /\ amountCents'         = amountCents
       /\ transferId'          = transferId
       /\ declineCode'         = NONE
       /\ paymentId'           = NONE
    \/ \* Approval from AWAITING_VERIFICATION
       /\ txState = "AWAITING_VERIFICATION"
       /\ txState'             = "RECORDING"
       /\ approvedAmountCents' = approvedAmount
       /\ orderId'             = orderId
       /\ amountCents'         = amountCents
       /\ transferId'          = transferId
       /\ declineCode'         = NONE
       /\ paymentId'           = NONE
    \/ \* Tap beat cancel — advance to RECORDING
       /\ txState = "CANCELLING"
       /\ txState'             = "RECORDING"
       /\ approvedAmountCents' = approvedAmount
       /\ orderId'             = orderId
       /\ amountCents'         = amountCents
       /\ transferId'          = transferId
       /\ declineCode'         = NONE
       /\ paymentId'           = NONE
    \/ \* Anti-glitch: silently discard in RECORDING
       /\ txState = "RECORDING"
       /\ UNCHANGED vars
    \/ \* Anti-glitch: silently discard in COMPLETED
       /\ txState = "COMPLETED"
       /\ UNCHANGED vars

\* TAP_DECLINED: accepted from AWAITING_TAP, AWAITING_VERIFICATION, INITIATING,
\* or CANCELLING (where it is rewritten to CANCEL_DECLINED → CANCELLED).
\*
\* From RECORDING or COMPLETED: silently discard.
TapDeclined(code) ==
  /\ code \in DeclineCodes \cup {NONE}
  /\
    \/ \* Decline from AWAITING_TAP → DECLINED
       /\ txState = "AWAITING_TAP"
       /\ txState'             = "DECLINED"
       /\ declineCode'         = code
       /\ orderId'             = orderId
       /\ amountCents'         = amountCents
       /\ transferId'          = transferId
       /\ approvedAmountCents' = NOAMT
       /\ paymentId'           = NONE
    \/ \* Decline from AWAITING_VERIFICATION → DECLINED
       /\ txState = "AWAITING_VERIFICATION"
       /\ txState'             = "DECLINED"
       /\ declineCode'         = code
       /\ orderId'             = orderId
       /\ amountCents'         = amountCents
       /\ transferId'          = transferId
       /\ approvedAmountCents' = NOAMT
       /\ paymentId'           = NONE
    \/ \* Decline from INITIATING → DECLINED
       /\ txState = "INITIATING"
       /\ txState'             = "DECLINED"
       /\ declineCode'         = code
       /\ orderId'             = orderId
       /\ amountCents'         = amountCents
       /\ transferId'          = transferId
       /\ approvedAmountCents' = NOAMT
       /\ paymentId'           = NONE
    \/ \* CANCELLING + TAP_DECLINED → rewritten to CANCEL_DECLINED → CANCELLED
       /\ txState = "CANCELLING"
       /\ txState'             = "CANCELLED"
       /\ declineCode'         = code
       /\ orderId'             = orderId
       /\ amountCents'         = amountCents
       /\ transferId'          = transferId
       /\ approvedAmountCents' = NOAMT
       /\ paymentId'           = NONE
    \/ \* Anti-glitch: silently discard in RECORDING
       /\ txState = "RECORDING"
       /\ UNCHANGED vars
    \/ \* Anti-glitch: silently discard in COMPLETED
       /\ txState = "COMPLETED"
       /\ UNCHANGED vars

\* PAYMENT_RECORDED: only accepted from RECORDING; advances to COMPLETED.
PaymentRecorded(payment) ==
  /\ txState = "RECORDING"
  /\ payment \in PaymentIds \cup {NONE}
  /\ txState'             = "COMPLETED"
  /\ paymentId'           = payment
  /\ orderId'             = orderId
  /\ amountCents'         = amountCents
  /\ transferId'          = transferId
  /\ declineCode'         = declineCode
  /\ approvedAmountCents' = approvedAmountCents

\* CANCEL_PAYMENT: accepted from INITIATING, AWAITING_TAP.
CancelPayment ==
  /\
    \/ txState = "INITIATING"
    \/ txState = "AWAITING_TAP"
  /\ txState'             = "CANCELLING"
  /\ orderId'             = orderId
  /\ amountCents'         = amountCents
  /\ transferId'          = transferId
  /\ declineCode'         = declineCode
  /\ approvedAmountCents' = approvedAmountCents
  /\ paymentId'           = paymentId

\* CANCEL_CONFIRMED: accepted from CANCELLING; advances to CANCELLED.
CancelConfirmed ==
  /\ txState = "CANCELLING"
  /\ txState'             = "CANCELLED"
  /\ orderId'             = orderId
  /\ amountCents'         = amountCents
  /\ transferId'          = transferId
  /\ declineCode'         = declineCode
  /\ approvedAmountCents' = approvedAmountCents
  /\ paymentId'           = paymentId

\* EXIT_FLOW: accepted from COMPLETED, DECLINED, or CANCELLED; resets to IDLE.
ExitFlow ==
  /\
    \/ txState = "COMPLETED"
    \/ txState = "DECLINED"
    \/ txState = "CANCELLED"
  /\ txState'             = "IDLE"
  /\ orderId'             = NONE
  /\ amountCents'         = NOAMT
  /\ transferId'          = NONE
  /\ declineCode'         = NONE
  /\ approvedAmountCents' = NOAMT
  /\ paymentId'           = NONE

Next ==
  \/ \E order \in OrderIds, amount \in Amounts :
       InitiatePayment(order, amount)
  \/ \E transfer \in TransferIds :
       TransferCreated(transfer)
  \/ VerificationStarted
  \/ \E approvedAmount \in Amounts :
       TapApproved(approvedAmount)
  \/ \E code \in DeclineCodes \cup {NONE} :
       TapDeclined(code)
  \/ \E payment \in PaymentIds \cup {NONE} :
       PaymentRecorded(payment)
  \/ CancelPayment
  \/ CancelConfirmed
  \/ ExitFlow

Spec == Init /\ [][Next]_vars

====