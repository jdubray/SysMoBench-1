# Fair Phase-3 results: JS-SAM vs. TLA+ (N=5, paired, `spin`)

**Design:** `docs/js_sam_tla_phase3_plan.md` · **Driver:** `scripts/tla_phase3_study.py`
**N=5 generations per model per arm; 28-window kernel corpus; scored per-window.**

Three arms, so the prompt is not a confound:

- **JS(deployed)** — the shipped JS-SAM prompt (does not state the single-step
  observable semantics).
- **JS(constrained)** — the deployed prompt **plus** the exact same single-step
  semantics block the TLA+ arm uses. This is the fair pair with TLA(constrained).
- **TLA(constrained)** — the constrained TLA+ prompt (`lockHeld, lockHolder`,
  `AcquireLock/ReleaseLock`, `NONE == "none"`, explicit single-step semantics).

## Pass rates (mean over 5 generations; unconditional = conditional here — 0 unscoreable everywhere)

| Model | JS (deployed) | JS (constrained) | TLA+ (constrained) |
|---|---|---|---|
| Opus 4.8   | 81.4% | 89.3% | **100%** |
| Fable 5    | 57.9% | 95.7% | **100%** |
| Sonnet 4.6 | 50.0% | **100%** | **100%** |
| Haiku 4.5  | 28.6% | 40.7% | **100%** |

## Paired McNemar over windows (b = JS-only pass, c = TLA-only pass; * = p<0.05)

| Model | JS(deployed) vs TLA | JS(constrained) vs TLA |
|---|---|---|
| Opus   | b=0 c=26 χ²=24.0* | b=0 c=15 χ²=13.1* |
| Fable  | b=0 c=59 χ²=57.0* | b=0 c=6  χ²=4.2*  |
| Sonnet | b=0 c=70 χ²=68.0* | b=0 c=0  χ²=0.0   |
| Haiku  | b=0 c=100 χ²=98.0*| b=0 c=83 χ²=81.0* |

## Findings

**1. Most of the raw "TLA+ ≫ JS-SAM" reversal was prompt prescriptiveness, not
language.** Adding the single-step semantics to the JS prompt closed most of the
gap — Fable 57.9% → 95.7%, Sonnet 50% → 100%. The initial slam-dunk (deployed-JS
vs TLA+) was heavily confounded by my TLA+ prompt spelling out the observable
transitions the JS prompt didn't. Controlling for that was essential.

**2. A real, one-directional residual survives, concentrated in weaker models.**
With identical semantics in both prompts, **TLA+(constrained) reaches 100%
conformance for every model and every generation**, while JS(constrained) does
not for 3 of 4 (Opus 89.3%, Fable 95.7%, Haiku 40.7%; only Sonnet reaches 100%).
Crucially, **b = 0 in every comparison** — no JS-SAM spec ever reproduces a
window that its TLA+ counterpart fails. The advantage is entirely one-directional.
The residual is significant for Opus, Fable, and Haiku, and **vanishes for
Sonnet** (perfect tie).

**3. Where the pre-registered outcomes land.** Not the strong "JS-SAM wins"
(direction is reversed), and not a clean tie either. It is a **partial, modest
version of the "formal directness forces precision" reversal**: given the same
explicit semantics, models transcribe the observable transitions more reliably as
declarative TLA+ state-relations than through JS-SAM's executable machinery — but
strong models close the gap (Sonnet ties, Fable nearly), and the effect is largest
for the weakest (Haiku). A plausible mechanism: a TLA+ action is a direct
state-relation (`lockHeld' = ...`) one line from the semantics statement, whereas a
JS-SAM spec must wire the same behavior through proposals/acceptors/state mutation
and carry auxiliary state (threadStatus/callType) — more surface for a
transcription bug (exactly the `try_lock`-from-free and release bugs seen in
`docs/js_sam_model_comparison.md`).

**4. Checkability was fully solved by the constraint.** 0 unscoreable windows in
either constrained arm across all 40 generations. The earlier TLA+ "1/4
model-checkable" (`docs/js_sam_vs_tla_comparison.md`) was purely the
unbounded-`CHOOSE` trap and config surface — both removed once the prompt pins a
TLC-safe `NONE` and the direct replay drops the config/agent step.

## Caveats

- **Single task (`spin`), one lock, small observable state.** The residual could
  differ on richer control state.
- **Residual substrate asymmetry.** The constrained JS prompt still keeps the
  SAM contract (a 4-key `getState`, executable module), while the TLA+ arm has
  exactly 2 variables and is a declarative relation. Part of the residual is
  "executable machinery + auxiliary state admit bugs a 2-variable relation
  can't." That *is* a real language-substrate difference, but it means the result
  is about the substrates as used here, not JS vs TLA+ in the abstract.
- **This measures transcription fidelity given near-spec-level semantics**, not
  from-scratch derivation. The deployed-JS arm is the closer proxy for "derive it
  yourself," and there the gap is much larger.
- **`b = 0` is partly structural** — TLA+(constrained) fails no windows, so
  "JS-only pass" is impossible by construction; the McNemar reduces to whether
  JS's failure count is significant. Reported for completeness, read with #2.
