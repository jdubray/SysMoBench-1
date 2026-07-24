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

\* INITIATE_PAYMENT: only accepted from IDLE (FSM guard). Moves to INITIATING,
\* resetting the transaction fields to their fresh values.
InitiatePayment(order, amount) ==
  /\ txState = "IDLE"
  /\ txState'             = "INITIATING"
  /\ orderId'             = order
  /\ amountCents'         = amount
  /\ transferId'          = NONE
  /\ declineCode'         = NONE
  /\ approvedAmountCents' = NOAMT
  /\ paymentId'           = NONE

\* TRANSFER_CREATED: internal action, accepted from INITIATING. Moves to
\* AWAITING_TAP and records the transferId.
TransferCreated(transfer) ==
  /\ txState = "INITIATING"
  /\ txState'    = "AWAITING_TAP"
  /\ transferId' = transfer
  /\ UNCHANGED <<orderId, amountCents, declineCode, approvedAmountCents, paymentId>>

\* VERIFICATION_STARTED: accepted from INITIATING. Moves to AWAITING_VERIFICATION.
VerificationStarted ==
  /\ txState = "INITIATING"
  /\ txState' = "AWAITING_VERIFICATION"
  /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                 approvedAmountCents, paymentId>>

\* TAP_APPROVED:
\*   - From AWAITING_TAP: partial-payment guard — if approvedAmount < amountCents
\*     the pre-FSM acceptor rewrites to TAP_DECLINED(PARTIAL_PAYMENT) → DECLINED.
\*     Otherwise → RECORDING with approvedAmountCents set.
\*   - From AWAITING_VERIFICATION: → RECORDING (no partial guard on this path).
\*   - From CANCELLING (tap beat cancel): → RECORDING.
\*   - Anti-glitch: in RECORDING/COMPLETED (or any other state) it is silently
\*     discarded — no state change.
TapApproved(approvedAmount) ==
  \/ /\ txState = "AWAITING_TAP"
     /\ approvedAmount < amountCents
     /\ txState'             = "DECLINED"
     /\ declineCode'         = "PARTIAL_PAYMENT"
     /\ approvedAmountCents' = NOAMT
     /\ UNCHANGED <<orderId, amountCents, transferId, paymentId>>
  \/ /\ txState = "AWAITING_TAP"
     /\ ~(approvedAmount < amountCents)
     /\ txState'             = "RECORDING"
     /\ approvedAmountCents' = approvedAmount
     /\ UNCHANGED <<orderId, amountCents, transferId, declineCode, paymentId>>
  \/ /\ txState = "AWAITING_VERIFICATION"
     /\ txState'             = "RECORDING"
     /\ approvedAmountCents' = approvedAmount
     /\ UNCHANGED <<orderId, amountCents, transferId, declineCode, paymentId>>
  \/ /\ txState = "CANCELLING"
     /\ txState'             = "RECORDING"
     /\ approvedAmountCents' = approvedAmount
     /\ UNCHANGED <<orderId, amountCents, transferId, declineCode, paymentId>>
  \/ /\ txState \notin {"AWAITING_TAP", "AWAITING_VERIFICATION", "CANCELLING"}
     /\ UNCHANGED vars

\* TAP_DECLINED:
\*   - From AWAITING_TAP / INITIATING / AWAITING_VERIFICATION → DECLINED.
\*   - From CANCELLING: pre-FSM acceptor rewrites to CANCEL_DECLINED → CANCELLED.
\*   - Anti-glitch: in any other state, silently discarded.
TapDeclined(code) ==
  \/ /\ txState \in {"AWAITING_TAP", "INITIATING", "AWAITING_VERIFICATION"}
     /\ txState'     = "DECLINED"
     /\ declineCode' = code
     /\ UNCHANGED <<orderId, amountCents, transferId, approvedAmountCents, paymentId>>
  \/ /\ txState = "CANCELLING"
     /\ txState'     = "CANCELLED"
     /\ declineCode' = code
     /\ UNCHANGED <<orderId, amountCents, transferId, approvedAmountCents, paymentId>>
  \/ /\ txState \notin {"AWAITING_TAP", "INITIATING", "AWAITING_VERIFICATION", "CANCELLING"}
     /\ UNCHANGED vars

\* PAYMENT_RECORDED: accepted from RECORDING. Moves to COMPLETED, sets paymentId.
PaymentRecorded(payment) ==
  \/ /\ txState = "RECORDING"
     /\ txState'   = "COMPLETED"
     /\ paymentId' = payment
     /\ UNCHANGED <<orderId, amountCents, transferId, declineCode, approvedAmountCents>>
  \/ /\ txState # "RECORDING"
     /\ UNCHANGED vars

\* CANCEL_PAYMENT: accepted from INITIATING or AWAITING_TAP → CANCELLING.
\* In any other state, silently discarded.
CancelPayment ==
  \/ /\ txState \in {"INITIATING", "AWAITING_TAP"}
     /\ txState' = "CANCELLING"
     /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                    approvedAmountCents, paymentId>>
  \/ /\ txState \notin {"INITIATING", "AWAITING_TAP"}
     /\ UNCHANGED vars

\* CANCEL_CONFIRMED: accepted from CANCELLING → CANCELLED.
CancelConfirmed ==
  \/ /\ txState = "CANCELLING"
     /\ txState' = "CANCELLED"
     /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                    approvedAmountCents, paymentId>>
  \/ /\ txState # "CANCELLING"
     /\ UNCHANGED vars

\* EXIT_FLOW: accepted from terminal states (COMPLETED, DECLINED, CANCELLED)
\* → IDLE, resetting all transaction fields.
ExitFlow ==
  \/ /\ txState \in {"COMPLETED", "DECLINED", "CANCELLED"}
     /\ txState'             = "IDLE"
     /\ orderId'             = NONE
     /\ amountCents'         = NOAMT
     /\ transferId'          = NONE
     /\ declineCode'         = NONE
     /\ approvedAmountCents' = NOAMT
     /\ paymentId'           = NONE
  \/ /\ txState \notin {"COMPLETED", "DECLINED", "CANCELLED"}
     /\ UNCHANGED vars

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