--------------------------- MODULE FinixPOSRefund ---------------------------
\* RETIRED (2026-07-04, owner amendment): this module checked AtMostOneRefund
\* for the automatic refundPartialCharge call. Patch v2 (amended) removed the
\* automatic refund entirely — the POS never calls the refund API (access-
\* control decision: refund authority stays behind the Finix dashboard login) —
\* so the property this module tested no longer exists in the system. Kept for
\* the audit trail of the earlier finding ("double-refund-proof" held only iff
\* Finix dedupes reversals — an untested external assumption).
(***************************************************************************)
(* Refund-idempotency gadget (review point 2.4).                           *)
(*                                                                         *)
(* The patched refundPartialCharge (gapfix-preview lines 972-1005) is      *)
(* STATELESS on the POS side: no local "refund issued" marker is ever      *)
(* persisted.  Its only double-refund protection is the deterministic      *)
(* idempotency id `partial-void-<transferId>` passed to                    *)
(* POST /transfers/:id/reversals (finix.ts createRefund, lines 438-451).   *)
(*                                                                         *)
(* The render fires it on every render of a terminal DECLINED/CANCELLED    *)
(* state with declineCode = PARTIAL_PAYMENT; sam-pattern re-renders on     *)
(* FSM-rejected no-op dispatches (verified by the trace harness), so a     *)
(* late duplicate TAP_DECLINED can re-render the same terminal state and   *)
(* re-fire the refund.  There is no retry on failure (fire-and-forget,     *)
(* reconcile_gap log only).                                                *)
(*                                                                         *)
(* REVERSAL_IDEMPOTENT = does Finix dedupe reversals by idempotency_id?    *)
(* This is an EXTERNAL, UNTESTED assumption (the emulator has no           *)
(* /reversals endpoint).  The gadget shows the claim "double-refund-proof" *)
(* is exactly equivalent to that assumption.                               *)
(***************************************************************************)
EXTENDS Integers

CONSTANT REVERSAL_IDEMPOTENT

VARIABLES
  renders,       \* times the terminal PARTIAL state has rendered (bound 2)
  refundsIssued  \* reversals actually settled at Finix

vars == <<renders, refundsIssued>>

TypeOK == renders \in 0..2 /\ refundsIssued \in 0..2

Init == renders = 0 /\ refundsIssued = 0

\* A render of the PARTIAL terminal state fires createRefund with the
\* deterministic id.  Finix either dedupes (idempotent) or books a second
\* reversal.
RenderFiresRefund ==
  /\ renders < 2
  /\ renders' = renders + 1
  /\ refundsIssued' =
       IF refundsIssued = 0 THEN 1
       ELSE IF REVERSAL_IDEMPOTENT THEN refundsIssued
       ELSE refundsIssued + 1

Next == RenderFiresRefund

Spec == Init /\ [][Next]_vars

Inv_AtMostOneRefund == refundsIssued <= 1

=============================================================================
