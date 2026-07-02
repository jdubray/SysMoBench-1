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
100% while Sonnet cannot fix its release path.** This reframes Fable's baseline
result: its `ReleaseLock` bug was a *recoverable slip*, not a capability ceiling
— once shown the failing transitions, it corrected the whole action. Sonnet's
and Haiku's release failures, by contrast, survive the same feedback.

The takeaway: **one-shot spec accuracy and repair-from-feedback are different
axes.** A model can look mediocre one-shot yet repair perfectly (Fable), and the
repair axis separates the models more cleanly than the baseline scores do.

## Caveats

- The repair prompt contains the failing transitions themselves — this measures
  "can the model use precise, correct feedback," not blind improvement. That is
  the intended question (a repair loop), but it is not a from-scratch re-test.
- **One** repair round only. Sonnet/Haiku might improve further with more rounds;
  not tested here.
- Repaired specs were scored in throwaway workspaces and not checked in; the
  driver regenerates them.
