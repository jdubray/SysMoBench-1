# Fair Phase-3: JS-SAM vs. TLA+ over the same observable-state contract

**Status:** blockers built + validated (2026-07-02). Full N=5 run pending.

The earlier JS-SAM-vs-TLA+ comparison (`docs/js_sam_vs_tla_comparison.md`) could
not compare Phase 3 fairly: JS-SAM uses a mechanical direct replay, while TLA+
uses a coding-agent path (because each generated TLA+ spec invents its own
variable names, so mapping trace states onto spec states needs intelligence). A
naive comparison would measure the replay machinery, not the specs. This
experiment removes that confound.

## Design (pre-registered)

1. **Equalize the observable-state contract.** Constrain the TLA+ prompt exactly
   as the JS-SAM prompt already is: mandate `VARIABLES lockHeld, lockHolder` and
   `AcquireLock(thread, callType)` / `ReleaseLock(thread)`, matching the trace
   schema, with a TLC-safe `NONE == "none"` sentinel (no unbounded `CHOOSE`).
   Both languages then answer the identical question — *express this system over
   this observable state*. Prompt: `tasks/spin/prompts/direct_call_constrained.txt`.
2. **Direct TLC replay (no agent).** For each window: a tiny TV module pins the
   pre-state in `Init`, takes one step of the window's action, and asserts the
   post-state is unreachable (`INVARIANT NoPost`). A NoPost violation ⇒ the action
   reproduces the transition ⇒ the window **passes**. Mirrors JS-SAM's
   `setState(pre) → action → diff(post)`. Implementation: `scripts/tla_direct_tv.py`.
3. **Checkability policy (two pre-registered numbers).** Each window is
   `pass | fail | unscoreable` (TLC/SANY could not evaluate — e.g. a broken
   contract). Report both:
   - **conditional** = passed / scoreable — modeling fidelity where measurable.
   - **unconditional** = passed / total (unscoreable = fail) — whole pipeline.
   Optionally one symmetric repair round per language.
4. **Kill the single-sample problem.** N=5 generations per model per language
   (40 total). Naturally paired: for each model, every one of the 28 windows has
   a JS-SAM outcome and a TLA+ outcome ⇒ report per-model paired differences
   (sign/McNemar over windows, aggregated across generations), not two noisy means.
5. **Pre-commit the interpretation.** Three publishable outcomes:
   - JS-SAM conformance ≫ TLA+ → host-language familiarity affects modeling
     fidelity, not just checkability (strong hypothesis).
   - Roughly equal → the gap is tooling ergonomics (checkability, config surface);
     "modeling is the hard part" null survives.
   - TLA+ ≫ JS-SAM → formal syntax forces precision loose JS lets models skip
     (the interesting reversal).

> Methodological note to socialize with the Specula team: pinning spec variables
> to the trace schema trades some realism for comparability. Their agent path is
> the realistic ("as-deployed") condition; this constrained direct path is the
> controlled one. Running both arms sidesteps the debate.

## Validation of the two blockers

- **Positive control.** A constrained Opus 4.8 spec (contract followed, no
  `CHOOSE`) scores **28/28 = 100%** on the direct TLC replay (conditional and
  unconditional), 0 unscoreable. The unbounded-`CHOOSE` trap that broke the
  earlier free-form TLA+ was the whole story for Opus.
- **Negative control.** Breaking `ReleaseLock` to a no-op makes all 11 release
  windows **fail** (0/11) while acquires still pass (17/17) → 60.7%. The replay
  discriminates; it does not trivially pass everything.

## What remains

The N=5 × 4-model × 2-language paired run, scriptable off the existing drivers
(`scripts/repair_phase3.py` for JS-SAM replay, `scripts/tla_direct_tv.py` for the
TLA+ replay, the constrained prompt for TLA+ generation).
