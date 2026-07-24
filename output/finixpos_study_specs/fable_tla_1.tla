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
  /\ orderId             \in OrderIds    \cup {NONE}
  /\ amountCents         \in Amounts     \cup {NOAMT}
  /\ transferId          \in TransferIds \cup {NONE}
  /\ declineCode         \in DeclineCodes \cup {NONE}
  /\ approvedAmountCents \in Amounts     \cup {NOAMT}
  /\ paymentId           \in PaymentIds  \cup {NONE}

Init ==
  /\ txState             = "IDLE"
  /\ orderId             = NONE
  /\ amountCents         = NOAMT
  /\ transferId          = NONE
  /\ declineCode         = NONE
  /\ approvedAmountCents = NOAMT
  /\ paymentId           = NONE

\* INITIATE_PAYMENT — accepted only from IDLE (FSM enforceAllowedTransitions);
\* resets all per-transaction fields and stores the new order + amount.
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

\* TRANSFER_CREATED — internal action fired after createTerminalSale succeeds;
\* accepted only from INITIATING.
TransferCreated(transfer) ==
  IF txState = "INITIATING"
  THEN /\ txState'    = "AWAITING_TAP"
       /\ transferId' = transfer
       /\ UNCHANGED <<orderId, amountCents, declineCode,
                      approvedAmountCents, paymentId>>
  ELSE UNCHANGED vars

\* VERIFICATION_STARTED — createTerminalSale recovery exhausted; accepted
\* only from INITIATING.
VerificationStarted ==
  IF txState = "INITIATING"
  THEN /\ txState' = "AWAITING_VERIFICATION"
       /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                      approvedAmountCents, paymentId>>
  ELSE UNCHANGED vars

\* TAP_APPROVED — pre-FSM partial-payment acceptor: in AWAITING_TAP with
\* approvedAmount strictly below the requested amount, the action is
\* rewritten to TAP_DECLINED with declineCode='PARTIAL_PAYMENT' (→ DECLINED,
\* approvedAmountCents untouched). Otherwise accepted from AWAITING_TAP,
\* AWAITING_VERIFICATION (orphan-sweep resolution), and CANCELLING
\* (tap-beat-cancel) → RECORDING. Silently discarded elsewhere
\* (anti-glitch: RECORDING/COMPLETED taps cause no state change).
TapApproved(approvedAmount) ==
  IF /\ txState = "AWAITING_TAP"
     /\ amountCents # NOAMT
     /\ approvedAmount < amountCents
  THEN /\ txState'     = "DECLINED"
       /\ declineCode' = "PARTIAL_PAYMENT"
       /\ UNCHANGED <<orderId, amountCents, transferId,
                      approvedAmountCents, paymentId>>
  ELSE IF txState \in {"AWAITING_TAP", "AWAITING_VERIFICATION", "CANCELLING"}
  THEN /\ txState'             = "RECORDING"
       /\ approvedAmountCents' = approvedAmount
       /\ UNCHANGED <<orderId, amountCents, transferId, declineCode, paymentId>>
  ELSE UNCHANGED vars

\* TAP_DECLINED — from CANCELLING the pre-FSM acceptor rewrites it to
\* CANCEL_DECLINED (→ CANCELLED, declineCode recorded). From INITIATING /
\* AWAITING_TAP / AWAITING_VERIFICATION it goes to DECLINED. Silently
\* discarded elsewhere.
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

\* PAYMENT_RECORDED — accepted only from RECORDING; paymentId may be NONE
\* (recordLocally=false flow, or DB write failure).
PaymentRecorded(payment) ==
  IF txState = "RECORDING"
  THEN /\ txState'   = "COMPLETED"
       /\ paymentId' = payment
       /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                      approvedAmountCents>>
  ELSE UNCHANGED vars

\* CANCEL_PAYMENT — accepted from INITIATING and AWAITING_TAP.
CancelPayment ==
  IF txState \in {"INITIATING", "AWAITING_TAP"}
  THEN /\ txState' = "CANCELLING"
       /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                      approvedAmountCents, paymentId>>
  ELSE UNCHANGED vars

\* CANCEL_CONFIRMED — accepted only from CANCELLING; sets no model fields.
CancelConfirmed ==
  IF txState = "CANCELLING"
  THEN /\ txState' = "CANCELLED"
       /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                      approvedAmountCents, paymentId>>
  ELSE UNCHANGED vars

\* EXIT_FLOW — accepted from terminal states; resets everything to sentinels.
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
  \/ \E o \in OrderIds : \E a \in Amounts : InitiatePayment(o, a)
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