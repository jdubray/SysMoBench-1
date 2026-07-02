# JS-SAM Multi-Model Comparison — `spin`

**Task:** `spin` (Asterinas spinlock) · **Backend:** JS-SAM · **Method:** `direct_call`
**Date:** 2026-07-01 · Trace corpus: 28 windows (2 scenarios, real kernel capture)

Three Claude tiers generated a JS-SAM `spin` specification and were scored across
all four phases against the **same** 28-window transition-validation corpus.

| Model | P1 syntax | P2 runtime (states) | P3 transition | P4 invariants |
|---|---|---|---|---|
| Claude Opus 4.8   | PASS | PASS (326,592) | **89.3% (25/28)** | 3/3 |
| Claude Sonnet 4.6 | PASS | PASS (326,592) | **50.0% (14/28)** | 3/3 |
| Claude Haiku 4.5  | PASS | PASS (326,592) | **21.4% (6/28)**  | 3/3 |

## Finding

**Transition validation is the discriminating phase.** All three models pass
syntax (Phase 1), bounded model checking (Phase 2), and invariant verification
(Phase 4) — those phases do not separate the models on this task. Phase 3, which
replays real Asterinas spinlock transitions against each model, produces a clean
capability ordering:

> Opus 4.8 (89.3%) ≫ Sonnet 4.6 (50.0%) ≫ Haiku 4.5 (21.4%)

This matches the models' expected general-capability ordering and confirms that,
for JS-SAM on `spin`, the signal lives in whether the generated model reproduces
the real system's behavior — not in whether it parses, explores cleanly, or
satisfies invariants (which weaker models also achieve). It is the clearest
demonstration so far that Phase 3 against ground-truth traces is what makes
JS-SAM discriminative.

## Notes

- All runs use `direct_call` and the same 28-window corpus
  (`data/sys_traces/spin/*.ndjson`, captured via `scripts/harness/spin/run.sh`).
- The recurring Opus failures are the `try_lock`-from-free transitions described
  in `docs/js_sam_first_experiment.md` §6 (3 of 28 windows).
- Model entries: `claude` (Opus 4.8), `sonnet` (Sonnet 4.6), `haiku`
  (Haiku 4.5) in `config/models.yaml`, all via `ANTHROPIC_API_KEY`.
