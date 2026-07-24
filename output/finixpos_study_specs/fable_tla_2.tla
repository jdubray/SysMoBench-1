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

(* INITIATE_PAYMENT: only accepted from IDLE. Sets order/amount, clears the
   rest of the transaction fields. Silently discarded elsewhere. *)
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

(* TRANSFER_CREATED: INITIATING -> AWAITING_TAP, records the transfer id.
   Silently discarded elsewhere. *)
TransferCreated(transfer) ==
  IF txState = "INITIATING"
  THEN /\ txState'    = "AWAITING_TAP"
       /\ transferId' = transfer
       /\ UNCHANGED <<orderId, amountCents, declineCode,
                      approvedAmountCents, paymentId>>
  ELSE UNCHANGED vars

(* VERIFICATION_STARTED: INITIATING -> AWAITING_VERIFICATION.
   Silently discarded elsewhere. *)
VerificationStarted ==
  IF txState = "INITIATING"
  THEN /\ txState' = "AWAITING_VERIFICATION"
       /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                      approvedAmountCents, paymentId>>
  ELSE UNCHANGED vars

(* TAP_APPROVED:
   - From AWAITING_TAP: the pre-FSM acceptor rejects partial authorizations
     (approvedAmount strictly below the requested amount) by rewriting the
     action to TAP_DECLINED with declineCode = PARTIAL_PAYMENT (-> DECLINED,
     approvedAmountCents left untouched). Otherwise -> RECORDING with the
     approved (possibly tip-inflated) amount.
   - From AWAITING_VERIFICATION or CANCELLING (tap beat cancel): -> RECORDING,
     no partial check (the acceptor only guards AWAITING_TAP).
   - Silently discarded in every other state (anti-glitch invariant). *)
TapApproved(approvedAmount) ==
  IF txState = "AWAITING_TAP"
  THEN IF approvedAmount < (IF amountCents = NOAMT THEN 0 ELSE amountCents)
       THEN /\ txState'     = "DECLINED"
            /\ declineCode' = "PARTIAL_PAYMENT"
            /\ UNCHANGED <<orderId, amountCents, transferId,
                           approvedAmountCents, paymentId>>
       ELSE /\ txState'             = "RECORDING"
            /\ approvedAmountCents' = approvedAmount
            /\ UNCHANGED <<orderId, amountCents, transferId,
                           declineCode, paymentId>>
  ELSE IF txState \in {"AWAITING_VERIFICATION", "CANCELLING"}
  THEN /\ txState'             = "RECORDING"
       /\ approvedAmountCents' = approvedAmount
       /\ UNCHANGED <<orderId, amountCents, transferId, declineCode, paymentId>>
  ELSE UNCHANGED vars

(* TAP_DECLINED:
   - From INITIATING / AWAITING_TAP / AWAITING_VERIFICATION -> DECLINED.
   - From CANCELLING: rewritten to CANCEL_DECLINED by the pre-FSM acceptor
     -> CANCELLED (same decline data applied).
   - Silently discarded elsewhere (anti-glitch invariant). *)
TapDeclined(code) ==
  IF txState \in {"INITIATING", "AWAITING_TAP", "AWAITING_VERIFICATION"}
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

(* PAYMENT_RECORDED: RECORDING -> COMPLETED, records the payment id (NONE when
   recordLocally = false / DB write failed). Silently discarded elsewhere. *)
PaymentRecorded(payment) ==
  IF txState = "RECORDING"
  THEN /\ txState'   = "COMPLETED"
       /\ paymentId' = payment
       /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                      approvedAmountCents>>
  ELSE UNCHANGED vars

(* CANCEL_PAYMENT: allowed from INITIATING and AWAITING_TAP -> CANCELLING.
   Silently discarded elsewhere. *)
CancelPayment ==
  IF txState \in {"INITIATING", "AWAITING_TAP"}
  THEN /\ txState' = "CANCELLING"
       /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                      approvedAmountCents, paymentId>>
  ELSE UNCHANGED vars

(* CANCEL_CONFIRMED: CANCELLING -> CANCELLED, no field changes.
   Silently discarded elsewhere. *)
CancelConfirmed ==
  IF txState = "CANCELLING"
  THEN /\ txState' = "CANCELLED"
       /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                      approvedAmountCents, paymentId>>
  ELSE UNCHANGED vars

(* EXIT_FLOW: from any terminal state -> IDLE, clearing all transaction
   fields. Silently discarded elsewhere. *)
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