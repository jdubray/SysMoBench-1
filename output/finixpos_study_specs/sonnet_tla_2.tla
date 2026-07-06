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

\* INITIATE_PAYMENT: only accepted from IDLE; clears all transaction fields
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

\* TRANSFER_CREATED: only accepted from INITIATING; records the Finix transfer id
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
\* failed after all retries — outcome unknown until orphan sweep resolves
VerificationStarted ==
  /\ txState = "INITIATING"
  /\ txState'             = "AWAITING_VERIFICATION"
  /\ orderId'             = orderId
  /\ amountCents'         = amountCents
  /\ transferId'          = transferId
  /\ declineCode'         = declineCode
  /\ approvedAmountCents' = approvedAmountCents
  /\ paymentId'           = paymentId

\* TAP_APPROVED:
\*   AWAITING_TAP      -> RECORDING  (normal happy path)
\*   AWAITING_VERIFICATION -> RECORDING (orphan sweep resolved approved)
\*   CANCELLING        -> RECORDING  (tap beat the cancel)
\*   RECORDING/COMPLETED -> silently discarded (anti-glitch invariant)
\*   Any other state   -> silently discarded
TapApproved(approvedAmount) ==
  /\ approvedAmount \in Amounts
  /\ \/ \* Accepted states: advance to RECORDING
        /\ txState \in {"AWAITING_TAP", "AWAITING_VERIFICATION", "CANCELLING"}
        /\ \* Partial-payment guard: if approvedAmount < amountCents while in
           \* AWAITING_TAP, the pre-FSM acceptor rewrites to TAP_DECLINED
           \* (PARTIAL_PAYMENT). We model the observable outcome: when the
           \* guard fires the state goes to DECLINED, not RECORDING.
           \* The guard only applies in AWAITING_TAP; CANCELLING and
           \* AWAITING_VERIFICATION pass through unconditionally.
           \/ /\ txState = "AWAITING_TAP"
              /\ approvedAmount >= amountCents
              /\ txState'             = "RECORDING"
              /\ approvedAmountCents' = approvedAmount
              /\ orderId'             = orderId
              /\ amountCents'         = amountCents
              /\ transferId'          = transferId
              /\ declineCode'         = declineCode
              /\ paymentId'           = paymentId
           \/ /\ txState = "AWAITING_TAP"
              /\ approvedAmount < amountCents
              \* Pre-FSM acceptor rewrites to TAP_DECLINED with PARTIAL_PAYMENT
              /\ txState'             = "DECLINED"
              /\ declineCode'         = "PARTIAL_PAYMENT"
              /\ orderId'             = orderId
              /\ amountCents'         = amountCents
              /\ transferId'          = transferId
              /\ approvedAmountCents' = approvedAmountCents
              /\ paymentId'           = paymentId
           \/ /\ txState \in {"AWAITING_VERIFICATION", "CANCELLING"}
              /\ txState'             = "RECORDING"
              /\ approvedAmountCents' = approvedAmount
              /\ orderId'             = orderId
              /\ amountCents'         = amountCents
              /\ transferId'          = transferId
              /\ declineCode'         = declineCode
              /\ paymentId'           = paymentId
     \/ \* Silently discarded states (RECORDING, COMPLETED, and any other)
        /\ txState \notin {"AWAITING_TAP", "AWAITING_VERIFICATION", "CANCELLING"}
        /\ UNCHANGED vars

\* TAP_DECLINED:
\*   AWAITING_TAP          -> DECLINED  (normal decline path)
\*   AWAITING_VERIFICATION -> DECLINED  (orphan sweep resolved declined)
\*   INITIATING            -> DECLINED  (immediate failure from createTerminalSale)
\*   CANCELLING            -> CANCELLED (pre-FSM acceptor rewrites to CANCEL_DECLINED)
\*   RECORDING/COMPLETED   -> silently discarded (anti-glitch invariant)
\*   Any other state       -> silently discarded
TapDeclined(code) ==
  /\ code \in DeclineCodes \cup {NONE}
  /\ \/ /\ txState \in {"AWAITING_TAP", "AWAITING_VERIFICATION", "INITIATING"}
        /\ txState'             = "DECLINED"
        /\ declineCode'         = code
        /\ orderId'             = orderId
        /\ amountCents'         = amountCents
        /\ transferId'          = transferId
        /\ approvedAmountCents' = approvedAmountCents
        /\ paymentId'           = paymentId
     \/ \* CANCELLING + TAP_DECLINED -> CANCELLED (CANCEL_DECLINED rewrite)
        /\ txState = "CANCELLING"
        /\ txState'             = "CANCELLED"
        /\ declineCode'         = code
        /\ orderId'             = orderId
        /\ amountCents'         = amountCents
        /\ transferId'          = transferId
        /\ approvedAmountCents' = approvedAmountCents
        /\ paymentId'           = paymentId
     \/ \* Silently discarded
        /\ txState \notin {"AWAITING_TAP", "AWAITING_VERIFICATION",
                           "INITIATING", "CANCELLING"}
        /\ UNCHANGED vars

\* PAYMENT_RECORDED: only accepted from RECORDING; records the payment id
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

\* CANCEL_PAYMENT: accepted from INITIATING, AWAITING_TAP
CancelPayment ==
  /\ txState \in {"INITIATING", "AWAITING_TAP"}
  /\ txState'             = "CANCELLING"
  /\ orderId'             = orderId
  /\ amountCents'         = amountCents
  /\ transferId'          = transferId
  /\ declineCode'         = declineCode
  /\ approvedAmountCents' = approvedAmountCents
  /\ paymentId'           = paymentId

\* CANCEL_CONFIRMED: only accepted from CANCELLING; no tap arrived before cancel
CancelConfirmed ==
  /\ txState = "CANCELLING"
  /\ txState'             = "CANCELLED"
  /\ orderId'             = orderId
  /\ amountCents'         = amountCents
  /\ transferId'          = transferId
  /\ declineCode'         = declineCode
  /\ approvedAmountCents' = approvedAmountCents
  /\ paymentId'           = paymentId

\* EXIT_FLOW: accepted from COMPLETED, DECLINED, CANCELLED; resets to IDLE
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