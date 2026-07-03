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

## Statistics at the correct unit (retraction + reanalysis)

**Retraction.** An earlier version of this section reported window-level McNemar
tests over the pooled 140 windows per arm (5 generations × 28), with χ² values
up to 81.0. A review correctly identified this as **pseudo-replication**:
generations collapse to 1–2 unique behavioral fingerprints per (model, arm), so
the same underlying bug was counted up to five times and the χ² values were
inflated. Those χ² values are retracted. Reanalysis at the generation level:
`scripts/tla_phase3_analysis.py` (reads the committed raw JSON).

**Uniqueness — behavioral fingerprints per (model, arm), out of 5 generations**
(a fingerprint is the per-window outcome vector; identical fingerprints are the
same evidence whatever the spec text):

| Model | JS (deployed) | JS (constrained) | plain-JS | TLA+ |
|---|---|---|---|---|
| Opus   | 2/5 | 1/5 | 1/5 | 1/5 |
| Fable  | 2/5 | 2/5 | 1/5 | 1/5 |
| Sonnet | 1/5 | 1/5 | 1/5 | 1/5 |
| Haiku  | 1/5 | 2/5 | 1/5 | 1/5 |

Text-level uniqueness of the saved regenerated sets corroborates modest textual
diversity collapsing to fewer behaviors (plain-JS lean spin 9/20 unique texts,
locksvc 11/20, TLA+ audit 10/20 — all with a single behavioral outcome per arm).

**Generation-level exact permutation test** (unit = generation; statistic =
difference in mean per-generation pass rate; all C(10,5)=252 relabelings,
two-sided; the smallest attainable p at 5-vs-5 is 2/252 ≈ 0.0079, so starred
results are at the test's floor):

| Model | JS(deployed) vs TLA | JS(constrained) vs TLA | plain-JS vs TLA |
|---|---|---|---|
| Opus   | Δ=0.186, p=0.0079* | Δ=0.107, p=0.0079* | Δ=0, p=1 |
| Fable  | Δ=0.421, p=0.0079* | Δ=0.043, **p=0.44**  | Δ=0, p=1 |
| Sonnet | Δ=0.500, p=0.0079* | Δ=0, p=1            | Δ=0, p=1 |
| Haiku  | Δ=0.714, p=0.0079* | Δ=0.593, p=0.0079*  | Δ=0, p=1 |

What survives, what changes:

- **Deployed JS-SAM vs TLA+ is significant for all four models** even at the
  conservative unit — the contract-tax effect is not a pooling artifact.
- **Fable's constrained-JS deficit is NOT significant** (p=0.44). The pooled
  McNemar had starred it (χ²=4.2*); that specific claim was pseudo-replication
  and is withdrawn. The constrained-JS gap is significant only for Opus and
  Haiku.
- **plain-JS vs TLA+ is identical** (Δ=0 in every generation) — the tie needs
  no test.
- At the unique-solution unit (n=1–2 per cell) no significance test is
  meaningful; the per-solution effect sizes stand on their own (e.g. Haiku's
  modal SAM solution passes 8/28 while its plain-JS solution passes 28/28).

## Findings

**1. The gap is not JavaScript, and not "formal vs informal." It is the SAM
pattern's machinery.** With a bare `next(state, action, data)` over two keys —
structurally isomorphic to the TLA+ relation — **JavaScript reaches 100% for every
model and every generation, tying TLA+ exactly** (identical outcomes in every
generation; Δ=0). The most dramatic case is Haiku: **40.7% through the SAM
contract → 100% as a plain transition function**. The weakest model expresses the
transition perfectly as a plain function but botches it through SAM's wiring.

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

## Replay-check symmetry (do the two replays check the same relation?)

A review raised that the JS and TLA+ replays were not the same check, and the
asymmetry favored TLA+. The JS replay is **functional**: `next(pre)` yields one
state that must equal `post`. The original TLC replay was **existential**: a
window passed if the action *could* reach `post` from `pre` (`NoPost` violated).
A TLA+ action is a relation, so an over-permissive action passes existentially
while admitting wrong post-states — the negative control (a no-op release) only
proved the replay fails on *unreachable* posts, not on permissive specs.

We addressed this directly (`scripts/tla_direct_tv.py --functional`,
`scripts/tla_functional_audit.py`):

- **Branching-factor check.** For each window we now enumerate the action's
  one-step image from the pinned pre-state and require **branching factor 1**
  (image is exactly `{post}`) — a check as strict as `next(pre) == post`.
- **Permissive negative control** (`tools/tla/permissive_spin.tla`, holder set to
  *any* thread on acquire): passes the **existential** replay 28/28 (100%) but the
  functional check flags 17 windows as over-permissive (branching factor 2) →
  39.3%. So the existential check *is* fooled by a bad spec; the functional check
  is not. (A correct reference spec passes both, 28/28, bf 1.) Fully-mixed
  permissiveness — `lockHolder' \in Threads ∪ {NONE}` — is caught earlier still, as
  *unscoreable*: TLC throws comparing the string sentinel to an integer thread id.
- **Audit of the actual arm.** Re-scoring 20 freshly generated constrained TLA+
  specs (5 × 4 models) under the functional check: **existential = functional =
  140/140 per model, 0 over-permissive windows, max branching factor 1.** Every
  generated spec is deterministic, so the TLA+ 100% is *earned* under the strict
  relation — the asymmetry did not inflate it. The paired study now scores the
  TLA+ arm with the functional check by default, so the comparison is symmetric.

Net: "plain-JS ties TLA+" and "TLA+ hits 100%" now both hold under one functional
check applied to both languages, rather than a harsher check on JS alone.

## Caveats

- **Single task (`spin`), one lock, tiny observable state.** The clean 100% for
  both minimal-shape arms may not hold for richer control state. (Partly addressed
  since: the lean contract holds on `locksvc`, 31 states with a wait queue — see
  `docs/js_sam_lean_contract.md`.)
- **This measures transcription fidelity given near-spec-level semantics**, not
  from-scratch derivation (the deployed-JS arm is the closer proxy for that, and
  its gap is larger).
- **`b = 0` is partly structural** — the TLA+/plain-JS arms fail no windows (now
  confirmed under the functional check, not just the existential one), so
  "other-arm-only pass" is impossible by construction; any paired comparison
  reduces to whether the other arm's failure count is significant — which is now
  assessed with the generation-level permutation test above, not the retracted
  pooled McNemar.
