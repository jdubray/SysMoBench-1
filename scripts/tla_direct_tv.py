#!/usr/bin/env python3
"""Direct TLC transition validation for constrained TLA+ specs.

Mirrors the JS-SAM direct Phase-3 path (setState(pre) -> action -> diff(post))
using the standard TLC trace-validation trick, with no coding agent:

  For each trace window (pre, action, post), generate a tiny TV module that
  EXTENDS the generated `spin` spec, pins the pre-state in TVInit, takes exactly
  one step of the window's action, and asserts the post-state is unreachable
  (invariant NoPost). TLC reporting a NoPost violation => the action reproduces
  the transition => the window PASSES.

Requires the constrained state contract (VARIABLES lockHeld, lockHolder; actions
AcquireLock(thread, callType) / ReleaseLock(thread); NONE == "none"); see
tla_eval/tasks/spin/prompts/direct_call_constrained.txt.

Each window is classified: "pass" | "fail" | "unscoreable" (TLC/SANY could not
evaluate it — e.g. the spec broke the contract). This supports the pre-registered
conditional (over scoreable windows) and unconditional (unscoreable = fail) arms.

Usage:
    python scripts/tla_direct_tv.py <constrained_spin.tla> [--task spin]
"""
import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from tla_eval.utils.setup_utils import get_tla_tools_path, get_community_modules_path
from tla_eval.evaluation.semantics.trace_loader import load_trace_windows


def _classpath() -> str:
    import os
    jars = [str(get_tla_tools_path())]
    cm = get_community_modules_path()
    if cm.exists():
        jars.append(str(cm))
    return os.pathsep.join(jars)


def tla_value(v) -> str:
    """Render a trace JSON value as a TLA+ literal (null -> the NONE sentinel)."""
    if v is None:
        return "NONE"
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, str):
        return f'"{v}"'
    raise ValueError(f"unrenderable trace value: {v!r}")


def _action_call(name: str, data: dict) -> str:
    if name == "AcquireLock":
        return f'AcquireLock({tla_value(data.get("thread"))}, {tla_value(data.get("callType", "lock"))})'
    if name == "ReleaseLock":
        return f'ReleaseLock({tla_value(data.get("thread"))})'
    raise ValueError(f"unknown action {name!r}")


def _tv_module(action_call: str, pre: dict, post: dict) -> str:
    return f"""---- MODULE spin_TV ----
EXTENDS spin

VARIABLE tv_stepped

TVInit == tv_stepped = FALSE
          /\\ lockHeld = {tla_value(pre["lockHeld"])}
          /\\ lockHolder = {tla_value(pre["lockHolder"])}

TVStep == /\\ ~tv_stepped
          /\\ tv_stepped' = TRUE
          /\\ {action_call}

TVStutter == /\\ tv_stepped
             /\\ UNCHANGED <<lockHeld, lockHolder, tv_stepped>>

TVNext == TVStep \\/ TVStutter

PostReached == lockHeld = {tla_value(post["lockHeld"])}
               /\\ lockHolder = {tla_value(post["lockHolder"])}

NoPost == ~(tv_stepped /\\ PostReached)
====
"""


_CFG = """CONSTANTS Threads = {0, 1}
INIT TVInit
NEXT TVNext
INVARIANT NoPost
"""

# No invariant: TLC enumerates the full (tiny) one-step state space so we can read
# the distinct-state count and derive the branching factor.
_CFG_COUNT = """CONSTANTS Threads = {0, 1}
INIT TVInit
NEXT TVNext
"""

import re as _re

_DISTINCT_RE = _re.compile(r"([0-9]+) distinct states found")


def branching_factor(spec_text: str, action, pre, cp: str, timeout: int = 60):
    """Distinct observable post-states reachable from `pre` in ONE step of `action`.

    Returns an int (1 for a deterministic action) or None if TLC could not
    evaluate. Implemented by enumerating the pinned one-step state space: the
    reachable set is {pre} plus the action's image, and each post carries
    tv_stepped=TRUE (so a no-op post that equals pre observably is still a
    distinct state). Hence branching factor == (distinct states) - 1.
    """
    name = action["name"] if isinstance(action, dict) else action
    data = action.get("data", {}) if isinstance(action, dict) else {}
    with tempfile.TemporaryDirectory(prefix="tla_bf_") as d:
        dpath = Path(d)
        (dpath / "spin.tla").write_text(spec_text, encoding="utf-8")
        (dpath / "spin_TV.tla").write_text(
            _tv_module(_action_call(name, data), pre, post={"lockHeld": False, "lockHolder": None}),
            encoding="utf-8")
        (dpath / "spin_TV.cfg").write_text(_CFG_COUNT, encoding="utf-8")
        try:
            proc = subprocess.run(
                ["java", "-cp", cp, "tlc2.TLC", "-config", "spin_TV.cfg", "spin_TV.tla"],
                cwd=d, capture_output=True, text=True, timeout=timeout,
            )
        except subprocess.TimeoutExpired:
            return None
        out = (proc.stdout or "") + (proc.stderr or "")
        m = _DISTINCT_RE.search(out)
        if not m:
            return None
        return int(m.group(1)) - 1  # subtract the pinned pre-state


def functional_replay_window(spec_text, action, pre, post, cp, timeout=60):
    """Classify a window under a FUNCTIONAL check equivalent to JS next(pre)==post.

    Returns (status, branching_factor):
      'pass'           post reachable AND branching factor == 1 (image is exactly {post})
      'over_permissive' post reachable BUT branching factor > 1 (existential-only pass)
      'fail'           post NOT reachable (wrong single post, or post not in image)
      'unscoreable'    TLC could not evaluate
    """
    existential = replay_window(spec_text, action, pre, post, cp, timeout)
    if existential == "unscoreable":
        return "unscoreable", None
    bf = branching_factor(spec_text, action, pre, cp, timeout)
    if bf is None:
        return "unscoreable", None
    if existential == "pass":
        return ("pass", bf) if bf == 1 else ("over_permissive", bf)
    return "fail", bf  # post unreachable


def replay_window(spec_text: str, action, pre, post, cp: str, timeout: int = 60) -> str:
    """Return 'pass' | 'fail' | 'unscoreable' for one window."""
    name = action["name"] if isinstance(action, dict) else action
    data = action.get("data", {}) if isinstance(action, dict) else {}
    with tempfile.TemporaryDirectory(prefix="tla_tv_") as d:
        dpath = Path(d)
        (dpath / "spin.tla").write_text(spec_text, encoding="utf-8")
        (dpath / "spin_TV.tla").write_text(
            _tv_module(_action_call(name, data), pre, post), encoding="utf-8")
        (dpath / "spin_TV.cfg").write_text(_CFG, encoding="utf-8")
        try:
            proc = subprocess.run(
                ["java", "-cp", cp, "tlc2.TLC", "-config", "spin_TV.cfg", "spin_TV.tla"],
                cwd=d, capture_output=True, text=True, timeout=timeout,
            )
        except subprocess.TimeoutExpired:
            return "unscoreable"
        out = (proc.stdout or "") + (proc.stderr or "")
        if "Invariant NoPost is violated" in out:
            return "pass"
        # Clean completion with no violation => the action did not reproduce post.
        if ("No error has been found" in out) or ("Model checking completed" in out):
            return "fail"
        # SANY/TLC could not evaluate (contract broken, unknown op, eval error).
        return "unscoreable"


def direct_tv(spec_path: Path, windows, timeout: int = 60):
    spec_text = Path(spec_path).read_text(encoding="utf-8")
    cp = _classpath()
    results = []  # (action_name, status)
    for action, pre, post in windows:
        name = action["name"] if isinstance(action, dict) else action
        results.append((name, replay_window(spec_text, action, pre, post, cp, timeout)))
    return results


def functional_tv(spec_path: Path, windows, timeout: int = 60):
    """Per-window (action_name, status, branching_factor) under the functional check."""
    spec_text = Path(spec_path).read_text(encoding="utf-8")
    cp = _classpath()
    results = []
    for action, pre, post in windows:
        name = action["name"] if isinstance(action, dict) else action
        status, bf = functional_replay_window(spec_text, action, pre, post, cp, timeout)
        results.append((name, status, bf))
    return results


def summarize_functional(results):
    total = len(results)
    counts = {"pass": 0, "over_permissive": 0, "fail": 0, "unscoreable": 0}
    for _, status, _ in results:
        counts[status] += 1
    bfs = [bf for _, _, bf in results if bf is not None]
    scoreable = counts["pass"] + counts["over_permissive"] + counts["fail"]
    return {
        "total": total, **counts,
        "max_branching_factor": max(bfs) if bfs else None,
        "windows_branching_gt1": sum(1 for b in bfs if b > 1),
        # Functional pass rate: image is exactly {post}. Existential-only passes
        # (over_permissive) are NOT counted as passes here.
        "functional_conditional": counts["pass"] / scoreable if scoreable else 0.0,
        "functional_unconditional": counts["pass"] / total if total else 0.0,
    }


def summarize(results):
    total = len(results)
    passed = sum(1 for _, s in results if s == "pass")
    scoreable = sum(1 for _, s in results if s in ("pass", "fail"))
    unscoreable = total - scoreable
    per_action = {}
    for name, status in results:
        d = per_action.setdefault(name, {"pass": 0, "fail": 0, "unscoreable": 0})
        d[status] += 1
    return {
        "total": total, "passed": passed, "scoreable": scoreable,
        "unscoreable": unscoreable, "per_action": per_action,
        # Two pre-registered numbers:
        "conditional": passed / scoreable if scoreable else 0.0,  # over scoreable windows
        "unconditional": passed / total if total else 0.0,        # unscoreable counts as fail
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("spec")
    ap.add_argument("--task", default="spin")
    ap.add_argument("--timeout", type=int, default=60)
    ap.add_argument("--functional", action="store_true",
                    help="functional check (branching factor must be 1) instead of existential")
    args = ap.parse_args()
    windows = load_trace_windows(args.task)
    if args.functional:
        results = functional_tv(Path(args.spec), windows, args.timeout)
        s = summarize_functional(results)
        print(f"windows={s['total']} pass={s['pass']} over_permissive={s['over_permissive']} "
              f"fail={s['fail']} unscoreable={s['unscoreable']}")
        print(f"max_branching_factor={s['max_branching_factor']} "
              f"windows_with_bf>1={s['windows_branching_gt1']}")
        print(f"functional conditional={100*s['functional_conditional']:.1f}%  "
              f"unconditional={100*s['functional_unconditional']:.1f}%")
        return
    results = direct_tv(Path(args.spec), windows, args.timeout)
    s = summarize(results)
    print(f"windows={s['total']} passed={s['passed']} scoreable={s['scoreable']} unscoreable={s['unscoreable']}")
    print(f"conditional={100*s['conditional']:.1f}%  unconditional={100*s['unconditional']:.1f}%")
    for name, d in sorted(s["per_action"].items()):
        print(f"  {name}: pass={d['pass']} fail={d['fail']} unscoreable={d['unscoreable']}")


if __name__ == "__main__":
    main()
