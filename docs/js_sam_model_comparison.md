# JS-SAM Multi-Model Comparison — `spin`

**Task:** `spin` (Asterinas spinlock) · **Backend:** JS-SAM · **Method:** `direct_call`
**Date:** 2026-07-01 · Trace corpus: 28 windows (2 scenarios, real kernel capture)

Four Claude models generated a JS-SAM `spin` specification and were scored across
all four phases against the **same** 28-window transition-validation corpus.

| Model | P1 syntax | P2 runtime (distinct states) | P3 transition | P4 invariants |
|---|---|---|---|---|
| Claude Opus 4.8   | PASS | PASS (7) | **89.3% (25/28)** — Acquire 88%, Release 100% | 3/3 |
| Claude Fable 5    | PASS | PASS (7) | **50.0% (14/28)** — Acquire 82%, **Release 0%** | 3/3 |
| Claude Sonnet 4.6 | PASS | PASS (7) | **50.0% (14/28)** | 3/3 |
| Claude Haiku 4.5  | PASS | PASS (**1** — vacuous) | **21.4% (6/28)**  | 3/3 |

> **Metric correction.** This table originally showed "PASS (326,592)" for every
> model. That number is the checker's *step count* — safety-callback invocations
> over the intent-permutation tree, `(depth+1)·6^depth = 7·6⁶` — identical for
> any spec honoring the pinned intent domain and therefore model-independent.
> The cells now show **distinct semantic states** (unique model snapshots
> reached). Haiku's spec never leaves its initial state (its intent actions drop
> their arguments, so every proposal is rejected): its P2 PASS is vacuous, which
> the old metric could not reveal. Full audit: "Phase-2 metric audit" in
> `docs/js_sam_vs_tla_comparison.md`.

## Finding

**Transition validation is the discriminating phase.** Every model passes syntax
(Phase 1), bounded model checking (Phase 2), and invariant verification (Phase 4)
— those phases do not separate the models on this task. Only Phase 3, which
replays real Asterinas spinlock transitions against each generated model, spreads
them out:

> Opus 4.8 (89.3%) ≫ Fable 5 = Sonnet 4.6 (50.0%) ≫ Haiku 4.5 (21.4%)

This confirms that, for JS-SAM on `spin`, the signal lives in whether the
generated model reproduces the **real system's behavior** — not in whether it
parses, explores cleanly, or satisfies invariants (which even the weakest model
achieves). The distinct-state audit sharpens this: Phase 2 passed even a spec
with a one-state reachable space, and Phase 4's invariants were then satisfied
vacuously over that single state — so P2/P4 PASS without a distinct-state check
is weaker evidence than this table's original framing implied.

### General capability does not predict spec-modeling accuracy

The most striking result is **Claude Fable 5** — Anthropic's most capable model —
scoring only 50.0%, *below* Opus 4.8 and tied with the mid-tier Sonnet. The
cause is specific and systematic, not noise: Fable's model handles acquisition
reasonably (82.4%) but **no-ops every `ReleaseLock`** (0 of 11). After a release,
its model leaves the lock held (`lockHeld` stays `true`, the holder is not
cleared), so every release transition diverges from the real system:

```
ReleaseLock  expected {lockHeld: false, lockHolder: null}
             got      {lockHeld: true,  lockHolder: 0}
```

Its release *logic* reads correctly in isolation (guard on holder, then clear
state), but in practice the release never takes effect on replay — a categorical
modeling defect in one action. That a top-capability model can produce a spec
with a whole-action bug, while passing Phases 1/2/4, is exactly the kind of
signal transition validation exists to surface: **benchmark capability rankings
do not automatically transfer to formal-modeling accuracy.**

## Notes

- All runs use `direct_call` and the same 28-window corpus
  (`data/sys_traces/spin/*.ndjson`, captured via `scripts/harness/spin/run.sh`).
- The recurring Opus failures are the `try_lock`-from-free transitions described
  in `docs/js_sam_first_experiment.md` §6 (3 of 28 windows).
- Model entries: `claude` (Opus 4.8), `fable` (Fable 5), `sonnet` (Sonnet 4.6),
  `haiku` (Haiku 4.5) in `config/models.yaml`, all via `ANTHROPIC_API_KEY`.
  Fable 5 sends no sampling params or thinking config (both removed on that
  model); the adapter's `_should_omit_sampling_params` covers it.
