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

\* TRANSFER_CREATED: only accepted from INITIATING; records the Finix transfer id.
TransferCreated(transfer) ==
  /\ txState  = "INITIATING"
  /\ transfer \in TransferIds
  /\ txState'             = "AWAITING_TAP"
  /\ transferId'          = transfer
  /\ orderId'             = orderId
  /\ amountCents'         = amountCents
  /\ declineCode'         = declineCode
  /\ approvedAmountCents' = approvedAmountCents
  /\ paymentId'           = paymentId

\* VERIFICATION_STARTED: only accepted from INITIATING; no field changes beyond state.
VerificationStarted ==
  /\ txState = "INITIATING"
  /\ txState'             = "AWAITING_VERIFICATION"
  /\ orderId'             = orderId
  /\ amountCents'         = amountCents
  /\ transferId'          = transferId
  /\ declineCode'         = declineCode
  /\ approvedAmountCents' = approvedAmountCents
  /\ paymentId'           = paymentId

\* TAP_APPROVED: accepted from AWAITING_TAP, AWAITING_VERIFICATION, or CANCELLING.
\*
\* From AWAITING_TAP or AWAITING_VERIFICATION: advance to RECORDING, record approved amount.
\* From CANCELLING (tap beat cancel): advance to RECORDING, record approved amount.
\* From RECORDING or COMPLETED: silently discard (enforceAllowedTransitions anti-glitch).
\* From any other state: silently discard.
\*
\* Partial-payment guard: if approvedAmount < amountCents while in AWAITING_TAP,
\* the pre-FSM acceptor rewrites the action to TAP_DECLINED with PARTIAL_PAYMENT.
\* We model this as: TapApproved from AWAITING_TAP with approvedAmount < amountCents
\* behaves identically to TapDeclined("PARTIAL_PAYMENT").
TapApproved(approvedAmount) ==
  /\ approvedAmount \in Amounts
  /\
    \/ \* Normal approval from AWAITING_TAP (full or over-amount — tip-on-terminal)
       /\ txState      = "AWAITING_TAP"
       /\ approvedAmount >= amountCents
       /\ txState'             = "RECORDING"
       /\ approvedAmountCents' = approvedAmount
       /\ orderId'             = orderId
       /\ amountCents'         = amountCents
       /\ transferId'          = transferId
       /\ declineCode'         = declineCode
       /\ paymentId'           = paymentId
    \/ \* Partial-payment guard: rewritten to decline from AWAITING_TAP
       /\ txState      = "AWAITING_TAP"
       /\ approvedAmount < amountCents
       /\ txState'             = "DECLINED"
       /\ declineCode'         = "PARTIAL_PAYMENT"
       /\ orderId'             = orderId
       /\ amountCents'         = amountCents
       /\ transferId'          = transferId
       /\ approvedAmountCents' = approvedAmountCents
       /\ paymentId'           = paymentId
    \/ \* Approval from AWAITING_VERIFICATION
       /\ txState      = "AWAITING_VERIFICATION"
       /\ txState'             = "RECORDING"
       /\ approvedAmountCents' = approvedAmount
       /\ orderId'             = orderId
       /\ amountCents'         = amountCents
       /\ transferId'          = transferId
       /\ declineCode'         = declineCode
       /\ paymentId'           = paymentId
    \/ \* Tap beat cancel: approval from CANCELLING
       /\ txState      = "CANCELLING"
       /\ txState'             = "RECORDING"
       /\ approvedAmountCents' = approvedAmount
       /\ orderId'             = orderId
       /\ amountCents'         = amountCents
       /\ transferId'          = transferId
       /\ declineCode'         = declineCode
       /\ paymentId'           = paymentId
    \/ \* Anti-glitch: silently discard from RECORDING or COMPLETED
       /\ txState \in {"RECORDING", "COMPLETED"}
       /\ UNCHANGED vars

\* TAP_DECLINED: accepted from AWAITING_TAP, AWAITING_VERIFICATION, or CANCELLING.
\*
\* From AWAITING_TAP or AWAITING_VERIFICATION: advance to DECLINED, record code.
\* From CANCELLING: pre-FSM acceptor rewrites to CANCEL_DECLINED → advance to CANCELLED.
\* From RECORDING or COMPLETED: silently discard (anti-glitch invariant).
\* From any other state: silently discard.
TapDeclined(code) ==
  /\ code \in DeclineCodes \cup {NONE}
  /\
    \/ \* Normal decline from AWAITING_TAP
       /\ txState = "AWAITING_TAP"
       /\ txState'             = "DECLINED"
       /\ declineCode'         = code
       /\ orderId'             = orderId
       /\ amountCents'         = amountCents
       /\ transferId'          = transferId
       /\ approvedAmountCents' = approvedAmountCents
       /\ paymentId'           = paymentId
    \/ \* Decline from AWAITING_VERIFICATION
       /\ txState = "AWAITING_VERIFICATION"
       /\ txState'             = "DECLINED"
       /\ declineCode'         = code
       /\ orderId'             = orderId
       /\ amountCents'         = amountCents
       /\ transferId'          = transferId
       /\ approvedAmountCents' = approvedAmountCents
       /\ paymentId'           = paymentId
    \/ \* CANCELLING + TAP_DECLINED → CANCEL_DECLINED → CANCELLED
       /\ txState = "CANCELLING"
       /\ txState'             = "CANCELLED"
       /\ declineCode'         = code
       /\ orderId'             = orderId
       /\ amountCents'         = amountCents
       /\ transferId'          = transferId
       /\ approvedAmountCents' = approvedAmountCents
       /\ paymentId'           = paymentId
    \/ \* Anti-glitch: silently discard from RECORDING or COMPLETED
       /\ txState \in {"RECORDING", "COMPLETED"}
       /\ UNCHANGED vars

\* PAYMENT_RECORDED: only accepted from RECORDING; records the payment id (may be NONE).
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

\* CANCEL_PAYMENT: accepted from INITIATING, AWAITING_TAP, or AWAITING_VERIFICATION.
\* No observable field changes beyond txState.
CancelPayment ==
  /\ txState \in {"INITIATING", "AWAITING_TAP", "AWAITING_VERIFICATION"}
  /\ txState'             = "CANCELLING"
  /\ orderId'             = orderId
  /\ amountCents'         = amountCents
  /\ transferId'          = transferId
  /\ declineCode'         = declineCode
  /\ approvedAmountCents' = approvedAmountCents
  /\ paymentId'           = paymentId

\* CANCEL_CONFIRMED: only accepted from CANCELLING; advances to CANCELLED.
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
  /\ txState \in {"COMPLETED", "DECLINED", "CANCELLED"}
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