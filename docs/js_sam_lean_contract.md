# Prototype: a lean JS-SAM spec contract

**Status:** prototype (2026-07-02). Motivated by `docs/js_sam_tla_phase3_results.md`.

## Motivation

The paired Phase-3 study showed the JS-SAM conformance gap (vs TLA+) is **the SAM
pattern's machinery, not JavaScript**: a bare `next(state, action, data)` over the
two observable keys ties TLA+ at 100% for every model (Haiku 40.7% → 100%). The
SAM contract's defect surface — routing each transition through
proposals/acceptors/intent-firing and carrying mandatory auxiliary state
(`threadStatus`, `callType`) — is where models introduce the `try_lock`/release
bugs. Removing that ceremony recovers the fidelity.

## The lean contract

A lean spec is a CommonJS module over the **observable** state only:

```js
module.exports = { init, next };

// init() -> initial observable state
function init() { return { lockHeld: false, lockHolder: null }; }

// next(state, action, data) -> new observable state  (pure; no mutation)
//   action: 'AcquireLock' | 'ReleaseLock'
//   data:   { thread, callType } | { thread }
function next(state, action, data) { /* ... */ }
```

It is the JavaScript analogue of the constrained TLA+ relation — one step,
observable state in, observable state out — with no library, no event loop, no
auxiliary variables. Reference: `tools/plain-js/reference_spin.js`.

## The lean contract runs the whole pipeline (no SAM)

The SAM machinery exists to support the behavior explorer used by Phases 2 and 4.
This prototype shows a lean spec supports all of Phases 2/3/4 with a generic
explorer instead:

- **Phase 2 (bounded exploration)** and **Phase 4 (invariants)** —
  `tools/plain-js/explore.mjs` BFS-explores `init`/`next` over the action domain,
  checking crashes / determinism / serializable state (Phase 2) and safety
  predicates over reachable states (Phase 4). It also supports **bounded
  progress checks** (EF-reachability: from every reachable state satisfying a
  premise, a goal state must be reachable within the bound). These catch defect
  classes safety invariants provably cannot — a never-releasing lock satisfies
  mutual exclusion *because* it is broken, but fails `ReleaseProgress`; an inert
  spec fails `AcquireProgress`. They are not liveness checks (no fairness,
  bounded horizon) and are labeled as such.
- **Phase 3 (transition validation)** — `tools/plain-js/tv.mjs` replays the trace
  windows through `next` (`scripts/plain_js_tv.py`).

Both run in the same locked-down Docker sandbox JS-SAM already uses. Demo on the
reference spec:

```
$ python scripts/lean_demo.py
[Phase 2 runtime]      PASS — 18 steps, 3 unique states, classification=None
[Phase 4 safety]       PASS — 3/3 hold
[Phase 4 progress (bounded EF, not liveness)]  PASS — 2/2 hold
[Phase 3 transitions]  28/28 = 100.0%
Lean contract runs the full pipeline: ALL PHASES PASS
```

(All 40 saved model-generated lean specs — 20 spin, 20 locksvc — also pass the
progress checks, so the strengthened Phase 4 hardens rather than overturns the
20/20 results below.)

### Demonstrated on model-generated specs (N=5, four models)

The demo above uses a hand-written reference spec. `scripts/lean_full_pipeline_study.py`
closes the loop: it generates N lean specs per model from the plain-JS prompt,
**saves each one**, and runs Phases 2/3/4 on the *same* saved spec. Every generated
spec passes every phase:

| Model | loadable | Phase 2 clean | Phase 3 = 28/28 | Phase 4 hold | **all phases** |
|---|---|---|---|---|---|
| Opus 4.8 | 5/5 | 5/5 | 5/5 | 5/5 | **5/5** |
| Fable 5 | 5/5 | 5/5 | 5/5 | 5/5 | **5/5** |
| Sonnet 4.6 | 5/5 | 5/5 | 5/5 | 5/5 | **5/5** |
| Haiku 4.5 | 5/5 | 5/5 | 5/5 | 5/5 | **5/5** |

**20/20 model-generated lean specs pass every phase.** This merges the two earlier
half-results — the prototype validated Phases 2/4 on a reference spec; the paired
study validated Phase 3 on model-generated specs — into a single coherent artifact
set: the saved specs (`output/lean_specs/`) and per-spec per-phase results
(`output/lean_full_pipeline.json`) are the same 20 files across all phases.

### Second task: locksvc (richer state — de-tinies and de-converges)

`spin`'s observable state is tiny (3 reachable states, two scalar keys), so two
worries remained: the clean 100% might be an artifact of a trivial state space,
and models might all converge on one solution. A second, structurally different
task settles both. **locksvc** is PGo's centralised lock service (one server, N
clients); its observable state is `{ holder, waiters }` — a lock holder plus a
**waiting set** (an unbounded collection, not a scalar), with four actions
(`ClientLockRequest`, `ServerGrantLock`, `ClientCriticalSection`,
`ClientUnlockRequest`). Traces are captured from the real Go implementation with
a distsys trace recorder (`scripts/harness/locksvc/`), then folded to observable
`(pre, action, post)` windows (60 windows over 5 runs).

> **Corpus correction (found by the base-rate audit).** The first version of
> this corpus modeled `waiters` as a FIFO in *client-send* order and required
> grants to go to the head. The real server grants in **arrival** order, which
> network/goroutine scheduling reorders relative to send order (one capture
> logged sends 1,3,2 while the server queued `<<3,2,1>>` — the exact
> reordering the upstream `locksvc.tla` NoPriorityInversion comment warns
> about). The old fold silently turned 10 real grants/releases into no-op
> windows — wrong ground truth. Arrival order is not a function of the
> client-side single steps, so at this projection `waiters` is a **set**
> (canonically sorted array) and a grant may go to any waiter of a free lock.
> The corpus was re-folded (now: 15 no-change windows, all legitimately the
> `ClientCriticalSection` no-ops — identity base rate 15/60 = 25%), the
> reference/prompt updated, and the study regenerated from scratch.

Same study, `--task locksvc`, on the corrected corpus (fresh generations;
scored on all phases including the bounded progress checks):

| Model | loadable | Phase 2 clean | Phase 3 = 60/60 | Phase 4 hold | **all phases** |
|---|---|---|---|---|---|
| Opus 4.8 | 5/5 | 5/5 | 5/5 | 5/5 | **5/5** |
| Fable 5 | 5/5 | 5/5 | 5/5 | 5/5 | **5/5** |
| Sonnet 4.6 | 5/5 | 5/5 | 5/5 | 5/5 | **5/5** |
| Haiku 4.5 | 5/5 | 5/5 | 5/5 | 5/5 | **5/5** |

**20/20 again**, on a task whose bounded exploration reaches **20 states** (vs
spin's 3) and whose reference model must manage a waiting set. The solutions
**de-converge**: 14 distinct spec texts of 20 (4/4/4/2 unique per model for
Opus/Fable/Sonnet/Haiku; spin: 9/20) — genuinely different correct
implementations, all passing every phase. Conditional on the 45 state-changing
windows (excluding the 15 CS freebies): still 45/45 for every spec. Artifacts:
`output/lean_specs_locksvc/`, `output/lean_full_pipeline_locksvc.json`, traces
`data/sys_traces/locksvc/`.

## Integration options for SysMoBench

1. **A lean backend / spec shape (recommended for Phase-3 fidelity).** Offer the
   `{init, next}` contract as a first-class JS spec shape alongside JS-SAM, with
   the generic explorer for Phases 2/4 and the direct `next` replay for Phase 3.
   Cheapest to adopt; the prototype is the reference implementation, and the
   N=5×4-model run above shows model-generated lean specs already pass the whole
   pipeline end-to-end — this path is demonstrated, not just plausible.
2. **Hybrid: lean core, SAM scaffolding auto-generated.** Keep the SAM pattern for
   its modeling story, but have the model write only the pure `next` core and let
   the harness wrap it in the SAM boilerplate for Phases 2/4. The model never
   writes SAM ceremony, so the ceremony bugs vanish while the SAM explorer is
   retained. (Not prototyped here; a `next → SAM module` adapter is the missing
   piece.)
3. **Status quo, documented.** Keep JS-SAM as-is but report that its Phase-3 gap
   is a contract-ceremony artifact, not a language or modeling limitation.

## Tradeoffs

- SAM's value proposition is a *familiar JavaScript pattern grounded in TLA+
  semantics* — the leaner the contract, the less it exercises "can the model use
  the pattern," which is part of the original hypothesis. Options 1 and 2 keep JS
  familiarity while removing the fidelity tax; option 2 also keeps the pattern.
- The tiny-state and convergence worries are now controlled by the second task:
  `locksvc` reaches 20 states with a real waiting set and still gives 20/20, with
  14/20 distinct solutions. Two tasks is still a small base — a distributed task
  with genuinely concurrent holders (multiple `hasLock` clients, not just the
  single-holder projection here), or a data structure like `ringbuffer` whose
  `next` core is arithmetic-heavy, would further test where (if anywhere) the lean
  contract's advantage narrows. The plumbing is now task-agnostic
  (`scripts/lean_task_config.py`), so adding a third task is prompt + traces only.

## Files

- Contract + references: `tools/plain-js/reference_spin.js`,
  `tools/plain-js/reference_locksvc.js`; prompts
  `tla_eval/tasks/{spin,locksvc}/prompts/plain-js/direct_call.txt`.
- Per-task config (action domain + invariants + reference): `scripts/lean_task_config.py`.
- Runners: `tools/plain-js/tv.mjs` (Phase 3, task-agnostic projection rule),
  `tools/plain-js/explore.mjs` (Phases 2/4); Python: `scripts/plain_js_tv.py`.
- Demo: `scripts/lean_demo.py --task {spin,locksvc}` (reference spec, all phases).
- End-to-end study: `scripts/lean_full_pipeline_study.py --task {spin,locksvc}`
  (N generations/model through all phases). Artifacts:
  `output/lean_specs[_<task>]/<model>_<gen>.js`, `output/lean_full_pipeline[_<task>].json`.
- locksvc trace capture: `scripts/harness/locksvc/` — `run.sh` (PGo `go test` with
  a trace recorder) → `parse_traces.py` (PGo-native events) → `build_windows.py`
  (fold to `{holder, waiters}` observable windows). Corpus: `data/sys_traces/locksvc/`.
