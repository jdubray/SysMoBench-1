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
  predicates over reachable states (Phase 4).
- **Phase 3 (transition validation)** — `tools/plain-js/tv.mjs` replays the trace
  windows through `next` (`scripts/plain_js_tv.py`).

Both run in the same locked-down Docker sandbox JS-SAM already uses. Demo:

```
$ python scripts/lean_demo.py
[Phase 2 runtime]      PASS — 18 steps, 3 unique states, classification=None
[Phase 4 invariants]   PASS — 3/3 hold
[Phase 3 transitions]  28/28 = 100.0%
Lean contract runs the full pipeline: ALL PHASES PASS
```

Pass a model-generated lean spec as an argument to score it the same way.

## Integration options for SysMoBench

1. **A lean backend / spec shape (recommended for Phase-3 fidelity).** Offer the
   `{init, next}` contract as a first-class JS spec shape alongside JS-SAM, with
   the generic explorer for Phases 2/4 and the direct `next` replay for Phase 3.
   Cheapest to adopt; the prototype is the reference implementation.
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
- The clean 100% here is for a tiny observable state (`spin`). On richer control
  state the `next` core itself becomes non-trivial, and the lean-vs-SAM gap may
  narrow; the prototype should be re-run on a second task (`ringbuffer`/`locksvc`)
  before generalizing.

## Files

- Contract + reference: `tools/plain-js/reference_spin.js`, prompt
  `tla_eval/tasks/spin/prompts/plain-js/direct_call.txt`.
- Runners: `tools/plain-js/tv.mjs` (Phase 3), `tools/plain-js/explore.mjs`
  (Phases 2/4); Python: `scripts/plain_js_tv.py`.
- Demo: `scripts/lean_demo.py`.
