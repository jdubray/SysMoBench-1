------------------------- MODULE FinixPOSTwoAttempt -------------------------
(***************************************************************************)
(* Two-attempt model for I2 / no-double-charge (review point 2.3).         *)
(*                                                                         *)
(* One order, two payment attempts.  Attempt 1 exercises the gap-2 shape:  *)
(* its transfer T1 can be blind-declined (422 duplicate key + failed       *)
(* status fetch, lines 660-673) while T1 is still live on the device; the  *)
(* customer's tap then settles T1 AFTER the POS showed a decline.  Staff,  *)
(* seeing a retryable decline on an unpaid order, retries with a FRESH     *)
(* idempotency key -> transfer T2.                                         *)
(*                                                                         *)
(* Faithfully modeled gating:                                              *)
(*   - GUARD_409: startTerminalPaymentForDashboard (lines 2387-2404)       *)
(*     rejects a new attempt while a pending_terminal_sales row is         *)
(*     unresolved.  The COUNTER path (startTerminalPayment, 1477-1523)     *)
(*     has NO such guard — run with GUARD_409 = FALSE to model it.         *)
(*   - Staff retry only on a visibly-unpaid order showing a retryable      *)
(*     decline (the UI reflects orders.status via SSE).                    *)
(*   - The sweep's covered-order guard (reconcile.ts 1381-1404): if the    *)
(*     order's recorded legs already cover its total, the sweep SKIPS the  *)
(*     insert, deletes the pending row, and logs loudly (doubleDetected).  *)
(*   - recordTerminalPayment's already-paid idempotent skip (1896-1909):   *)
(*     recording attempt 2 on an order the sweep just marked paid records  *)
(*     NOTHING (rec2 stays FALSE) but the FSM still completes.             *)
(*                                                                         *)
(* PATCHED gates the gap-2 fix: the 422-catch breadcrumb (with T1's id).   *)
(*                                                                         *)
(* Properties:                                                             *)
(*   I2money   at most one SUCCEEDED transfer per order  (the real claim)  *)
(*   I2booked  at most one payments row per order                          *)
(*   I2visible a double charge, if reached, is at least DETECTED           *)
(*             (recorded, breadcrumbed, or loudly logged) — the safety     *)
(*             disclosure distinction the review asks for.                 *)
(***************************************************************************)
EXTENDS Integers

CONSTANTS PATCHED, GUARD_409

FinStates == {"NONE", "PENDING", "SUCCEEDED", "FAILED"}

VARIABLES
  pos,            \* IDLE | ATT1 | DECLINED1 | ATT2 | DONE
  finix1, finix2, \* transfer states for attempt 1 / attempt 2
  bc1,            \* pending_terminal_sales row for T1: "none"|"pending"|"resolved"
  rec1, rec2,     \* payments rows for T1 / T2
  orderPaid,      \* orders.status = 'paid'
  doubleDetected  \* the sweep's covered-order loud log fired

vars == <<pos, finix1, finix2, bc1, rec1, rec2, orderPaid, doubleDetected>>

TypeOK ==
  /\ pos \in {"IDLE", "ATT1", "DECLINED1", "ATT2", "DONE"}
  /\ finix1 \in FinStates /\ finix2 \in FinStates
  /\ bc1 \in {"none", "pending", "resolved"}
  /\ rec1 \in BOOLEAN /\ rec2 \in BOOLEAN
  /\ orderPaid \in BOOLEAN /\ doubleDetected \in BOOLEAN

Init ==
  /\ pos = "IDLE" /\ finix1 = "NONE" /\ finix2 = "NONE"
  /\ bc1 = "none" /\ rec1 = FALSE /\ rec2 = FALSE
  /\ orderPaid = FALSE /\ doubleDetected = FALSE

-----------------------------------------------------------------------------
(* Attempt 1                                                                *)

Start1 ==
  /\ pos = "IDLE"
  /\ pos' = "ATT1" /\ finix1' = "PENDING"
  /\ UNCHANGED <<finix2, bc1, rec1, rec2, orderPaid, doubleDetected>>

\* Happy resolution of attempt 1 (poll sees the settlement) — included so
\* the model also covers the boring path.
Poll1Succeed ==
  /\ pos = "ATT1" /\ finix1 = "SUCCEEDED"
  /\ pos' = "DONE" /\ rec1' = TRUE /\ orderPaid' = TRUE
  /\ UNCHANGED <<finix1, finix2, bc1, rec2, doubleDetected>>

Poll1Fail ==
  /\ pos = "ATT1" /\ finix1 = "FAILED"
  /\ pos' = "DECLINED1"
  /\ UNCHANGED <<finix1, finix2, bc1, rec1, rec2, orderPaid, doubleDetected>>

\* Gap-2 shape: the 422-duplicate-key status fetch fails while T1 is still
\* PENDING on the device.  The POS declines (retryable), the device prompt
\* stays live.  Post-fix the catch writes the breadcrumb (with T1's id).
BlindDecline1 ==
  /\ pos = "ATT1" /\ finix1 = "PENDING"
  /\ pos' = "DECLINED1"
  /\ bc1' = IF PATCHED THEN "pending" ELSE "none"
  /\ UNCHANGED <<finix1, finix2, rec1, rec2, orderPaid, doubleDetected>>

\* The customer taps T1 — legal any time the prompt is live, INCLUDING after
\* the POS already showed the decline.
Customer1Approve ==
  /\ finix1 = "PENDING"
  /\ finix1' = "SUCCEEDED"
  /\ UNCHANGED <<pos, finix2, bc1, rec1, rec2, orderPaid, doubleDetected>>

Customer1Decline ==
  /\ finix1 = "PENDING"
  /\ finix1' = "FAILED"
  /\ UNCHANGED <<pos, finix2, bc1, rec1, rec2, orderPaid, doubleDetected>>

-----------------------------------------------------------------------------
(* Orphan sweep on T1's breadcrumb (sweepOrphanedTerminalSales).            *)

SweepResolve1 ==
  /\ bc1 = "pending" /\ finix1 \in {"SUCCEEDED", "FAILED"}
  /\ bc1' = "resolved"
  /\ UNCHANGED <<pos, finix1, finix2, rec2>>
  /\ CASE finix1 = "FAILED" ->
            \* transfer dead: delete the row, retry stays safe
            UNCHANGED <<rec1, orderPaid, doubleDetected>>
       [] finix1 = "SUCCEEDED" /\ orderPaid ->
            \* covered-order guard (1381-1404): skip the insert, log loudly
            /\ doubleDetected' = TRUE
            /\ UNCHANGED <<rec1, orderPaid>>
       [] OTHER ->
            \* recover: insert payments row, mark the order paid
            /\ rec1' = TRUE /\ orderPaid' = TRUE
            /\ UNCHANGED doubleDetected

-----------------------------------------------------------------------------
(* Attempt 2 — staff retry with a fresh key.  Gated by:                     *)
(*   - the decline being visible and the order not visibly paid;            *)
(*   - the 409 pending-row guard (dashboard path only).                     *)

Start2 ==
  /\ pos = "DECLINED1"
  /\ ~orderPaid
  /\ (GUARD_409 => bc1 # "pending")
  /\ pos' = "ATT2" /\ finix2' = "PENDING"
  /\ UNCHANGED <<finix1, bc1, rec1, rec2, orderPaid, doubleDetected>>

Customer2Approve ==
  /\ finix2 = "PENDING"
  /\ finix2' = "SUCCEEDED"
  /\ UNCHANGED <<pos, finix1, bc1, rec1, rec2, orderPaid, doubleDetected>>

Customer2Decline ==
  /\ finix2 = "PENDING"
  /\ finix2' = "FAILED"
  /\ UNCHANGED <<pos, finix1, bc1, rec1, rec2, orderPaid, doubleDetected>>

\* Record NAP for attempt 2: recordTerminalPayment's already-paid check
\* (1896-1909) SKIPS the insert when the sweep recovered T1 meanwhile —
\* T2's money is then charged at Finix but recorded nowhere.
Record2 ==
  /\ pos = "ATT2" /\ finix2 = "SUCCEEDED"
  /\ pos' = "DONE"
  /\ IF orderPaid
     THEN UNCHANGED <<rec2, orderPaid>>          \* idempotent skip
     ELSE rec2' = TRUE /\ orderPaid' = TRUE
  /\ UNCHANGED <<finix1, finix2, bc1, rec1, doubleDetected>>

Poll2Fail ==
  /\ pos = "ATT2" /\ finix2 = "FAILED"
  /\ pos' = "DONE"
  /\ UNCHANGED <<finix1, finix2, bc1, rec1, rec2, orderPaid, doubleDetected>>

-----------------------------------------------------------------------------

Next ==
  \/ Start1 \/ Poll1Succeed \/ Poll1Fail \/ BlindDecline1
  \/ Customer1Approve \/ Customer1Decline
  \/ SweepResolve1
  \/ Start2 \/ Customer2Approve \/ Customer2Decline
  \/ Record2 \/ Poll2Fail

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Properties                                                               *)

\* The money-level claim: the customer is charged at most once per order.
Inv_I2money ==
  ~(finix1 = "SUCCEEDED" /\ finix2 = "SUCCEEDED")

\* The books-level claim: at most one payments row per order.
Inv_I2booked ==
  ~(rec1 /\ rec2)

\* The disclosure claim: if a double charge exists, SOMETHING sees it —
\* T1 recorded, T1 breadcrumbed (sweep will look), or the covered-order
\* guard logged it.  Pre-fix this fails: the double charge is invisible.
Inv_I2visible ==
  (finix1 = "SUCCEEDED" /\ finix2 = "SUCCEEDED")
    => (rec1 \/ bc1 # "none" \/ doubleDetected)

=============================================================================
