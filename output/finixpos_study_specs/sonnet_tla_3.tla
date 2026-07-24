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
  /\ txState    = "IDLE"
  /\ order      \in OrderIds
  /\ amount     \in Amounts
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

\* VERIFICATION_STARTED: only accepted from INITIATING; createTerminalSale
\* failed after all retries — outcome unknown until orphan sweep resolves.
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
\* From AWAITING_TAP / AWAITING_VERIFICATION: advance to RECORDING, record
\* the approved amount.  The partial-payment guard (approvedAmount < amountCents)
\* is modelled as a silent no-op here because the pre-FSM acceptor rewrites the
\* action to TAP_DECLINED before it reaches the FSM; the trace harness will
\* emit a TapDeclined step in that case, not a TapApproved step.
\*
\* From CANCELLING (tap beat cancel): also advance to RECORDING.
\*
\* From RECORDING or COMPLETED: silently discarded (enforceAllowedTransitions
\* drops the action; observable state is unchanged).
\*
\* From any other state: silently discarded.
TapApproved(approvedAmount) ==
  /\ approvedAmount \in Amounts
  /\ \/ \* Happy path: AWAITING_TAP or AWAITING_VERIFICATION -> RECORDING
        /\ txState \in {"AWAITING_TAP", "AWAITING_VERIFICATION"}
        /\ txState'             = "RECORDING"
        /\ approvedAmountCents' = approvedAmount
        /\ orderId'             = orderId
        /\ amountCents'         = amountCents
        /\ transferId'          = transferId
        /\ declineCode'         = declineCode
        /\ paymentId'           = paymentId
     \/ \* Tap beat cancel: CANCELLING -> RECORDING
        /\ txState = "CANCELLING"
        /\ txState'             = "RECORDING"
        /\ approvedAmountCents' = approvedAmount
        /\ orderId'             = orderId
        /\ amountCents'         = amountCents
        /\ transferId'          = transferId
        /\ declineCode'         = declineCode
        /\ paymentId'           = paymentId
     \/ \* Silently discarded from RECORDING, COMPLETED, or any other state
        /\ txState \notin {"AWAITING_TAP", "AWAITING_VERIFICATION", "CANCELLING"}
        /\ UNCHANGED vars

\* TAP_DECLINED: accepted from AWAITING_TAP, AWAITING_VERIFICATION, or CANCELLING.
\*
\* From AWAITING_TAP / AWAITING_VERIFICATION: advance to DECLINED.
\* From CANCELLING: the pre-FSM acceptor rewrites this to CANCEL_DECLINED
\*   (-> CANCELLED).  We model the net observable effect directly: CANCELLING
\*   + TapDeclined -> CANCELLED (with the decline code recorded).
\* From RECORDING or COMPLETED: silently discarded.
\* From any other state: silently discarded.
TapDeclined(code) ==
  /\ code \in DeclineCodes \cup {NONE}
  /\ \/ \* Normal decline: AWAITING_TAP or AWAITING_VERIFICATION -> DECLINED
        /\ txState \in {"AWAITING_TAP", "AWAITING_VERIFICATION"}
        /\ txState'             = "DECLINED"
        /\ declineCode'         = code
        /\ orderId'             = orderId
        /\ amountCents'         = amountCents
        /\ transferId'          = transferId
        /\ approvedAmountCents' = approvedAmountCents
        /\ paymentId'           = paymentId
     \/ \* CANCELLING + TAP_DECLINED -> CANCELLED (pre-FSM rewrite to CANCEL_DECLINED)
        /\ txState = "CANCELLING"
        /\ txState'             = "CANCELLED"
        /\ declineCode'         = code
        /\ orderId'             = orderId
        /\ amountCents'         = amountCents
        /\ transferId'          = transferId
        /\ approvedAmountCents' = approvedAmountCents
        /\ paymentId'           = paymentId
     \/ \* Silently discarded from RECORDING, COMPLETED, or any other state
        /\ txState \notin {"AWAITING_TAP", "AWAITING_VERIFICATION", "CANCELLING"}
        /\ UNCHANGED vars

\* PAYMENT_RECORDED: only accepted from RECORDING; records the payment id
\* (may be NONE when recordLocally=false or DB write failed) and advances to COMPLETED.
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
\* Advances to CANCELLING; all other fields unchanged.
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
\* (The cancel NAP verified the transfer was not SUCCEEDED before calling this.)
CancelConfirmed ==
  /\ txState = "CANCELLING"
  /\ txState'             = "CANCELLED"
  /\ orderId'             = orderId
  /\ amountCents'         = amountCents
  /\ transferId'          = transferId
  /\ declineCode'         = declineCode
  /\ approvedAmountCents' = approvedAmountCents
  /\ paymentId'           = paymentId

\* EXIT_FLOW: accepted from COMPLETED, DECLINED, or CANCELLED.
\* Resets all transaction fields to sentinels and returns to IDLE.
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