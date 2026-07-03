# Methodology note — a comparable Phase-3 (transition validation) across specification languages

**Scope.** This note documents the experimental methodology for comparing an
LLM's Phase-3 *transition-validation* conformance across two specification
languages — TLA+ and JavaScript/SAM (JS-SAM) — on the SysMoBench `spin` task. It
is written to be socialized with the SysMoBench (Specula) maintainers, because it
relies on one methodological choice — pinning generated-spec variables to the
trace schema — that trades some realism for comparability and deserves their
input. It is not a results report; headline numbers live in
`docs/js_sam_tla_phase3_results.md`.

---

## 1. The comparability problem

SysMoBench Phase 3 replays real system-execution traces against a generated
specification: for each observed transition `(pre, action, post)`, does the spec,
started from `pre` and stepped by `action`, reach `post`? The two backends
implement this so differently that a naive cross-language comparison measures the
*replay machinery*, not the specs:

- **JS-SAM** runs a mechanical direct replay: `setState(pre)`, `actions[name](data)`,
  then diff `getState()` against `post`. No model in the loop.
- **TLA+** runs a coding-agent path: because each generated TLA+ spec invents its
  own variable names, mapping a trace state onto spec state requires
  interpretation, which the harness delegates to a coding agent (Claude Code /
  Codex).

An agent-mediated arm versus a mechanical arm is not a like-for-like measurement.
The methodology below removes that asymmetry.

---

## 2. Design

### 2.1 Equalize the observable-state contract

The reason TLA+ needs an agent is a *degree of freedom* — free choice of variable
names — that JS-SAM already removes (its prompt pins `getState()`'s shape). We
remove the same degree of freedom on the TLA+ side: the constrained TLA+ prompt
(`tla_eval/tasks/spin/prompts/direct_call_constrained.txt`) mandates

- `VARIABLES lockHeld, lockHolder` (matching the trace's observable state), and
- action operators `AcquireLock(thread, callType)` / `ReleaseLock(thread)`,

with a TLC-safe sentinel `NONE == "none"` (not `CHOOSE`). Both languages are then
asked the identical question — *express this system over this observable state* —
so trace states map onto spec states with no interpretation, and the agent is no
longer needed. This is defensible because the JS-SAM contract already imposes the
same constraint via `getState()`.

### 2.2 A direct TLC replay path (no agent)

With the state contract fixed, TLA+ transition validation becomes mechanical,
mirroring JS-SAM's `setState → action → diff`. For each window we synthesize a
tiny TV module (`scripts/tla_direct_tv.py`) that `EXTENDS` the generated `spin`
spec and:

- `TVInit` pins the pre-state (`lockHeld`, `lockHolder`) and a boolean `tv_stepped = FALSE`;
- `TVNext` takes **exactly one** step of the window's action
  (`~tv_stepped /\ tv_stepped' = TRUE /\ AcquireLock(0, "lock")`), then stutters
  (avoiding a deadlock report);
- invariant `NoPost == ~(tv_stepped /\ PostReached)` asserts the post-state is
  unreachable.

TLC reporting a `NoPost` violation ⇒ the action reaches `post` in one step ⇒ the
window **passes**. This is the standard TLC trace-validation trick; it removes the
agent confound entirely. (The existing agent path can be retained as a secondary
"as-deployed" arm; the direct path is the apples-to-apples number.)

*Discrimination check.* The replay was validated in both directions: a
contract-following spec passes all 28 windows, and a spec whose `ReleaseLock` is
mutated to a no-op fails exactly the 11 release windows (60.7%). It is not a
trivial pass-everything.

### 2.3 Checkability policy — two pre-registered numbers

Some specs may be unscoreable (SANY/TLC cannot evaluate — e.g. a broken contract).
We classify each window `pass | fail | unscoreable` and pre-register two metrics
rather than choosing after the fact:

- **conditional** = passed / scoreable — modeling fidelity where measurable;
- **unconditional** = passed / total (unscoreable counts as fail) — the whole
  pipeline.

The hypothesis predicts differently for each: the unconditional gap should favor
JS-SAM on structural grounds (no config surface, no `CHOOSE` trap); the
conditional comparison is the genuinely open question.

### 2.4 Pairing and replication

Variance matters here because the headline is a language difference. We run **N=5**
generations per model per arm (spinlock specs are short, so this is cheap). The
design is naturally **paired**: for each model, each of the 28 windows receives an
outcome in every arm. *(Revised after review: the original plan pooled windows
across generations into a McNemar test — pseudo-replication, since generations
collapse to 1–2 unique behavioral fingerprints per arm, so the same defect gets
counted up to five times and the χ² is inflated. The analysis of record is per-arm
uniqueness counts plus an exact generation-level permutation test — unit =
generation, statistic = difference in mean pass rate, all C(10,5)=252 relabelings,
two-sided, minimum attainable p ≈ 0.0079. See `scripts/tla_phase3_analysis.py`.)*

### 2.5 A four-arm design that isolates prompt, language, and pattern

An early two-arm run (deployed-JS vs constrained-TLA) produced a large TLA+
advantage — but the constrained TLA+ prompt *states the exact single-step
observable semantics* ("free → acquire; held → unchanged; holder → release"),
which the deployed JS-SAM prompt does not. That difference is in the **prompt**,
not the language. Each successive arm removes one alternative explanation:

- **JS(deployed)** — the shipped JS-SAM prompt (no explicit single-step semantics).
- **JS(constrained)** — the deployed prompt **plus the identical semantics block**
  used by the TLA+ arm. `JS(constrained)` vs `TLA(constrained)` isolates the
  *language*, since the prompts now carry the same content and differ only in the
  language-specific contract.
- **plain-JS** — a bare `next(state, action, data) → {lockHeld, lockHolder}` pure
  function: **no SAM library, two keys only** — structurally isomorphic to the
  TLA+ relation. `plain-JS` vs `TLA(constrained)` isolates the *SAM pattern's
  machinery*: same language as the JS arms, but the minimal declarative shape of
  the TLA+ arm.
- **TLA(constrained)** — the constrained TLA+ relation.

Reading the arms in order attributes the gap to a single cause. If the residual
under `JS(constrained)` disappears under `plain-JS`, the cause is the SAM
contract's wiring (proposals/acceptors + mandatory auxiliary state), not the
language and not "formal vs informal." (It does — see §7.)

---

## 3. Scoring details

- The observable state compared is `{lockHeld, lockHolder}`; JS-SAM's projection
  rule already restricts to keys present in the trace's post-state, and the
  constrained TLA+ spec has exactly those two variables.
- JS-SAM per-window outcomes: if the module fails to load, all 28 windows are
  `unscoreable`; otherwise `validate_transitions` yields per-window pass/fail
  (failed indices from `transition_failures.json`).
- TLA+ per-window outcomes: `pass` on a `NoPost` violation, `fail` on clean
  completion with no violation, `unscoreable` on any SANY/TLC evaluation error.
- The trace corpus is 28 windows from a real Asterinas spinlock run under QEMU
  (two 2-thread scenarios; `data/sys_traces/spin/*.ndjson`,
  `scripts/harness/spin/run.sh`), identical across all arms.

---

## 4. Threats to validity

- **Single task, one lock, tiny observable state.** The residual language effect
  may not generalize to richer control state.
- **Residual substrate asymmetry.** The constrained JS arm still keeps the SAM
  contract — an executable module with a 4-key `getState` and auxiliary state —
  while the TLA+ arm is a 2-variable declarative relation. Part of any residual is
  "executable machinery + auxiliary state admit transcription bugs a 2-variable
  relation cannot." That is a genuine property of the substrates *as used here*,
  not a claim about JS vs TLA+ in the abstract.
- **Transcription vs derivation.** With the semantics block, both constrained arms
  measure transcription fidelity given near-spec-level semantics, not from-scratch
  modeling. The deployed-JS arm is the closer proxy for "derive it yourself," and
  its gap is much larger — so the effect size depends heavily on how much the
  prompt hands over.
- **`b = 0` is partly structural, and the effective sample is small.** When one
  arm scores 100% it fails no windows, so "other-arm-only pass" is impossible by
  construction; any paired comparison reduces to whether the other arm's failure
  count is significant — assessed at the generation level, not over pooled
  windows. At the strictest unit (unique solutions, n=1–2 per cell) only effect
  sizes are meaningful.
- **Direct vs as-deployed replay.** The direct TLC path is the controlled
  condition; it is not what the benchmark ships. Running both arms (direct +
  agent) is the way to report both the controlled effect and ecological validity.

---

## 5. The choice to socialize

Pinning generated-spec variables to the trace schema is a methodological decision
with a real trade-off:

- **For comparability (controlled condition):** it removes the free-variable
  degree of freedom, makes the replay mechanical in both languages, and lets the
  same question be posed identically. It is the only way to get an agent-free,
  apples-to-apples Phase-3 number.
- **Against (realism / as-deployed condition):** the SysMoBench TLA+ path
  deliberately lets models choose their own abstraction, and the agent-based
  mapping is the realistic deployment. Constraining the vocabulary tests a
  narrower skill (fill in a fixed contract) than free modeling.

There is a reasonable argument that the agent path is the *realistic* condition
and the constrained direct path is the *controlled* one. **Running both arms
sidesteps the debate** — report the controlled number for the clean language
comparison and the as-deployed number for ecological validity. The open question
for the maintainers is whether the benchmark should offer a "pinned-schema"
Phase-3 mode as a first-class controlled condition alongside the agent path.

---

## 6. Reproducibility

- Prompts: `tla_eval/tasks/spin/prompts/direct_call_constrained.txt` (TLA+),
  `.../js-sam/direct_call_constrained.txt` (constrained JS-SAM),
  `.../plain-js/direct_call.txt` (plain-JS).
- Replay paths: `scripts/tla_direct_tv.py` (direct TLC), `scripts/plain_js_tv.py`
  + `tools/plain-js/tv.mjs` (sandboxed plain-JS).
- Paired driver (four arms, N=5): `scripts/tla_phase3_study.py`
  (resumable; raw per-window data in `output/tla_phase3_study.json`);
  generation-level analysis (uniqueness + exact permutation test):
  `scripts/tla_phase3_analysis.py`.
- Corpus + capture harness: `data/sys_traces/spin/`, `scripts/harness/spin/run.sh`.
- Design + pre-registration: `docs/js_sam_tla_phase3_plan.md`;
  results: `docs/js_sam_tla_phase3_results.md`.

---

## 7. Result (summary)

Pass rate (mean over N=5; `spin`; 0 unscoreable in the three constrained arms):

| Model | JS(deployed) | JS(constrained) | plain-JS | TLA+(constrained) |
|---|---|---|---|---|
| Opus 4.8   | 81.4% | 89.3% | **100%** | 100% |
| Fable 5    | 57.9% | 95.7% | **100%** | 100% |
| Sonnet 4.6 | 50.0% | 100%  | **100%** | 100% |
| Haiku 4.5  | 28.6% | 40.7% | **100%** | 100% |

Reading the arms in order:
1. **Prompt** explains most of the raw reversal — the semantics block alone lifts
   JS-SAM sharply (Fable 58→96%, Sonnet 50→100%).
2. **Language** does *not* explain the residual — plain-JS ties TLA+ at 100% for
   every model (identical outcomes in every generation; Δ=0, no test needed).
3. **The SAM pattern's machinery** is the whole residual: the same JavaScript, in a
   minimal declarative `next()` shape, is perfect; wrapped in SAM's
   proposals/acceptors + mandatory auxiliary state, it is not (Haiku 40.7% → 100%).

The dividing line is spec *structure* (minimal single-step transition relation),
not language family. Design implication for SysMoBench: a leaner JS-SAM spec
contract — a `next(state, action, data)` core over the observable variables —
recovers Phase-3 fidelity, decoupled from the SAM explorer features used by Phases
2 and 4. See `docs/js_sam_lean_contract.md` for the prototype.
