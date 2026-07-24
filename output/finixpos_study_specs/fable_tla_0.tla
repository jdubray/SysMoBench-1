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

(* INITIATE_PAYMENT: only accepted from IDLE; resets all transaction fields.
   From any other state the FSM (enforceAllowedTransitions) silently
   discards the action — no state change. *)
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
   Discarded elsewhere. *)
TransferCreated(transfer) ==
    IF txState = "INITIATING"
    THEN /\ txState'    = "AWAITING_TAP"
         /\ transferId' = transfer
         /\ UNCHANGED <<orderId, amountCents, declineCode,
                        approvedAmountCents, paymentId>>
    ELSE UNCHANGED vars

(* VERIFICATION_STARTED: INITIATING -> AWAITING_VERIFICATION (createTerminalSale
   failed non-422; orphan sweep will resolve). Discarded elsewhere. *)
VerificationStarted ==
    IF txState = "INITIATING"
    THEN /\ txState' = "AWAITING_VERIFICATION"
         /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                        approvedAmountCents, paymentId>>
    ELSE UNCHANGED vars

(* TAP_APPROVED:
   - Partial-payment guard (pre-FSM acceptor): in AWAITING_TAP with
     approvedAmount < amountCents, rewritten to TAP_DECLINED with
     declineCode = PARTIAL_PAYMENT -> DECLINED.
   - Otherwise from AWAITING_TAP / AWAITING_VERIFICATION / CANCELLING
     (tap beat cancel) -> RECORDING, capturing the approved amount.
   - Anti-glitch: discarded in RECORDING/COMPLETED and all other states. *)
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
         /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                        paymentId>>
    ELSE UNCHANGED vars

(* TAP_DECLINED:
   - In CANCELLING the pre-FSM acceptor rewrites it to CANCEL_DECLINED
     -> CANCELLED (decline fields still applied).
   - From INITIATING / AWAITING_TAP / AWAITING_VERIFICATION -> DECLINED.
   - Anti-glitch: discarded in RECORDING/COMPLETED and all other states. *)
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

(* PAYMENT_RECORDED: RECORDING -> COMPLETED; paymentId may be NONE
   (recordLocally = false, or DB write failed). Discarded elsewhere. *)
PaymentRecorded(payment) ==
    IF txState = "RECORDING"
    THEN /\ txState'   = "COMPLETED"
         /\ paymentId' = payment
         /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                        approvedAmountCents>>
    ELSE UNCHANGED vars

(* CANCEL_PAYMENT: INITIATING / AWAITING_TAP -> CANCELLING.
   Discarded elsewhere. *)
CancelPayment ==
    IF txState \in {"INITIATING", "AWAITING_TAP"}
    THEN /\ txState' = "CANCELLING"
         /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                        approvedAmountCents, paymentId>>
    ELSE UNCHANGED vars

(* CANCEL_CONFIRMED: CANCELLING -> CANCELLED. Discarded elsewhere. *)
CancelConfirmed ==
    IF txState = "CANCELLING"
    THEN /\ txState' = "CANCELLED"
         /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                        approvedAmountCents, paymentId>>
    ELSE UNCHANGED vars

(* EXIT_FLOW: COMPLETED / DECLINED / CANCELLED -> IDLE, clearing all
   transaction fields. Discarded elsewhere. *)
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
    \/ \E order \in OrderIds : \E amount \in Amounts :
           InitiatePayment(order, amount)
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