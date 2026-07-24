# finixpos reference model — TLC findings (deliverable (a): is the implementation correct?)

**Date:** 2026-07-03 · **Models:** `FinixPOS.tla` (POS dispatch relation),
`FinixPOSEnv.tla` (environment composition) · **TLC:** tla2tools.jar, `-deadlock`,
exhaustive (state spaces 43–103 distinct states per config — the protocol is
small once projected onto the plan §1 observable contract; every run finishes
in <1 s and explores the full graph).

## Model structure

- **`FinixPOS.tla`** — one `Dispatch*` operator per SAM action, *total*
  (FSM-rejected actions are explicit no-ops), with the two pre-FSM acceptor
  rewrites folded in (CANCELLING+TAP_DECLINED→CANCELLED; partial-approval
  →DECLINED(`PARTIAL_PAYMENT`), guard scoped to AWAITING_TAP exactly as in
  the code, line 866). Every operator cites the source lines it models.
- **`FinixPOSEnv.tla`** — single order / single idempotency key / single
  transfer. Environment actions: the create-sale ladder (attempt phases 0–4
  with a `createdBy` marker distinguishing "my response" from "422 duplicate"),
  the 422 handler, the poll loop (gated on `txState ∈ {AWAITING_TAP, CANCELLING}
  ∧ transferId ≠ NONE`, matching pollTick), the cancel NAP with its verify
  probe, the record NAP, customer tap/decline/device-cancel, staff cancel /
  timeout, and the orphan sweep (enabled **iff** a `pending_terminal_sales`
  breadcrumb exists). `recordSucceededTransferAndAdvance` is modeled as an
  atomic DB-write-then-two-dispatches, faithful to its write-before-dispatch
  order.
- **Failure-mode gates** (CONSTANTS): `EARLY_CANCEL`, `FETCH_CAN_FAIL`,
  `PARTIAL_POSSIBLE`, `DB_CAN_FAIL`, `CANCEL_BLIND_POSSIBLE` — each cfg
  enables exactly one, so every counterexample isolates one mechanism.

## Invariants

- `Inv_I1_NoLostCharge` — no reachable state with Finix `SUCCEEDED` ∧ POS
  terminal `DECLINED`/`CANCELLED` ∧ no payments row ∧ no breadcrumb.
  (COMPLETED-without-payment is *not* a violation: `recoverOrphanedCompletedPayments`
  covers it.)
- `Inv_I3_CancelHonoured` — `CANCELLED` ⇒ transfer not `SUCCEEDED` (or recorded).
- `Inv_VerificationHasBreadcrumb` — `AWAITING_VERIFICATION` ⇒ breadcrumb exists.
- `Inv_NoPartialRecorded` — a recorded payment's approved amount ≥ requested.
- I2 (no double charge) is structurally enforced by the fixed idempotency key +
  `ON CONFLICT (order_id, finix_transfer_id) DO NOTHING` + the already-paid
  check; a single-attempt model cannot probe it further and it was **not**
  model-checked beyond bookkeeping consistency. (A two-attempt model is the
  natural extension.)

## Results

| config | gates on | invariant | result |
|---|---|---|---|
| `clean` | none | all four | **HOLDS** (103 states, full graph) |
| `bug1_earlycancel` | EARLY_CANCEL | I1 | **VIOLATED** — 7 steps |
| `bug2_fetchfail` | FETCH_CAN_FAIL | I1 | **VIOLATED** — 7 steps |
| `bug3_partial` | PARTIAL_POSSIBLE | I1 | **VIOLATED** — 7 steps |
| `bug3b_partialrec` | PARTIAL_POSSIBLE | NoPartialRecorded | **VIOLATED** — 9 steps |
| `bug4_dbfail` | DB_CAN_FAIL | VerificationHasBreadcrumb | **VIOLATED** — 6 steps |
| `bug5_blindcancel` | CANCEL_BLIND_POSSIBLE | I3 | **VIOLATED** — 8 steps |

Annotated traces with source-line mapping: `counterexamples/bug*.txt`
(raw TLC output alongside as `*.raw.txt`).

## Verdict per candidate weakness (EXTRACTION.md §8)

1. **Cancel-during-INITIATING (bug 1): counterexample found — the most
   serious.** Needs **no** optional failure mode, only the FSM-permitted staff
   cancel from INITIATING racing the in-flight `POST /transfers`. The device
   cancel finds nothing to cancel; the transfer lands afterwards; its
   `TRANSFER_CREATED` is FSM-rejected in CANCELLED; the customer can still tap.
   Charge exists at Finix; POS says cancelled; **no breadcrumb** — invisible to
   every sweep. *Environment assumption to validate:* `PUT /devices/:id
   {action:CANCEL}` is device-scoped and does not cancel a still-propagating
   create; if Finix serializes these per device, the window closes.
2. **422 fetch-failure decline (bug 2): counterexample found.** Requires one
   lost response + one failed GET (two independent transient failures on the
   same key). The code comment (lines 661–663) *acknowledges* the ambiguity but
   the path writes no `pending_terminal_sales` breadcrumb — unlike the sibling
   Case-4 path. Cheap fix: insert the breadcrumb in the catch.
3. **Partial approval (bug 3/3b): two counterexamples.** (a) The decline
   correctly fires but nothing voids the settled partial charge (I1). (b) The
   guard is scoped to `AWAITING_TAP` only, so a partial approval arriving in
   CANCELLING (or via sweep resolution in AWAITING_VERIFICATION) is **recorded
   and marks the order paid below the order total** (NoPartialRecorded).
   *Assumption to validate:* whether Finix card-present transfers can partially
   authorize at all; the guard's existence suggests the authors believed so.
4. **AWAITING_VERIFICATION stuck (bug 4): counterexample found**, gated on the
   local SQLite INSERT failing (rare). Lines 612–624 deliberately dispatch
   `VERIFICATION_STARTED` after a failed breadcrumb write; the state's only
   exits are sweep-driven, and the sweep scans the table that has no row.
   Liveness phrased as safety (`AWAITING_VERIFICATION ⇒ breadcrumb`); the
   stuck state is also a real deadlock of the workflow instance.
5. **Bonus (bug 5, found during modeling):** the acknowledged "conservative"
   double-failure path in the cancel NAP (cancel throws AND probe fails while
   the transfer is SUCCEEDED) confirms the cancel over a real charge. Unlike
   bug 1, the ttx row *does* carry the transferId, so a recovery sweep over
   `CANCELLED` rows with a transfer id is possible — none exists today.

**Overall:** the *core protocol is correct* — with no early cancel and no
optional failure modes, all four invariants hold over the full state graph,
including the tap-beats-cancel race, the 422 recovery ladder, the verification
sweep, and the no-op glitch tolerance. Every violation found lives in the
**failure-handling periphery**, and all five share one root cause: *paths that
abandon a possibly-live transfer without leaving the idempotency-key breadcrumb
(or a scoped guard) that the recovery machinery depends on.*

## Model-vs-code caveats (what "the model shows" does not prove)

- The model delivers the create response with the transfer's *current* state;
  the real response body is a snapshot at request time (a PENDING-then-FAILED
  sequence can appear as an immediate FAILED in the model). Over-approximates
  timing, does not add unreachable POS states; decline-code identity on that
  path (`IMMEDIATE_FAILURE` vs issuer code) is not modeled precisely.
- Bug 1's reachability depends on the Finix-side ordering assumption noted
  above (create landing after a device cancel); bug 3 on partial authorization
  being possible; bug 5 on two independent request failures. Bugs 2 and 4 need
  no Finix-side assumptions beyond transient network/DB errors.
- `EXIT_FLOW` / re-initiation and split payments are out of the model (one
  attempt per run); I2 across retries is untested.
- The 180 s timeout is merged with staff cancel (same `CANCEL_PAYMENT`
  dispatch, per lines 352–376); timing itself is untimed in the model.

## Post-hoc validation of the two flagged environment assumptions (Finix public docs, checked 2026-07-03)

- **Partial authorization (bugs 3/3b)** — SUPPORTED as production-real. Finix
  documents a merchant-level `default_partial_authorization_enabled`
  configuration and an `amount_requested` field distinguishing requested vs
  approved amounts; partial approvals are standard for debit/prepaid (common
  at POS). If the baanbaan merchant profile has this enabled, the counterexample
  class is live. Sources: docs.finix.com/api/authorizations,
  docs.finix.com/api/transfers.
- **Device cancel vs in-flight create (bug 1)** — UNRESOLVED in public docs,
  consistent with the model. `PUT /devices {action: CANCEL}` is documented as
  "cancels any active transaction and returns to the idle screen"; nothing
  specifies the race where the `POST /transfers` has not yet reached the
  device — i.e. no documented guarantee that a cancel fences later-arriving
  creates. The model's assumption (cancel is a no-op when nothing is active
  yet) is the conservative reading. Recommend confirming with Finix support;
  the defensive fix (write the breadcrumb before entering CANCELLING from
  INITIATING) is cheap regardless. Sources: docs.finix.com/api/devices,
  docs.finix.com/guides/in-person-payments/building-your-integration/pos-integration.
