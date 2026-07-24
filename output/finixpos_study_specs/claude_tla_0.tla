---- MODULE finixpos ----
EXTENDS Integers

CONSTANTS OrderIds, Amounts, TransferIds, DeclineCodes, PaymentIds

VARIABLES txState, orderId, amountCents, transferId, declineCode,
          approvedAmountCents, paymentId

vars == <<txState, orderId, amountCents, transferId, declineCode,
          approvedAmountCents, paymentId>>

NONE  == "none"
NOAMT == -1

TxStates == { "IDLE", "INITIATING", "AWAITING_TAP", "AWAITING_VERIFICATION",
              "RECORDING", "COMPLETED", "DECLINED", "CANCELLING", "CANCELLED" }

TypeOK ==
  /\ txState             \in TxStates
  /\ orderId             \in OrderIds \cup {NONE}
  /\ amountCents         \in Amounts \cup {NOAMT}
  /\ transferId          \in TransferIds \cup {NONE}
  /\ declineCode         \in DeclineCodes \cup {NONE}
  /\ approvedAmountCents \in Amounts \cup {NOAMT}
  /\ paymentId           \in PaymentIds \cup {NONE}

Init ==
  /\ txState             = "IDLE"
  /\ orderId             = NONE
  /\ amountCents         = NOAMT
  /\ transferId          = NONE
  /\ declineCode         = NONE
  /\ approvedAmountCents = NOAMT
  /\ paymentId           = NONE

\* ── INITIATE_PAYMENT: only accepted from IDLE (FSM guard) ─────────────────
InitiatePayment(order, amount) ==
  IF txState = "IDLE"
  THEN /\ txState'             = "INITIATING"
       /\ orderId'             = order
       /\ amountCents'         = amount
       /\ transferId'          = NONE
       /\ declineCode'         = NONE
       /\ approvedAmountCents' = NOAMT
       /\ paymentId'           = NONE
       /\ UNCHANGED <<>>
  ELSE UNCHANGED vars

\* ── TRANSFER_CREATED: INITIATING → AWAITING_TAP ───────────────────────────
TransferCreated(transfer) ==
  IF txState = "INITIATING"
  THEN /\ txState'    = "AWAITING_TAP"
       /\ transferId' = transfer
       /\ UNCHANGED <<orderId, amountCents, declineCode,
                      approvedAmountCents, paymentId>>
  ELSE UNCHANGED vars

\* ── VERIFICATION_STARTED: INITIATING → AWAITING_VERIFICATION ──────────────
VerificationStarted ==
  IF txState = "INITIATING"
  THEN /\ txState' = "AWAITING_VERIFICATION"
       /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                      approvedAmountCents, paymentId>>
  ELSE UNCHANGED vars

\* ── TAP_APPROVED ──────────────────────────────────────────────────────────
\* Accepted from AWAITING_TAP, AWAITING_VERIFICATION, and CANCELLING (tap beat
\* cancel). Anti-glitch: silently discarded in RECORDING/COMPLETED and other
\* states. Partial-payment guard: SUCCEEDED but approved < requested rewrites
\* to TAP_DECLINED with declineCode='PARTIAL_PAYMENT' (only in AWAITING_TAP).
TapApproved(approvedAmount) ==
  IF /\ txState = "AWAITING_TAP"
     /\ approvedAmount < amountCents
  THEN /\ txState'        = "DECLINED"
       /\ declineCode'    = "PARTIAL_PAYMENT"
       /\ UNCHANGED <<orderId, amountCents, transferId,
                      approvedAmountCents, paymentId>>
  ELSE IF txState \in {"AWAITING_TAP", "AWAITING_VERIFICATION", "CANCELLING"}
  THEN /\ txState'             = "RECORDING"
       /\ approvedAmountCents' = approvedAmount
       /\ UNCHANGED <<orderId, amountCents, transferId, declineCode, paymentId>>
  ELSE UNCHANGED vars

\* ── TAP_DECLINED ──────────────────────────────────────────────────────────
\* From INITIATING / AWAITING_TAP / AWAITING_VERIFICATION → DECLINED.
\* From CANCELLING → CANCELLED (pre-FSM acceptor rewrites to CANCEL_DECLINED).
\* Anti-glitch: discarded in RECORDING/COMPLETED and other states.
TapDeclined(code) ==
  IF txState = "CANCELLING"
  THEN /\ txState'     = "CANCELLED"
       /\ declineCode' = code
       /\ UNCHANGED <<orderId, amountCents, transferId,
                      approvedAmountCents, paymentId>>
  ELSE IF txState \in {"INITIATING", "AWAITING_TAP", "AWAITING_VERIFICATION"}
  THEN /\ txState'     = "DECLINED"
       /\ declineCode' = code
       /\ UNCHANGED <<orderId, amountCents, transferId,
                      approvedAmountCents, paymentId>>
  ELSE UNCHANGED vars

\* ── PAYMENT_RECORDED: RECORDING → COMPLETED ───────────────────────────────
PaymentRecorded(payment) ==
  IF txState = "RECORDING"
  THEN /\ txState'   = "COMPLETED"
       /\ paymentId' = payment
       /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                      approvedAmountCents>>
  ELSE UNCHANGED vars

\* ── CANCEL_PAYMENT: INITIATING / AWAITING_TAP → CANCELLING ────────────────
CancelPayment ==
  IF txState \in {"INITIATING", "AWAITING_TAP"}
  THEN /\ txState' = "CANCELLING"
       /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                      approvedAmountCents, paymentId>>
  ELSE UNCHANGED vars

\* ── CANCEL_CONFIRMED: CANCELLING → CANCELLED ──────────────────────────────
CancelConfirmed ==
  IF txState = "CANCELLING"
  THEN /\ txState' = "CANCELLED"
       /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                      approvedAmountCents, paymentId>>
  ELSE UNCHANGED vars

\* ── EXIT_FLOW: COMPLETED / DECLINED / CANCELLED → IDLE ────────────────────
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
  \/ \E o \in OrderIds, a \in Amounts : InitiatePayment(o, a)
  \/ \E t \in TransferIds : TransferCreated(t)
  \/ VerificationStarted
  \/ \E a \in Amounts : TapApproved(a)
  \/ \E c \in DeclineCodes \cup {NONE} : TapDeclined(c)
  \/ \E p \in PaymentIds \cup {NONE} : PaymentRecorded(p)
  \/ CancelPayment
  \/ CancelConfirmed
  \/ ExitFlow

Spec == Init /\ [][Next]_vars

====