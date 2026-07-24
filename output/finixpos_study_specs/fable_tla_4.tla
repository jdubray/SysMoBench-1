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

(* INITIATE_PAYMENT: accepted only from IDLE; resets all transaction fields. *)
InitiatePayment(order, amount) ==
  \/ /\ txState = "IDLE"
     /\ txState'             = "INITIATING"
     /\ orderId'             = order
     /\ amountCents'         = amount
     /\ transferId'          = NONE
     /\ declineCode'         = NONE
     /\ approvedAmountCents' = NOAMT
     /\ paymentId'           = NONE
  \/ /\ txState # "IDLE"
     /\ UNCHANGED vars

(* TRANSFER_CREATED: INITIATING -> AWAITING_TAP, records the transfer id. *)
TransferCreated(transfer) ==
  \/ /\ txState = "INITIATING"
     /\ txState'    = "AWAITING_TAP"
     /\ transferId' = transfer
     /\ UNCHANGED <<orderId, amountCents, declineCode, approvedAmountCents, paymentId>>
  \/ /\ txState # "INITIATING"
     /\ UNCHANGED vars

(* VERIFICATION_STARTED: INITIATING -> AWAITING_VERIFICATION. *)
VerificationStarted ==
  \/ /\ txState = "INITIATING"
     /\ txState' = "AWAITING_VERIFICATION"
     /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                    approvedAmountCents, paymentId>>
  \/ /\ txState # "INITIATING"
     /\ UNCHANGED vars

(* TAP_APPROVED:
   - AWAITING_TAP with approvedAmount < amountCents: pre-FSM acceptor rewrites
     to TAP_DECLINED with declineCode = PARTIAL_PAYMENT -> DECLINED.
   - AWAITING_TAP otherwise: -> RECORDING, capture approved amount.
   - AWAITING_VERIFICATION / CANCELLING (tap beat cancel): -> RECORDING.
   - Any other state: silently discarded (anti-glitch invariant). *)
TapApproved(approvedAmount) ==
  \/ /\ txState = "AWAITING_TAP"
     /\ amountCents # NOAMT
     /\ approvedAmount < amountCents
     /\ txState'     = "DECLINED"
     /\ declineCode' = "PARTIAL_PAYMENT"
     /\ UNCHANGED <<orderId, amountCents, transferId, approvedAmountCents, paymentId>>
  \/ /\ txState = "AWAITING_TAP"
     /\ ~(amountCents # NOAMT /\ approvedAmount < amountCents)
     /\ txState'             = "RECORDING"
     /\ approvedAmountCents' = approvedAmount
     /\ UNCHANGED <<orderId, amountCents, transferId, declineCode, paymentId>>
  \/ /\ txState \in {"AWAITING_VERIFICATION", "CANCELLING"}
     /\ txState'             = "RECORDING"
     /\ approvedAmountCents' = approvedAmount
     /\ UNCHANGED <<orderId, amountCents, transferId, declineCode, paymentId>>
  \/ /\ txState \notin {"AWAITING_TAP", "AWAITING_VERIFICATION", "CANCELLING"}
     /\ UNCHANGED vars

(* TAP_DECLINED:
   - INITIATING / AWAITING_TAP / AWAITING_VERIFICATION: -> DECLINED.
   - CANCELLING: pre-FSM acceptor rewrites to CANCEL_DECLINED -> CANCELLED.
   - Any other state: silently discarded. *)
TapDeclined(code) ==
  \/ /\ txState \in {"INITIATING", "AWAITING_TAP", "AWAITING_VERIFICATION"}
     /\ txState'     = "DECLINED"
     /\ declineCode' = code
     /\ UNCHANGED <<orderId, amountCents, transferId, approvedAmountCents, paymentId>>
  \/ /\ txState = "CANCELLING"
     /\ txState'     = "CANCELLED"
     /\ declineCode' = code
     /\ UNCHANGED <<orderId, amountCents, transferId, approvedAmountCents, paymentId>>
  \/ /\ txState \notin {"INITIATING", "AWAITING_TAP", "AWAITING_VERIFICATION", "CANCELLING"}
     /\ UNCHANGED vars

(* PAYMENT_RECORDED: RECORDING -> COMPLETED; paymentId may be NONE when the
   dashboard records via /record-payment or the DB write failed. *)
PaymentRecorded(payment) ==
  \/ /\ txState = "RECORDING"
     /\ txState'   = "COMPLETED"
     /\ paymentId' = payment
     /\ UNCHANGED <<orderId, amountCents, transferId, declineCode, approvedAmountCents>>
  \/ /\ txState # "RECORDING"
     /\ UNCHANGED vars

(* CANCEL_PAYMENT: INITIATING / AWAITING_TAP -> CANCELLING. *)
CancelPayment ==
  \/ /\ txState \in {"INITIATING", "AWAITING_TAP"}
     /\ txState' = "CANCELLING"
     /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                    approvedAmountCents, paymentId>>
  \/ /\ txState \notin {"INITIATING", "AWAITING_TAP"}
     /\ UNCHANGED vars

(* CANCEL_CONFIRMED: CANCELLING -> CANCELLED. *)
CancelConfirmed ==
  \/ /\ txState = "CANCELLING"
     /\ txState' = "CANCELLED"
     /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                    approvedAmountCents, paymentId>>
  \/ /\ txState # "CANCELLING"
     /\ UNCHANGED vars

(* EXIT_FLOW: terminal states -> IDLE, all transaction fields reset. *)
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
  \/ \E order \in OrderIds : \E amount \in Amounts : InitiatePayment(order, amount)
  \/ \E transfer \in TransferIds : TransferCreated(transfer)
  \/ VerificationStarted
  \/ \E approvedAmount \in Amounts : TapApproved(approvedAmount)
  \/ \E code \in DeclineCodes \cup {NONE} : TapDeclined(code)
  \/ \E payment \in PaymentIds \cup {NONE} : PaymentRecorded(payment)
  \/ CancelPayment
  \/ CancelConfirmed
  \/ ExitFlow

Spec == Init /\ [][Next]_vars

====