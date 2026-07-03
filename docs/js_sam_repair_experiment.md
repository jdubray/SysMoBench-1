# JS-SAM Phase-3 Repair-Loop Experiment — `spin`

**Task:** `spin` · **Backend:** JS-SAM · **Method:** `direct_call` + one repair round
**Date:** 2026-07-01 · Trace corpus: 28 windows (real kernel capture)

## Question

If we show a model exactly which transitions its generated spec got wrong
(against the real Asterinas spinlock) and ask it to fix the spec, **does it
self-correct?** And does that ability track model capability?

## Method

For each model, one repair round:

1. Score the model's original `spin.js` on Phase 3 (transition validation).
2. Collect the failing windows and build a repair prompt containing the
   original spec plus, for each failure, the `setState(pre)` state, the action
   and its data, the **real system's** post-state, and what the model's spec
   produced instead.
3. Ask the model to rewrite the entire module so those transitions match.
4. Confirm the repaired spec still compiles (Phase 1), then re-score Phase 3.

Single round, direct call, same 28-window corpus for baseline and repaired.
Driver: `scripts/repair_phase3.py`.

## Results

| Model | Baseline P3 | Repaired P3 | Acquire (base→rep) | Release (base→rep) |
|---|---|---|---|---|
| Claude Opus 4.8   | 89.3% (25/28) | **100% (28/28)** | 82% → 100% | 100% → 100% |
| Claude Fable 5    | 50.0% (14/28) | **100% (28/28)** | 82% → 100% | **0% → 100%** |
| Claude Sonnet 4.6 | 50.0% (14/28) | **60.7% (17/28)** | 82% → 100% | 0% → **0%** |
| Claude Haiku 4.5  | 21.4% (6/28)  | **21.4% (6/28)**  | 35% → **35%** | 0% → 0% |

## Finding

**Self-correction ability is a clean capability gradient — sharper than the
one-shot scores.**

- **Opus 4.8 and Fable 5 fully repair to 100%.** Given their exact failing
  transitions, both produce a perfect spec in one round.
- **Sonnet 4.6 partially repairs** (50% → 60.7%): it fixes the `try_lock`
  acquisition bug (`AcquireLock` 82% → 100%) but **cannot fix `ReleaseLock`**
  (stays 0%). It uses one class of feedback and not the other.
- **Haiku 4.5 does not improve at all** (21.4% → 21.4%): given the exact
  failures, it still cannot fix either action.

### The Fable reversal

Fable 5's baseline looked *worse* than Sonnet's (both 50%, but Fable's failure
was a systematic whole-action `ReleaseLock` defect — see
`docs/js_sam_model_comparison.md`). Yet under repair, **Fable fully recovers to
100% while Sonnet, in this run, could not fix its release path.** This reframes
Fable's baseline result: its `ReleaseLock` bug was a *recoverable slip*, not a
capability ceiling — once shown the failing transitions, it corrected the whole
action. **Caution:** the Sonnet half of this contrast did not replicate — in
the audited re-run below, Sonnet also repaired to 28/28. The stable claims are
Fable's full recovery and Haiku's non-recovery; see the Generalization audit.

The takeaway: **one-shot spec accuracy and repair-from-feedback are different
axes.** A model can look mediocre one-shot yet repair perfectly (Fable), and the
repair axis separates the models more cleanly than the baseline scores do.

## Generalization audit (review follow-up)

A review raised that repaired specs were re-checked only on Phase 1 + Phase 3,
**on the same 28 windows quoted in the repair prompt** — nothing prevented a
repair from memorizing the failing windows (branch on the pre-state, return the
expected post), which would make the result a finding about prompt-following,
not modeling. `scripts/repair_generalization.py` re-ran the repair loop with
artifacts saved (`output/repair_specs/`) and scored every baseline and repaired
spec on four axes:

- **P3-seen** — the original 28 windows (which collapse to only **8 distinct
  (pre, action, data) combos**);
- **P3-heldout** — the **10 combos of the observable domain the corpus never
  shows** (3 pre-states × 6 actions = 18 total): acquire on a held lock,
  release by a non-holder, release of a free lock;
- **P2** — bounded exploration with the distinct-semantic-state metric;
- **P4** — the three observable safety invariants.

| Model | base seen | base held-out | rep seen | rep held-out | rep P2 states | rep P4 |
|---|---|---|---|---|---|---|
| Opus 4.8 | 25/28 | 10/10 | **28/28** | **10/10** | 7 | 3/3 |
| Fable 5 | 14/28 | 10/10 | **28/28** | **10/10** | 7 | 3/3 |
| Sonnet 4.6 | 14/28 | 10/10 | **28/28** | **10/10** | 7 | 3/3 |
| Haiku 4.5 | 6/28 | 10/10 | 6/28 | 10/10 | **1** | 3/3* |

*Haiku's P4 is vacuous over its single reachable state (see the Phase-2 metric
audit in `docs/js_sam_vs_tla_comparison.md`).

**Held-out design limits, stated plainly.** The kernel instrumentation emits
acquire events at acquisition *success*, so no real capture can contain an
acquire-on-held window — the held-out posts are forced by the observable
semantics validated against the kernel on the seen combos, and **every held-out
combo is an observable no-op**. A memorizer whose default branch returns the
state unchanged would therefore pass P3-heldout. Held-out scoring refutes only
memorizers with unsafe defaults; the decisive evidence is inspection:

- **No memorization found.** Zero state-equality tables, window literals, or
  pre-state branch chains in any repaired spec. Fable's and Sonnet's repairs
  are the same *root-cause semantic fix*: the release ownership check moved
  from the auxiliary `threadStatus[t] === 'locked'` guard (unsatisfiable after
  `setState(pre)` with only observable keys) to the authoritative
  `lockHeld`/`lockHolder` — Sonnet's repair even documents the diagnosis in a
  comment ("threadStatus may not reflect 'locked' if state was set via a
  partial snapshot, so we rely on lockHolder as the authoritative source of
  truth"). These are general rules, not window lookups.
- **Repaired dynamics are healthy**: the three repaired specs reach the same 7
  distinct states as a correct spec, and hold all invariants over them. Haiku's
  "repair" kept its argument-dropping intent actions — still inert (1 state).

**Run-to-run variance revises the three-tier claim.** In this audited re-run
Sonnet repaired to 28/28, where the original run stopped at 60.7% — the
original "full / partial / none" three-tier reading rested on a single sample
per model and the middle tier does not replicate. What is stable across both
runs: **Opus and Fable repair fully; Haiku does not repair at all.** Sonnet's
outcome is sampling-dependent at N=1. (The original run's repaired specs were
not saved, so the audited run is the reproducible one.)

Net: on this task the repairs that succeed are genuine modeling fixes — they
diagnose the auxiliary-state defect and restate the general rule — not
prompt-following memorization. But the held-out set's structural weakness (all
no-ops) means a richer task (e.g. `locksvc`, where held-out combos change
state) is the right vehicle for a stronger version of this audit.

## Caveats

- The repair prompt contains the failing transitions themselves — this measures
  "can the model use precise, correct feedback," not blind improvement. That is
  the intended question (a repair loop), but it is not a from-scratch re-test.
- **One** repair round only. Haiku might improve with more rounds; not tested.
- **Single sample per model per run.** The Sonnet discrepancy above (60.7% vs
  100% across two runs) shows single-round repair outcomes are noisy for
  mid-tier models; tier claims need N>1.
- Repaired specs from the audited run are checked in under
  `output/repair_specs/`; raw results in `output/repair_generalization.json`.
