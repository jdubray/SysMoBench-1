#!/usr/bin/env python3
"""Prototype demo: the lean JS-SAM contract runs the full Phase pipeline (2/3/4)
without the SAM library.

Given a lean spec exporting { init, next } over the observable state
{ lockHeld, lockHolder }, this runs:
  - Phase 2 (bounded exploration): no crashes / determinism / serializable state,
  - Phase 4 (invariants): safety predicates over reachable states,
  - Phase 3 (transition validation): the 28-window kernel corpus,
all in the same locked-down sandbox used by JS-SAM. Defaults to the reference
lean spec; pass a path to score a model-generated one.

Usage:
    python scripts/lean_demo.py [path/to/lean_spin.js]
Requires Docker + the node:20-slim image.
"""
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))
sys.path.insert(0, str(PROJECT_ROOT / "scripts"))

from plain_js_tv import plain_js_tv, plain_js_explore
from tla_eval.evaluation.semantics.trace_loader import load_trace_windows

# Spin action input domain (both threads, both call types).
ACTIONS = [
    {"action": "AcquireLock", "data": {"thread": 0, "callType": "lock"}},
    {"action": "AcquireLock", "data": {"thread": 0, "callType": "try"}},
    {"action": "AcquireLock", "data": {"thread": 1, "callType": "lock"}},
    {"action": "AcquireLock", "data": {"thread": 1, "callType": "try"}},
    {"action": "ReleaseLock", "data": {"thread": 0}},
    {"action": "ReleaseLock", "data": {"thread": 1}},
]

# Spinlock safety invariants as predicates over the observable state.
INVARIANTS = [
    {"name": "LockStatusConsistency",
     "predicate": "(s) => s.lockHeld === (s.lockHolder !== null)"},
    {"name": "ValidHolder",
     "predicate": "(s) => s.lockHolder === null || s.lockHolder === 0 || s.lockHolder === 1"},
    {"name": "MutualExclusion",  # a single lockHolder can name at most one owner
     "predicate": "(s) => !s.lockHeld || (s.lockHolder === 0 || s.lockHolder === 1)"},
]


def main():
    spec = Path(sys.argv[1]) if len(sys.argv) > 1 else PROJECT_ROOT / "tools/plain-js/reference_spin.js"
    print(f"Lean spec: {spec}\n")

    # Phases 2 & 4 — bounded exploration + invariants (no SAM).
    rep = plain_js_explore(spec, ACTIONS, INVARIANTS, depth_max=6)
    if not rep.get("ok"):
        print(f"[Phase 2/4] FAILED to explore: {rep.get('error')}")
        return
    p2_ok = rep.get("classification") is None
    p4_viol = rep.get("invariantViolations") or {}
    print(f"[Phase 2 runtime]  {'PASS' if p2_ok else 'FAIL'} — "
          f"{rep['statesExplored']} steps, {rep['uniqueStates']} unique states, "
          f"classification={rep.get('classification')}")
    print(f"[Phase 4 invariants]  {'PASS' if not p4_viol else 'FAIL'} — "
          f"{len(INVARIANTS) - len(p4_viol)}/{len(INVARIANTS)} hold"
          + (f"; violations={p4_viol}" if p4_viol else ""))

    # Phase 3 — transition validation over the real 28-window corpus.
    windows = load_trace_windows("spin")
    statuses = plain_js_tv(spec, windows)
    passed = statuses.count("pass")
    print(f"[Phase 3 transitions]  {passed}/{len(windows)} = {100*passed/len(windows):.1f}%  "
          f"(fail={statuses.count('fail')} unscoreable={statuses.count('unscoreable')})")

    all_ok = p2_ok and not p4_viol and passed == len(windows)
    print(f"\nLean contract runs the full pipeline: {'ALL PHASES PASS' if all_ok else 'see above'}")


if __name__ == "__main__":
    main()
