#!/usr/bin/env python3
"""Prototype demo: the lean JS-SAM contract runs the full Phase pipeline (2/3/4)
without the SAM library.

Given a lean spec exporting { init, next } over the task's observable state, runs:
  - Phase 2 (bounded exploration): no crashes / determinism / serializable state,
  - Phase 4 (invariants): safety predicates over reachable states,
  - Phase 3 (transition validation): the task's real trace-window corpus,
all in the same locked-down sandbox used by JS-SAM. The action domain and
invariants come from scripts/lean_task_config.py. Defaults to the task's
reference lean spec; pass a path to score a model-generated one.

Usage:
    python scripts/lean_demo.py [--task spin|locksvc] [path/to/lean_spec.js]
Requires Docker + the node:20-slim image.
"""
import argparse
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))
sys.path.insert(0, str(PROJECT_ROOT / "scripts"))

from plain_js_tv import plain_js_tv, plain_js_explore
from lean_task_config import get as get_task_cfg
from tla_eval.evaluation.semantics.trace_loader import load_trace_windows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--task", default="spin")
    ap.add_argument("spec", nargs="?", help="lean spec to score (default: task reference spec)")
    args = ap.parse_args()

    cfg = get_task_cfg(args.task)
    spec = Path(args.spec) if args.spec else cfg["reference"]
    print(f"Task: {args.task}   Lean spec: {spec}\n")

    # Phases 2 & 4 — bounded exploration + safety invariants + bounded progress.
    rep = plain_js_explore(spec, cfg["actions"], cfg["invariants"], depth_max=8,
                           progress=cfg.get("progress"))
    if not rep.get("ok"):
        print(f"[Phase 2/4] FAILED to explore: {rep.get('error')}")
        return
    p2_ok = rep.get("classification") is None
    p4_viol = rep.get("invariantViolations") or {}
    prog_viol = rep.get("progressViolations") or {}
    ninv = len(cfg["invariants"])
    nprog = len(cfg.get("progress") or [])
    print(f"[Phase 2 runtime]  {'PASS' if p2_ok else 'FAIL'} — "
          f"{rep['statesExplored']} steps, {rep['uniqueStates']} unique states, "
          f"classification={rep.get('classification')}")
    print(f"[Phase 4 safety]  {'PASS' if not p4_viol else 'FAIL'} — "
          f"{ninv - len(p4_viol)}/{ninv} hold"
          + (f"; violations={p4_viol}" if p4_viol else ""))
    print(f"[Phase 4 progress (bounded EF, not liveness)]  "
          f"{'PASS' if not prog_viol else 'FAIL'} — "
          f"{nprog - len(prog_viol)}/{nprog} hold"
          + (f"; violations={prog_viol}" if prog_viol else ""))

    # Phase 3 — transition validation over the real trace corpus.
    windows = load_trace_windows(args.task)
    statuses = plain_js_tv(spec, windows)
    passed = statuses.count("pass")
    print(f"[Phase 3 transitions]  {passed}/{len(windows)} = {100*passed/len(windows):.1f}%  "
          f"(fail={statuses.count('fail')} unscoreable={statuses.count('unscoreable')})")

    all_ok = p2_ok and not p4_viol and not prog_viol and passed == len(windows)
    print(f"\nLean contract runs the full pipeline: {'ALL PHASES PASS' if all_ok else 'see above'}")


if __name__ == "__main__":
    main()
