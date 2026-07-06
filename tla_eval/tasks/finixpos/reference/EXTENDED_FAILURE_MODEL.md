# Extended failure model — crash-restart, poll staleness, two-attempt I2, refund idempotency

Answers review points 2.2 (failure-model completeness), 2.3 (I2 across
attempts), and the refund-idempotency part of 2.4. New modules (originals
untouched): `FinixPOSCrash.tla`, `FinixPOSStale.tla`, `FinixPOSTwoAttempt.tla`,
`FinixPOSRefund.tla`, configs `ext_*.cfg`, raw TLC traces in
`counterexamples/ext_*.raw.txt`. Every module carries a `PATCHED` constant so
pre-fix and post-fix (gap-fix patch, `patches/GAP-FIXES.md`) semantics run from
the same file.

## 1. Systematic derivation of the failure model

Per-channel enumeration — every RPC × {lost request, lost response,
duplicate/retry, stale read, error response}, plus process crash between any
two steps. Which cells the original five gates covered, and what the
extension adds:

| channel | lost req | lost resp | duplicate | stale read | error resp | covered by |
|---|---|---|---|---|---|---|
| `POST /transfers` (create) | orig (RespLost→ladder) | orig (422 path) | orig (same-key retry; **cross-key = two-attempt, NEW**) | n/a | orig (ladder) | Env + **TwoAttempt** |
| `GET /transfers/:id` (poll/probe) | orig (poll retries) | orig | benign (idempotent read) | **NEW (Stale)** | orig (`FETCH_CAN_FAIL`, `CANCEL_BLIND`) | Env + **Stale** |
| `PUT /devices` (cancel) | orig (cancel throw) | orig | benign (device-idempotent) | n/a | orig (`CANCEL_BLIND`) | Env |
| `POST /reversals` (refund) | fire-and-forget (logged) | **NEW (Refund)** | **NEW (Refund)** | n/a | logged only | **Refund** |
| local DB writes | n/a | n/a | `ON CONFLICT` | n/a | orig (`DB_CAN_FAIL`) + patch retry | Env |
| **process crash** (between any two steps) | — | — | — | — | — | **NEW (Crash)** — previously unmodeled |
| customer/staff interleavings | — | — | — | — | — | orig (`EARLY_CANCEL`, `PARTIAL_POSSIBLE`, tap-beat-cancel) |

The original five gates were interleaving- and error-response-shaped; the
three genuinely missing rows were **process durability**, **read staleness**,
and **cross-attempt composition** — exactly the review's list.

## 2. Verdicts

### A. Crash–restart (`FinixPOSCrash`, cfgs `ext_crash_prefix` / `ext_crash_patched`)

**I1 (no lost charge) is violated PRE-FIX *and* POST-FIX.** The gap-fix patch
does not touch rehydration, and rehydration is where the durability holes
live. Three distinct reachable manifestations (all confirmed by separate
TLC probes under PATCHED semantics; traces in `counterexamples/`):

- **NEW GAP 8 — crash during INITIATING** (`ext_crash_patched.raw.txt`,
  6 states). The create POST is on the wire when the POS dies; Finix creates
  the transfer afterwards and the customer taps it (the device prompt is
  process-independent). On restart the row is either rehydrated as a
  **zombie** — the factory fast-forwards only `AWAITING_TAP + transferId`
  (lines 1312–1350), so the live FSM sits at pc0 = IDLE and no NAP or poll
  ever fires — or, if >5 min old, rewritten `tx_state='CANCELLED'` **with no
  Finix probe** (lines 1588–1613). Either way the row has `transferId = NULL`,
  so even the patch's CANCELLED-rows sweep (which requires a transfer id)
  cannot see it: SUCCEEDED at Finix, invisible everywhere.
  *The row does persist `idempotency_key` (dehydrate, line 2178) — a sweep
  that probes crashed non-terminal rows by idempotency key would close this.*
- **NEW GAP 9 — crash in RECORDING** (probe `Probe_Gap9_RecordingCrash`).
  The reviewer's classic window: Finix SUCCEEDED, crash before the payments
  INSERT. The rehydrated RECORDING row is a zombie; no sweep covers
  RECORDING rows (`recoverOrphanedCompletedPayments` covers COMPLETED only,
  the patch's new sweep covers CANCELLED only). The row **carries the
  transfer id** — the fix is a one-clause widening of either sweep.
- **NEW GAP 9b — crash in CANCELLING** (probe `Probe_Gap9b_CancellingCrash`).
  Same zombie mechanism; a tap that beat the cancel is lost.

What *does* hold: crash in `AWAITING_TAP` — the one case rehydration was
designed for — resumes the poll and recovers correctly, pre- and post-fix.
Crash in `COMPLETED` without a payments row is recovered by the existing
COMPLETED-orphan sweep. State counts: 50–52 distinct states to first
violation; sub-scenario probes 24–45 distinct states.

**Root cause, one sentence:** rehydration *loads* non-AWAITING_TAP rows but
cannot *drive* them (sam-fsm resets the program counter to IDLE and only the
AWAITING_TAP fast-forward replays it), and no sweep covers the resulting
zombie rows — the same abandon-without-breadcrumb pattern as gaps 1–7, now
via the crash path.

### B. Poll staleness (`FinixPOSStale`, cfgs `ext_stale_prefix` / `ext_stale_patched`)

Reads may return the transfer's previous lifecycle state (one-step staleness:
a settled transfer still reads PENDING).

- **Pre-fix: I1 violated** (17 distinct states). A single stale probe in the
  cancel ladder suffices: cancel hits the already-SUCCEEDED transfer, Finix
  echoes FAILED/CANCELLATION_VIA_API, the verification probe reads stale
  PENDING → `CANCEL_CONFIRMED` over a real charge. This is a
  **no-extra-assumption variant of gap 5** — the original needed cancel-throw
  *and* probe-error; staleness alone reaches the same lost charge.
- **Post-fix: HOLDS** (exhaustive, 18 distinct states). The stale-defeated
  cancel leaves a CANCELLED row *with* a transfer id, and the patch's
  `recoverChargedButCancelledPayments` sweep recovers it. (Gap 6's multi-id
  probe narrows but does not remove the stale window; the sweep is what
  closes it.)
- Stale reads in the poll loop and the 422 handler are benign: the poll
  re-reads until fresh, and a 422-stale-PENDING resumes awaiting-tap whose
  poll then records the settlement (`CreateDelivered422Stale` documents this).

### C. Two attempts / I2 (`FinixPOSTwoAttempt`, three cfgs)

Faithful gating modeled: the dashboard 409 pending-row guard
(`startTerminalPaymentForDashboard`, lines 2387–2404), staff retry only on a
visibly-unpaid order, the sweep's covered-order guard (reconcile.ts
1381–1404, skips + logs loudly), and `recordTerminalPayment`'s already-paid
idempotent skip (1896–1909).

| cfg | I2money (≤1 SUCCEEDED charge) | I2booked (≤1 payments row) | I2visible (double charge detected) |
|---|---|---|---|
| pre-fix (`ext_twoatt_prefix`) | **VIOLATED** (23 states) | holds | **VIOLATED** — the double charge is *invisible* |
| post-fix, dashboard (`ext_twoatt_patched_dash`) | **holds** (exhaustive, 21 states) | holds | holds |
| post-fix, counter (`ext_twoatt_patched_counter`) | **VIOLATED** (38 states) | holds | holds (detected) |

- **Pre-fix: the reviewer's composition appears mechanically** (6-step
  trace, `ext_twoatt_prefix.raw.txt`): gap-2 blind decline of a live
  transfer → customer taps it → staff retries (no pending row, so nothing
  blocks) → second transfer succeeds → **two SUCCEEDED transfers for one
  order, the first invisible to every sweep**. The books never double
  (I2booked holds) — which is precisely why the incident is silent.
- **Post-fix, dashboard path: I2 actually holds**, exhaustively. The
  breadcrumb + 409 guard force the sweep to resolve attempt 1 first; a
  recovered SUCCEEDED marks the order paid, and staff retry on a paid order
  is excluded by the visible-state gate.
- **NEW GAP 10 — the counter path lacks the 409 guard.**
  `startTerminalPayment` (lines 1477–1523, used by counter-ws) checks only
  the `_initiating` set — no `pending_terminal_sales` query. Post-fix a
  counter retry can still race the sweep: double charge at Finix, *detected*
  by the covered-order guard (loud log) but **not remediated** — the surplus
  transfer is never refunded. Fix shape: hoist the dashboard's pending-row
  check into `startTerminalPayment` (or into the shared workflow entry).

**Honest scoping:** the sweep's covered-order guard means the patched system
never *double-books*; the residual exposure is a real second charge that is
logged for manual refund, reachable only via the counter path or any future
entry point that forgets the guard.

### D. Refund idempotency (`FinixPOSRefund`, cfgs `ext_refund_idem` / `ext_refund_noidem`)

The patched `refundPartialCharge` is stateless (no local refund marker, no
retry); its only protection is the deterministic `partial-void-<transferId>`
idempotency id passed to `POST /transfers/:id/reversals`
(finix.ts 438–451). TLC confirms the tautology precisely:
`Inv_AtMostOneRefund` **holds iff `REVERSAL_IDEMPOTENT = TRUE`** — i.e. the
"double-refund-proof" claim is *exactly equivalent* to the untested external
assumption that Finix dedupes reversals by idempotency id. The emulator has
no `/reversals` endpoint, so this has never been exercised. **The paper's
claim should be downgraded to:** "at most one refund, contingent on Finix
reversal idempotency (documented but untested here); a duplicate render
re-fires the same idempotency id; there is no crash/retry amplification
because the call is fire-and-forget."

## 3. Model-vs-code caveats

- The crash model collapses the zombie lifecycle (TTL sweep after 24 h,
  second restart marking stale INITIATING rows CANCELLED) into the crash
  step's nondeterministic row outcome; both branches were checked.
- Rehydration reading verified against source: SELECT excludes terminal
  states (1629), fast-forward only for `AWAITING_TAP && transferId`
  (1320), stale-INITIATING rewrite without probe (1588–1613). If a future
  code change fast-forwards other states, the ZOMBIE arm of `CrashRestart`
  must be revisited.
- Staleness is bounded to one step (settled-reads-as-PENDING); deeper
  reordering adds no new behaviour over this state space.
- The two-attempt staff policy ("retry only when the order is not visibly
  paid") is an assumption about operator behaviour, stated in the module
  header; dropping it makes even the dashboard path violate I2money (staff
  charging a visibly-paid order is operator error, out of scope).
- `FinixPOSCrash.tla` gained three `Probe_*` reachability invariants
  appended after the initial runs (used by the sub-scenario cfg probes).

## 4. Summary table (new gaps, continuing the results doc's numbering)

| # | gap | found by | pre-fix | post-fix | cheap fix |
|---|---|---|---|---|---|
| 8 | crash during INITIATING strands a live transfer; stale-INITIATING rows are marked CANCELLED without a probe; row has no transfer id | Crash model | violated | **violated** | sweep crashed non-terminal rows by persisted `idempotency_key` |
| 9 | crash in RECORDING (between Finix success and local record) → zombie row, no covering sweep | Crash model | violated | **violated** | widen a sweep to RECORDING (row has transfer id) |
| 9b | crash in CANCELLING → zombie row | Crash model | violated | **violated** | same widening (CANCELLING) |
| 10 | counter path lacks the 409 pending-row guard → post-fix double charge (detected, unremediated) | TwoAttempt model | (subsumed by 2) | **violated** (money), detected | hoist the dashboard 409 guard into `startTerminalPayment` |
| — | stale-probe cancel (gap-5 variant, no error assumption needed) | Stale model | violated | holds (gap-5 sweep) | — |
| — | refund idempotency = untested Finix assumption | Refund model | n/a | conditional | exercise against Finix sandbox; or persist a refund marker |
