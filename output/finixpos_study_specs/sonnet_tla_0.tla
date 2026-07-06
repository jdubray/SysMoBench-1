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
\*   - From AWAITING_TAP / AWAITING_VERIFICATION: advance to RECORDING.
\*   - From CANCELLING (tap beat cancel): advance to RECORDING.
\*   - From RECORDING or COMPLETED: silently discarded (enforceAllowedTransitions).
\*   - Partial-payment guard: if approvedAmount < amountCents the pre-FSM acceptor
\*     rewrites the action to TAP_DECLINED; modelled here as a no-op (the harness
\*     will fire TapDeclined with PARTIAL_PAYMENT instead).
TapApproved(approvedAmount) ==
  /\ approvedAmount \in Amounts
  /\ \/ \* Normal tap-approved path (AWAITING_TAP or AWAITING_VERIFICATION)
        /\ txState \in {"AWAITING_TAP", "AWAITING_VERIFICATION"}
        /\ approvedAmount >= amountCents   \* partial-payment guard: only advance when not partial
        /\ txState'             = "RECORDING"
        /\ approvedAmountCents' = approvedAmount
        /\ orderId'             = orderId
        /\ amountCents'         = amountCents
        /\ transferId'          = transferId
        /\ declineCode'         = declineCode
        /\ paymentId'           = paymentId
     \/ \* Tap beat cancel (CANCELLING)
        /\ txState = "CANCELLING"
        /\ txState'             = "RECORDING"
        /\ approvedAmountCents' = approvedAmount
        /\ orderId'             = orderId
        /\ amountCents'         = amountCents
        /\ transferId'          = transferId
        /\ declineCode'         = declineCode
        /\ paymentId'           = paymentId
     \/ \* Silent discard from RECORDING or COMPLETED
        /\ txState \in {"RECORDING", "COMPLETED"}
        /\ UNCHANGED vars

\* TAP_DECLINED: accepted from AWAITING_TAP, AWAITING_VERIFICATION, INITIATING,
\*   or CANCELLING (where the pre-FSM acceptor rewrites it to CANCEL_DECLINED → CANCELLED).
\*   - From AWAITING_TAP / AWAITING_VERIFICATION / INITIATING: advance to DECLINED.
\*   - From CANCELLING: advance to CANCELLED (CANCEL_DECLINED rewrite).
\*   - From RECORDING or COMPLETED: silently discarded.
TapDeclined(code) ==
  /\ code \in DeclineCodes \cup {NONE}
  /\ \/ \* Normal decline path
        /\ txState \in {"AWAITING_TAP", "AWAITING_VERIFICATION", "INITIATING"}
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
     \/ \* Silent discard from RECORDING or COMPLETED
        /\ txState \in {"RECORDING", "COMPLETED"}
        /\ UNCHANGED vars

\* PAYMENT_RECORDED: only accepted from RECORDING; advances to COMPLETED.
\* payment may be NONE when recordLocally=false (dashboard flow defers to /record-payment).
PaymentRecorded(payment) ==
  /\ txState  = "RECORDING"
  /\ payment  \in PaymentIds \cup {NONE}
  /\ txState'             = "COMPLETED"
  /\ paymentId'           = payment
  /\ orderId'             = orderId
  /\ amountCents'         = amountCents
  /\ transferId'          = transferId
  /\ declineCode'         = declineCode
  /\ approvedAmountCents' = approvedAmountCents

\* CANCEL_PAYMENT: accepted from INITIATING, AWAITING_TAP.
\* Moves to CANCELLING; the cancel NAP then calls Finix asynchronously.
CancelPayment ==
  /\ txState \in {"INITIATING", "AWAITING_TAP"}
  /\ txState'             = "CANCELLING"
  /\ orderId'             = orderId
  /\ amountCents'         = amountCents
  /\ transferId'          = transferId
  /\ declineCode'         = declineCode
  /\ approvedAmountCents' = approvedAmountCents
  /\ paymentId'           = paymentId

\* CANCEL_CONFIRMED: only accepted from CANCELLING; advances to CANCELLED.
\* Finix confirmed the cancel (transfer was not SUCCEEDED).
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
\* Resets all transaction fields and returns to IDLE.
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