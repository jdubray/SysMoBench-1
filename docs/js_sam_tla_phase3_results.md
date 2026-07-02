# Fair Phase-3 results: what drives the JS-SAM–vs–TLA+ gap (N=5, paired, `spin`)

**Design:** `docs/js_sam_tla_phase3_plan.md` · **Driver:** `scripts/tla_phase3_study.py`
**N=5 generations per model per arm; 28-window kernel corpus; scored per-window.**

Four arms isolate, in turn, the prompt, the language, and the SAM pattern:

- **JS(deployed)** — the shipped JS-SAM prompt (does not state the single-step semantics).
- **JS(constrained)** — deployed prompt **+ the same single-step semantics block** the TLA+ arm uses.
- **plain-JS** — a bare `next(state, action, data) → {lockHeld, lockHolder}` pure
  function: **no SAM library, two keys only** — structurally isomorphic to the TLA+ relation.
- **TLA+(constrained)** — the constrained TLA+ prompt.

All arms use identical source, the identical semantics block (except the deployed
JS arm), and the identical 28-window corpus.

## Pass rates (mean over 5 generations; 0 unscoreable everywhere → conditional = unconditional)

| Model | JS (deployed) | JS (constrained) | plain-JS | TLA+ (constrained) |
|---|---|---|---|---|
| Opus 4.8   | 81.4% | 89.3% | **100%** | **100%** |
| Fable 5    | 57.9% | 95.7% | **100%** | **100%** |
| Sonnet 4.6 | 50.0% | 100%  | **100%** | **100%** |
| Haiku 4.5  | 28.6% | 40.7% | **100%** | **100%** |

## Paired McNemar over windows (b = JS-only pass, c = TLA-only pass; * = p<0.05)

| Model | JS(constrained) vs TLA | plain-JS vs TLA |
|---|---|---|
| Opus   | b=0 c=15 χ²=13.1* | b=0 c=0 χ²=0.0 |
| Fable  | b=0 c=6  χ²=4.2*  | b=0 c=0 χ²=0.0 |
| Sonnet | b=0 c=0  χ²=0.0   | b=0 c=0 χ²=0.0 |
| Haiku  | b=0 c=83 χ²=81.0* | b=0 c=0 χ²=0.0 |

## Findings

**1. The gap is not JavaScript, and not "formal vs informal." It is the SAM
pattern's machinery.** With a bare `next(state, action, data)` over two keys —
structurally isomorphic to the TLA+ relation — **JavaScript reaches 100% for every
model and every generation, tying TLA+ exactly** (McNemar b=0, c=0 for all four
models). The most dramatic case is Haiku: **40.7% through the SAM contract → 100%
as a plain transition function**. The weakest model expresses the transition
perfectly as a plain function but botches it through SAM's wiring.

**2. What the SAM contract adds is the defect surface.** JS-SAM requires the model
to route the transition through proposals → acceptors → intent firing → state
mutation, and to carry auxiliary state (`threadStatus`, `callType`) the contract
mandates. Each is a place a correct observable transition can go wrong — exactly
the `try_lock`-from-free and `ReleaseLock` bugs seen in
`docs/js_sam_model_comparison.md`. Strip the ceremony and the auxiliary state, and
the bugs disappear.

**3. The dividing line is spec *structure*, not language family.** TLA+ (a
declarative state-relation) and plain-JS (a pure two-key transition function) are
the same *shape* — one step, observable state in, observable state out — and both
score 100%. JS-SAM is a different shape (executable event-loop machinery over
richer state), and it lags. This reframes the earlier partial "formal directness
forces precision" reading: it was never TLA+'s formality; it was the minimal
declarative shape that TLA+ happened to have and SAM-JS didn't.

**4. Prompt prescriptiveness was a large confound (controlled).** Before the
plain-JS arm settled it, the raw deployed-JS-vs-TLA reversal was mostly the prompt:
adding the semantics block to the JS prompt closed most of the gap (Fable 58→96%,
Sonnet 50→100%). The residual that survived *that* control (Opus, Fable, Haiku
still < 100% under SAM) is what the plain-JS arm now fully explains as SAM
machinery.

**5. Checkability was solved by the constraint.** 0 unscoreable windows across all
60 constrained/plain/TLA generations. The earlier TLA+ "1/4 model-checkable"
(`docs/js_sam_vs_tla_comparison.md`) was purely the unbounded-`CHOOSE` trap and
config surface, both removed once the prompt pins a TLC-safe `NONE` and the replay
drops the config/agent step.

## Design implication for JS-SAM

The Phase-3 fidelity gap is not a language limitation and not inherent to modeling
the lock — it is the cost of the SAM spec contract. A **leaner JS-SAM contract**
recovers the fidelity: e.g. score against a plain `getState`/transition core over
only the observable variables, drop the mandatory auxiliary state, or offer a
`next(state, action, data)` spec shape as the JS analogue of the TLA+ relation.
The SAM ceremony buys explorer/behavior features (Phases 2/4) but costs Phase-3
conformance; the two can be decoupled.

## Caveats

- **Single task (`spin`), one lock, tiny observable state.** The clean 100% for
  both minimal-shape arms may not hold for richer control state, where the plain
  transition function itself becomes non-trivial.
- **This measures transcription fidelity given near-spec-level semantics**, not
  from-scratch derivation (the deployed-JS arm is the closer proxy for that, and
  its gap is larger).
- **`b = 0` is partly structural** — the TLA+/plain-JS arms fail no windows, so
  "other-arm-only pass" is impossible by construction; the McNemar reduces to
  whether the other arm's failure count is significant.
