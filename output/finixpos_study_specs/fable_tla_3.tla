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
    /\ orderId             \in OrderIds     \cup {NONE}
    /\ amountCents         \in Amounts      \cup {NOAMT}
    /\ transferId          \in TransferIds  \cup {NONE}
    /\ declineCode         \in DeclineCodes \cup {NONE}
    /\ approvedAmountCents \in Amounts      \cup {NOAMT}
    /\ paymentId           \in PaymentIds   \cup {NONE}

Init ==
    /\ txState             = "IDLE"
    /\ orderId             = NONE
    /\ amountCents         = NOAMT
    /\ transferId          = NONE
    /\ declineCode         = NONE
    /\ approvedAmountCents = NOAMT
    /\ paymentId           = NONE

(***************************************************************************)
(* INITIATE_PAYMENT: only accepted from IDLE.  Resets all per-transaction  *)
(* fields and stores the new order / amount.  From any other state the     *)
(* FSM (enforceAllowedTransitions) rejects it and nothing changes.         *)
(***************************************************************************)
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

(***************************************************************************)
(* TRANSFER_CREATED: INITIATING -> AWAITING_TAP, records the transfer id.  *)
(***************************************************************************)
TransferCreated(transfer) ==
    IF txState = "INITIATING"
    THEN /\ txState'    = "AWAITING_TAP"
         /\ transferId' = transfer
         /\ UNCHANGED <<orderId, amountCents, declineCode,
                        approvedAmountCents, paymentId>>
    ELSE UNCHANGED vars

(***************************************************************************)
(* VERIFICATION_STARTED: INITIATING -> AWAITING_VERIFICATION (createSale   *)
(* failed non-422 after retries; orphan sweep will resolve later).         *)
(***************************************************************************)
VerificationStarted ==
    IF txState = "INITIATING"
    THEN /\ txState' = "AWAITING_VERIFICATION"
         /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                        approvedAmountCents, paymentId>>
    ELSE UNCHANGED vars

(***************************************************************************)
(* TAP_APPROVED:                                                           *)
(*  - AWAITING_TAP with approvedAmount < amountCents: the pre-FSM acceptor *)
(*    rewrites the action to TAP_DECLINED with declineCode PARTIAL_PAYMENT *)
(*    -> DECLINED (approvedAmountCents is NOT written on this path).       *)
(*  - AWAITING_TAP / AWAITING_VERIFICATION / CANCELLING otherwise ->       *)
(*    RECORDING, storing the Finix-approved amount.                        *)
(*  - Any other state (e.g. RECORDING, COMPLETED): silently discarded.     *)
(***************************************************************************)
TapApproved(approvedAmount) ==
    IF txState = "AWAITING_TAP" /\ approvedAmount < amountCents
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

(***************************************************************************)
(* TAP_DECLINED:                                                           *)
(*  - INITIATING / AWAITING_TAP / AWAITING_VERIFICATION -> DECLINED.       *)
(*  - CANCELLING: pre-FSM acceptor rewrites to CANCEL_DECLINED ->          *)
(*    CANCELLED (same decline data applied to the model).                  *)
(*  - Any other state: silently discarded.                                 *)
(***************************************************************************)
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

(***************************************************************************)
(* PAYMENT_RECORDED: RECORDING -> COMPLETED.  paymentId may be NONE when   *)
(* the DB write failed or recordLocally = FALSE (dashboard modal records). *)
(***************************************************************************)
PaymentRecorded(payment) ==
    IF txState = "RECORDING"
    THEN /\ txState'   = "COMPLETED"
         /\ paymentId' = payment
         /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                        approvedAmountCents>>
    ELSE UNCHANGED vars

(***************************************************************************)
(* CANCEL_PAYMENT: INITIATING / AWAITING_TAP -> CANCELLING.                *)
(***************************************************************************)
CancelPayment ==
    IF txState \in {"INITIATING", "AWAITING_TAP"}
    THEN /\ txState' = "CANCELLING"
         /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                        approvedAmountCents, paymentId>>
    ELSE UNCHANGED vars

(***************************************************************************)
(* CANCEL_CONFIRMED: CANCELLING -> CANCELLED (no decline data written).    *)
(***************************************************************************)
CancelConfirmed ==
    IF txState = "CANCELLING"
    THEN /\ txState' = "CANCELLED"
         /\ UNCHANGED <<orderId, amountCents, transferId, declineCode,
                        approvedAmountCents, paymentId>>
    ELSE UNCHANGED vars

(***************************************************************************)
(* EXIT_FLOW: terminal states -> IDLE, clearing every transaction field.   *)
(***************************************************************************)
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