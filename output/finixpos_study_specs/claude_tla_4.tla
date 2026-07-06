---- MODULE finixpos ----
EXTENDS Integers

CONSTANTS OrderIds, Amounts, TransferIds, DeclineCodes, PaymentIds

VARIABLES txState, orderId, amountCents, transferId, declineCode,
          approvedAmountCents, paymentId

NONE  == "none"
NOAMT == -1

TxStates == { "IDLE", "INITIATING", "AWAITING_TAP", "AWAITING_VERIFICATION",
              "RECORDING", "COMPLETED", "DECLINED", "CANCELLING", "CANCELLED" }

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

\* ── INITIATE_PAYMENT: only from IDLE (FSM rejects otherwise) ────────────────
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

\* ── TRANSFER_CREATED: internal, only from INITIATING ────────────────────────
TransferCreated(transfer) ==
  IF txState = "INITIATING"
  THEN /\ txState'    = "AWAITING_TAP"
       /\ transferId' = transfer
       /\ UNCHANGED <<orderId, amountCents, declineCode,
                      approvedAmountCents, paymentId>>
  ELSE UNCHANGED vars

\* ── VERIFICATION_STARTED: only from INITIATING ──────────────────────────────
VerificationStarted ==
  IF txState = "INITIATING"
  THEN /\ txState' = "AWAITING_VERIFICATION"
       /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                      approvedAmountCents, paymentId>>
  ELSE UNCHANGED vars

\* ── TAP_APPROVED ────────────────────────────────────────────────────────────
\* AWAITING_TAP: partial-payment guard rewrites approved < amountCents to
\*   TAP_DECLINED with declineCode='PARTIAL_PAYMENT' (→ DECLINED); otherwise
\*   → RECORDING with approvedAmountCents set.
\* AWAITING_VERIFICATION: → RECORDING (no partial guard on this path).
\* CANCELLING: tap beat cancel → RECORDING.
\* RECORDING / COMPLETED: anti-glitch — silently discarded.
TapApproved(approvedAmount) ==
  IF txState = "AWAITING_TAP" /\ approvedAmount < amountCents
  THEN /\ txState'             = "DECLINED"
       /\ declineCode'         = "PARTIAL_PAYMENT"
       /\ UNCHANGED <<orderId, amountCents, transferId,
                      approvedAmountCents, paymentId>>
  ELSE IF txState \in {"AWAITING_TAP", "AWAITING_VERIFICATION", "CANCELLING"}
  THEN /\ txState'             = "RECORDING"
       /\ approvedAmountCents' = approvedAmount
       /\ UNCHANGED <<orderId, amountCents, transferId, declineCode, paymentId>>
  ELSE UNCHANGED vars

\* ── TAP_DECLINED ────────────────────────────────────────────────────────────
\* AWAITING_TAP / AWAITING_VERIFICATION: → DECLINED.
\* CANCELLING: pre-FSM acceptor rewrites to CANCEL_DECLINED → CANCELLED.
\* RECORDING / COMPLETED: anti-glitch — silently discarded.
TapDeclined(code) ==
  IF txState \in {"AWAITING_TAP", "AWAITING_VERIFICATION"}
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

\* ── PAYMENT_RECORDED: only from RECORDING ───────────────────────────────────
PaymentRecorded(payment) ==
  IF txState = "RECORDING"
  THEN /\ txState'   = "COMPLETED"
       /\ paymentId' = payment
       /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                      approvedAmountCents>>
  ELSE UNCHANGED vars

\* ── CANCEL_PAYMENT: from INITIATING or AWAITING_TAP ─────────────────────────
CancelPayment ==
  IF txState \in {"INITIATING", "AWAITING_TAP"}
  THEN /\ txState' = "CANCELLING"
       /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                      approvedAmountCents, paymentId>>
  ELSE UNCHANGED vars

\* ── CANCEL_CONFIRMED: only from CANCELLING ──────────────────────────────────
CancelConfirmed ==
  IF txState = "CANCELLING"
  THEN /\ txState' = "CANCELLED"
       /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                      approvedAmountCents, paymentId>>
  ELSE UNCHANGED vars

\* ── EXIT_FLOW: from terminal states → IDLE, clearing transaction fields ─────
ExitFlow ==
  IF txState \in {"COMPLETED", "DECLINED", "CANCELLED"}
  THEN /\ txState'             = "IDLE"
       /\ orderId'             = NONE
       /\ amountCents'         = NOAMT
       /\ transferId'          = NONE
       /\ declineCode'         = NONE
       /\ approvedAmountCents' = NOAMT
       /\ paymentId'           = NONE
  ELSE UNCHANGED vars

Next ==
  \/ \E o \in OrderIds, a \in Amounts   : InitiatePayment(o, a)
  \/ \E t \in TransferIds               : TransferCreated(t)
  \/ VerificationStarted
  \/ \E a \in Amounts                   : TapApproved(a)
  \/ \E c \in (DeclineCodes \cup {NONE}): TapDeclined(c)
  \/ \E p \in (PaymentIds \cup {NONE})  : PaymentRecorded(p)
  \/ CancelPayment
  \/ CancelConfirmed
  \/ ExitFlow

Spec == Init /\ [][Next]_vars

====