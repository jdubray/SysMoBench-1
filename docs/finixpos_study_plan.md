# finixpos study plan — JS-SAM vs TLA+ on a real payment state-alignment protocol

**Status:** design (2026-07-03). Extraction: `tla_eval/tasks/finixpos/EXTRACTION.md`.
Methodology inherited from `docs/js_sam_tla_phase3_plan.md` /
`paper/methodology.md`; deltas from the spin study are called out explicitly.

## 0. Why this system

The spin study's target was a 2-action spinlock. `finixpos` is the opposite
end of the difficulty axis: a production POS ↔ PAX A920 ↔ Finix payment
alignment written (by Claude, in SAM semantics) with 9 reachable control
states, 10 actions, two acceptor-level action rewrites, post-state-guarded
mutations (glitch tolerance), an async recovery ladder, and four user-facing
outcomes (Succeeded / Declined / Error / Canceled) that do **not** map 1:1
onto FSM states — `DECLINED` fans out to three user outcomes via
`declineCode`, and `Canceled` is reachable through two FSM states. Two
questions, two deliverables:

- **(a) Correctness:** is the implementation correct for the four outcomes?
  (hand-built faithful models + model checking + invariants over real traces)
- **(b) Language comparison:** does the spin-study result — lean JS contract ≥
  TLA+ ≥ SAM contract, contract ≻ prompt — replicate on a hard, failure-rich,
  real-world protocol, or do the languages separate differently when the
  transition relation is genuinely complex?

## 1. Observable-state contract (pinned, both languages)

```
state = {
  txState:             'IDLE'|'INITIATING'|'AWAITING_TAP'|'AWAITING_VERIFICATION'
                       |'RECORDING'|'COMPLETED'|'DECLINED'|'CANCELLING'|'CANCELLED',
  orderId:             string | null,
  amountCents:         number | null,
  transferId:          string | null,
  declineCode:         string | null,
  approvedAmountCents: number | null,
  paymentId:           string | null,
}
```

This is the projection of `TerminalPaymentModel` onto the fields that the
four outcomes depend on. Excluded as orthogonal: card cosmetics
(brand/last4/approvalCode/entryMode), tips, split metadata, `recordLocally`,
`idempotencyKey`, `startedAt` (timeout is delivered as an explicit action, see
below). TLA+ null sentinel: `NONE == "none"` (numbers use `-1`), exactly as in
the spin constrained prompt.

## 2. Single-step semantics: the SAM dispatch is the step

A trace window is `(pre, action(data), post)` where `action` is a **dispatched
SAM action** with its payload, captured at the entry of the acceptor chain
(i.e. *before* the pre-FSM rewrites), and `post` is the model after the full
acceptor chain. The step is the synchronous SAM dispatch — the natural
transition boundary of the implementation, mirroring how the spin study used
one lock-API call as the step.

Action alphabet (with data):

| action | data | notes |
|---|---|---|
| `INITIATE_PAYMENT` | `{orderId, amountCents}` | from IDLE only; elsewhere observable no-op |
| `TRANSFER_CREATED` | `{transferId}` | rejected (no-op) outside INITIATING |
| `VERIFICATION_STARTED` | `{}` | create-sale ladder exhausted |
| `TAP_APPROVED` | `{approvedAmount}` | **three-way**: RECORDING; rewritten to TAP_DECLINED(`PARTIAL_PAYMENT`) if `approvedAmount < amountCents` in AWAITING_TAP; no-op in terminal states |
| `TAP_DECLINED` | `{declineCode}` | **two-way**: DECLINED normally; CANCELLED when dispatched in CANCELLING (pre-FSM rewrite to internal CANCEL_DECLINED) |
| `PAYMENT_RECORDED` | `{paymentId}` | RECORDING → COMPLETED |
| `CANCEL_PAYMENT` | `{}` | INITIATING/AWAITING_TAP → CANCELLING |
| `CANCEL_CONFIRMED` | `{}` | CANCELLING → CANCELLED |
| `EXIT_FLOW` | `{}` | terminal states → IDLE, nulls transaction fields |

`CANCEL_DECLINED` is internal (acceptor-synthesized) and never appears as a
window action. The async ladders (create-sale recovery, cancel probe, poll)
are the **environment**: they decide *which* actions occur, and the scenario
corpus exercises them; the spec under test models the dispatch-level
transition relation, exactly what SAM's acceptors + FSM implement.

Like spin's held-lock windows, the no-op windows (rejected actions) are
first-class: the contract requires totality — a rejected action yields
`post = pre`, not "no step". This is where the spin study found the entire
TLA+ derivation gap (guard-idiom disabled actions), so `finixpos` retests
that mechanism at higher complexity.

## 3. Trace corpus — real executions

Instrumentation patch to `terminal-payment.ts` (kept in
`data/patches/finixpos_trace.patch`, applied to a copy — upstream source is
never modified in place): an acceptor prepended to the chain snapshots
`(pre, __actionName, data)`; a reactor appended after mutation emits the
NDJSON window with the post snapshot. Runner: `bun` harness in
`scripts/harness/finixpos/` driving the real
`createTerminalPaymentWorkflow` against the repo's own `a920-emulator.ts`
(intercepts the Finix HTTP surface in-process; supports scripted declines,
idempotency-key 422s, and cancel races), with SQLite pointed at a throwaway
DB and `TIMEOUT_MS` shrunk via env for the timeout scenario.

Scenario set (each an independent run; every dispatched action becomes a window):

1. **Succeeded** — initiate → PENDING → poll SUCCEEDED → recorded → exit.
2. **Declined** — poll FAILED(`INSUFFICIENT_FUNDS`) → DECLINED → exit; then a
   *fresh* initiate that succeeds (the production-observed "decline, retry
   worked" pattern — establishes retry is a new key, not a state resurrection).
3. **Error** — (a) immediate FAILED on create (`IMMEDIATE_FAILURE`);
   (b) create network error ×2 → last-gasp cancel probe → VERIFICATION_STARTED
   → sweep resolves approved; (c) same but sweep resolves declined;
   (d) timeout: PENDING forever → CANCEL_PAYMENT(timeout) → CANCELLED.
4. **Canceled** — (a) staff cancel in AWAITING_TAP → CANCEL_CONFIRMED;
   (b) customer cancels on device: poll FAILED(`CANCELLATION_VIA_DEVICE`) →
   DECLINED; (c) **tap-beats-cancel**: CANCELLING → TAP_APPROVED → COMPLETED;
   (d) poll FAILED while CANCELLING → TAP_DECLINED-in-CANCELLING → CANCELLED;
   (e) cancel during INITIATING (probes candidate bug 1 of the extraction).
5. **Glitch/no-op windows** — late TAP_APPROVED in COMPLETED; duplicate
   INITIATE_PAYMENT in AWAITING_TAP; TRANSFER_CREATED in CANCELLING;
   partial approval (`approvedAmount < amountCents`) → DECLINED(`PARTIAL_PAYMENT`).
6. **422 duplicate key** — existing transfer SUCCEEDED / PENDING / FAILED.

Coverage audited the same way as spin (`scripts/trace_coverage_audit.py`
pattern): report observable (pre.txState, action, data-class) combos hit vs
possible, and say explicitly which no-op combos are uncovered.

## 4. Arms

Same contracts as the completed spin factorial, no new prompt engineering:

- **SAM** — the shipped JS-SAM module contract.
- **lean** — bare `next(state, action, data)` (totality forced by contract).
- **TLA+ (constrained)** — pinned `VARIABLES` matching §1, pinned action
  operators, `NONE` sentinel; direct TLC replay via `scripts/tla_direct_tv.py`
  (TVInit pins pre, one step, `NoPost` invariant).

Prompt factor: primary run is **derivation mode (no semantics block)** for all
three arms — the spin study showed the semantics block matters exactly where
the contract under-constrains, and derivation mode is where the languages
actually separated. If budget allows, add the +semantics cells afterwards.

All arms receive the identical source packet: `terminal-payment.ts` verbatim +
the Finix adapter's terminal functions + `terminal-outcome.ts` (same files a
human auditor would read).

Models: Fable 5, Opus 4.8, Sonnet 4.6, Haiku 4.5. **N=5** generations per
model per arm. Scoring: per-window `pass | fail | unscoreable`; pre-registered
conditional + unconditional numbers; generation-level exact permutation test;
per-arm behavioral-uniqueness counts (no pooled-window McNemar).

Validation before any model runs, both directions:
- **Positive control:** a hand-written contract-faithful spec (each language)
  passes every window.
- **Negative control:** mutate the hand spec (drop the CANCELLING rewrite → all
  cancel-race decline windows fail; drop the partial-payment guard → partial
  windows fail) and confirm the replay discriminates.

## 5. Correctness deliverable (a): invariants + model checking

Invariants from EXTRACTION §7 (I1–I6), used two ways:

1. **Trace-level (Phase 4 analogue):** checked over every scenario's full
   trace — e.g. I5 (glitch windows leave state unchanged), I4 (no DECLINED →
   non-EXIT transition), I3 (CANCELLED implies last observed Finix state ≠
   SUCCEEDED unless a RECORDING window intervened).
2. **Model-checking-level:** the hand-built faithful TLA+ model gets an
   explicit environment (Finix transfer lifecycle + poll/cancel/create message
   channels with loss and reordering) and TLC explores it against I1–I3. This
   is what can *prove or refute* the extraction's candidate weaknesses:
   cancel-during-INITIATING stranding a live transfer (bug 1), the 422
   fetch-failure decline with no breadcrumb (bug 2), partial-approval
   non-void (bug 3), AWAITING_VERIFICATION liveness (bug 4). The emulator
   harness then attempts to reproduce any TLC counterexample as a real
   execution — a counterexample that replays on the real code is a confirmed
   bug, not a modeling artifact.

## 6. Pre-committed interpretations for (b)

- Lean-contract ceiling replicates (all models ~100%) → contract minimality +
  totality scales to hard protocols; the spin result was not a toy artifact.
- Lean degrades but TLA+ degrades more → familiarity hypothesis gains the
  strong form on complex systems.
- TLA+ ≥ lean here → complexity is where formal syntax pays; the spin result
  was a floor effect.
- SAM-contract arm is expected lowest in derivation mode (replicating spin);
  if it *reverses* on this system — the source itself is SAM-shaped, so the
  contract matches the source idiom — that is evidence the contract penalty
  is source-shape-dependent, worth its own note.

## 7. Execution order

1. Harness + instrumentation patch + corpus (validated by positive control).
2. Negative controls (mutation discrimination).
3. Hand-built faithful models (JS + TLA+) → deliverable (a) model checking.
4. LLM arms (3 arms × 4 models × N=5 = 60 generations), replay, score.
5. Analysis + write-up mirroring `docs/js_sam_tla_phase3_results.md`.
