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
  /\ txState \in TxStates
  /\ orderId \in (OrderIds \cup {NONE})
  /\ amountCents \in (Amounts \cup {NOAMT})
  /\ transferId \in (TransferIds \cup {NONE})
  /\ declineCode \in (DeclineCodes \cup {NONE})
  /\ approvedAmountCents \in (Amounts \cup {NOAMT})
  /\ paymentId \in (PaymentIds \cup {NONE})

Init ==
  /\ txState = "IDLE"
  /\ orderId = NONE
  /\ amountCents = NOAMT
  /\ transferId = NONE
  /\ declineCode = NONE
  /\ approvedAmountCents = NOAMT
  /\ paymentId = NONE

\* INITIATE_PAYMENT: only accepted from IDLE (FSM guard). From any other
\* state the FSM rejects it and nothing changes.
InitiatePayment(order, amount) ==
  IF txState = "IDLE"
  THEN /\ txState' = "INITIATING"
       /\ orderId' = order
       /\ amountCents' = amount
       /\ transferId' = NONE
       /\ declineCode' = NONE
       /\ approvedAmountCents' = NOAMT
       /\ paymentId' = NONE
  ELSE UNCHANGED vars

\* TRANSFER_CREATED: internal action, accepted only from INITIATING → AWAITING_TAP.
TransferCreated(transfer) ==
  IF txState = "INITIATING"
  THEN /\ txState' = "AWAITING_TAP"
       /\ transferId' = transfer
       /\ UNCHANGED <<orderId, amountCents, declineCode,
                      approvedAmountCents, paymentId>>
  ELSE UNCHANGED vars

\* VERIFICATION_STARTED: accepted only from INITIATING → AWAITING_VERIFICATION.
VerificationStarted ==
  IF txState = "INITIATING"
  THEN /\ txState' = "AWAITING_VERIFICATION"
       /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                      approvedAmountCents, paymentId>>
  ELSE UNCHANGED vars

\* TAP_APPROVED. Accepted from AWAITING_TAP, AWAITING_VERIFICATION → RECORDING,
\* and from CANCELLING (tap beat cancel) → RECORDING.
\* Partial-payment guard: in AWAITING_TAP, approvedAmount < amountCents rewrites
\* to TAP_DECLINED with declineCode = PARTIAL_PAYMENT → DECLINED.
\* In RECORDING / COMPLETED the anti-glitch invariant silently discards it.
TapApproved(approvedAmount) ==
  IF txState = "AWAITING_TAP" /\ approvedAmount < amountCents
  THEN /\ txState' = "DECLINED"
       /\ declineCode' = "PARTIAL_PAYMENT"
       /\ UNCHANGED <<orderId, amountCents, transferId,
                      approvedAmountCents, paymentId>>
  ELSE IF txState \in {"AWAITING_TAP", "AWAITING_VERIFICATION", "CANCELLING"}
  THEN /\ txState' = "RECORDING"
       /\ approvedAmountCents' = approvedAmount
       /\ UNCHANGED <<orderId, amountCents, transferId, declineCode, paymentId>>
  ELSE UNCHANGED vars

\* TAP_DECLINED. From AWAITING_TAP / AWAITING_VERIFICATION / INITIATING → DECLINED.
\* From CANCELLING the pre-FSM acceptor rewrites it to CANCEL_DECLINED → CANCELLED.
\* In RECORDING / COMPLETED silently discarded (anti-glitch).
TapDeclined(code) ==
  IF txState = "CANCELLING"
  THEN /\ txState' = "CANCELLED"
       /\ declineCode' = code
       /\ UNCHANGED <<orderId, amountCents, transferId,
                      approvedAmountCents, paymentId>>
  ELSE IF txState \in {"INITIATING", "AWAITING_TAP", "AWAITING_VERIFICATION"}
  THEN /\ txState' = "DECLINED"
       /\ declineCode' = code
       /\ UNCHANGED <<orderId, amountCents, transferId,
                      approvedAmountCents, paymentId>>
  ELSE UNCHANGED vars

\* PAYMENT_RECORDED: accepted only from RECORDING → COMPLETED.
PaymentRecorded(payment) ==
  IF txState = "RECORDING"
  THEN /\ txState' = "COMPLETED"
       /\ paymentId' = payment
       /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                      approvedAmountCents>>
  ELSE UNCHANGED vars

\* CANCEL_PAYMENT: accepted from INITIATING and AWAITING_TAP → CANCELLING.
CancelPayment ==
  IF txState \in {"INITIATING", "AWAITING_TAP"}
  THEN /\ txState' = "CANCELLING"
       /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                      approvedAmountCents, paymentId>>
  ELSE UNCHANGED vars

\* CANCEL_CONFIRMED: accepted only from CANCELLING → CANCELLED.
CancelConfirmed ==
  IF txState = "CANCELLING"
  THEN /\ txState' = "CANCELLED"
       /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                      approvedAmountCents, paymentId>>
  ELSE UNCHANGED vars

\* EXIT_FLOW: accepted only from terminal states COMPLETED / DECLINED / CANCELLED
\* → IDLE, resetting all transaction fields.
ExitFlow ==
  IF txState \in {"COMPLETED", "DECLINED", "CANCELLED"}
  THEN /\ txState' = "IDLE"
       /\ orderId' = NONE
       /\ amountCents' = NOAMT
       /\ transferId' = NONE
       /\ declineCode' = NONE
       /\ approvedAmountCents' = NOAMT
       /\ paymentId' = NONE
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