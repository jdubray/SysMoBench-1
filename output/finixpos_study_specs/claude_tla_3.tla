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
  /\ orderId             \in (OrderIds \cup {NONE})
  /\ amountCents         \in (Amounts \cup {NOAMT})
  /\ transferId          \in (TransferIds \cup {NONE})
  /\ declineCode         \in (DeclineCodes \cup {NONE})
  /\ approvedAmountCents \in (Amounts \cup {NOAMT})
  /\ paymentId           \in (PaymentIds \cup {NONE})

Init ==
  /\ txState             = "IDLE"
  /\ orderId             = NONE
  /\ amountCents         = NOAMT
  /\ transferId          = NONE
  /\ declineCode         = NONE
  /\ approvedAmountCents = NOAMT
  /\ paymentId           = NONE

\* INITIATE_PAYMENT: only accepted from IDLE (FSM: IDLE -> INITIATING).
\* Clears all transaction fields, sets orderId and amountCents.
InitiatePayment(order, amount) ==
  IF txState = "IDLE"
  THEN /\ txState'             = "INITIATING"
       /\ orderId'             = order
       /\ amountCents'         = amount
       /\ transferId'          = NONE
       /\ declineCode'         = NONE
       /\ approvedAmountCents' = NOAMT
       /\ paymentId'           = NONE
  ELSE UNCHANGED vars

\* TRANSFER_CREATED: internal action, only from INITIATING (-> AWAITING_TAP).
TransferCreated(transfer) ==
  IF txState = "INITIATING"
  THEN /\ txState'    = "AWAITING_TAP"
       /\ transferId' = transfer
       /\ UNCHANGED <<orderId, amountCents, declineCode,
                      approvedAmountCents, paymentId>>
  ELSE UNCHANGED vars

\* VERIFICATION_STARTED: only from INITIATING (-> AWAITING_VERIFICATION).
VerificationStarted ==
  IF txState = "INITIATING"
  THEN /\ txState' = "AWAITING_VERIFICATION"
       /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                      approvedAmountCents, paymentId>>
  ELSE UNCHANGED vars

\* TAP_APPROVED:
\*   - From AWAITING_TAP: partial-payment guard — approved < amountCents is
\*     rewritten to TAP_DECLINED with declineCode='PARTIAL_PAYMENT' (-> DECLINED).
\*     Otherwise -> RECORDING, capturing approvedAmountCents.
\*   - From AWAITING_VERIFICATION: -> RECORDING (no partial guard here).
\*   - From CANCELLING: tap-beat-cancel -> RECORDING.
\*   - RECORDING / COMPLETED: silently discarded (anti-glitch invariant).
\*   - Any other state: no-op.
TapApproved(approvedAmount) ==
  IF txState = "AWAITING_TAP"
  THEN IF approvedAmount < amountCents
       THEN /\ txState'     = "DECLINED"
            /\ declineCode' = "PARTIAL_PAYMENT"
            /\ UNCHANGED <<orderId, amountCents, transferId,
                           approvedAmountCents, paymentId>>
       ELSE /\ txState'             = "RECORDING"
            /\ approvedAmountCents' = approvedAmount
            /\ UNCHANGED <<orderId, amountCents, transferId,
                           declineCode, paymentId>>
  ELSE IF txState = "AWAITING_VERIFICATION" \/ txState = "CANCELLING"
       THEN /\ txState'             = "RECORDING"
            /\ approvedAmountCents' = approvedAmount
            /\ UNCHANGED <<orderId, amountCents, transferId,
                           declineCode, paymentId>>
       ELSE UNCHANGED vars

\* TAP_DECLINED:
\*   - From AWAITING_TAP or AWAITING_VERIFICATION: -> DECLINED (sets declineCode).
\*   - From CANCELLING: pre-FSM acceptor rewrites to CANCEL_DECLINED (-> CANCELLED),
\*     setting declineCode.
\*   - From INITIATING: FSM allows TAP_DECLINED (-> DECLINED).
\*   - RECORDING / COMPLETED: silently discarded.
\*   - Any other state: no-op.
TapDeclined(code) ==
  IF txState = "AWAITING_TAP" \/ txState = "AWAITING_VERIFICATION"
     \/ txState = "INITIATING"
  THEN /\ txState'     = "DECLINED"
       /\ declineCode' = code
       /\ UNCHANGED <<orderId, amountCents, transferId,
                      approvedAmountCents, paymentId>>
  ELSE IF txState = "CANCELLING"
       THEN /\ txState'     = "CANCELLED"
            /\ declineCode' = code
            /\ UNCHANGED <<orderId, amountCents, transferId,
                           approvedAmountCents, paymentId>>
       ELSE UNCHANGED vars

\* PAYMENT_RECORDED: only from RECORDING (-> COMPLETED), sets paymentId.
PaymentRecorded(payment) ==
  IF txState = "RECORDING"
  THEN /\ txState'   = "COMPLETED"
       /\ paymentId' = payment
       /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                      approvedAmountCents>>
  ELSE UNCHANGED vars

\* CANCEL_PAYMENT: from INITIATING or AWAITING_TAP (-> CANCELLING).
CancelPayment ==
  IF txState = "INITIATING" \/ txState = "AWAITING_TAP"
  THEN /\ txState' = "CANCELLING"
       /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                      approvedAmountCents, paymentId>>
  ELSE UNCHANGED vars

\* CANCEL_CONFIRMED: only from CANCELLING (-> CANCELLED).
CancelConfirmed ==
  IF txState = "CANCELLING"
  THEN /\ txState' = "CANCELLED"
       /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                      approvedAmountCents, paymentId>>
  ELSE UNCHANGED vars

\* EXIT_FLOW: only from terminal states COMPLETED / DECLINED / CANCELLED
\* (-> IDLE); resets all transaction fields to sentinels.
ExitFlow ==
  IF txState = "COMPLETED" \/ txState = "DECLINED" \/ txState = "CANCELLED"
  THEN /\ txState'             = "IDLE"
       /\ orderId'             = NONE
       /\ amountCents'         = NOAMT
       /\ transferId'          = NONE
       /\ declineCode'         = NONE
       /\ approvedAmountCents' = NOAMT
       /\ paymentId'           = NONE
  ELSE UNCHANGED vars

Next ==
  \/ \E o \in OrderIds, a \in Amounts : InitiatePayment(o, a)
  \/ \E t \in TransferIds : TransferCreated(t)
  \/ VerificationStarted
  \/ \E a \in Amounts : TapApproved(a)
  \/ \E c \in (DeclineCodes \cup {NONE}) : TapDeclined(c)
  \/ \E p \in (PaymentIds \cup {NONE}) : PaymentRecorded(p)
  \/ CancelPayment
  \/ CancelConfirmed
  \/ ExitFlow

Spec == Init /\ [][Next]_vars

====