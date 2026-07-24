#!/usr/bin/env python3
"""Positive control for the etcd trace corpus: replay every target-action
window against the hand-written reference lean spec through the exact same
path the benchmark uses (trace_loader windowing + sandboxed plain-JS replay).

A 100% pass rate is the acceptance bar for the corpus: if the reference
cannot replay a window, the fold (or the projection) is wrong.

Usage:
    python scripts/harness/etcd/replay_reference.py [TRACES_DIR]

TRACES_DIR defaults to data/sys_traces/etcd. Requires Docker (node:20-slim).
"""
import sys
from collections import Counter
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(PROJECT_ROOT))
sys.path.insert(0, str(PROJECT_ROOT / "scripts"))

from plain_js_tv import plain_js_tv  # noqa: E402
from tla_eval.evaluation.semantics.trace_loader import load_trace_windows  # noqa: E402

TARGET_ACTIONS = ["ElectionTimeout", "HandleVoteRequest", "ClientProposal",
                  "HandleAppendEntries", "HandleHeartbeat"]
REFERENCE = Path(__file__).resolve().parent / "reference_lean_spec.js"


def main():
    traces_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else (
        PROJECT_ROOT / "data" / "sys_traces" / "etcd")
    windows = load_trace_windows("etcd", traces_dir=traces_dir,
                                 target_actions=TARGET_ACTIONS)
    if not windows:
        print(f"no windows found under {traces_dir}", file=sys.stderr)
        sys.exit(1)

    statuses = plain_js_tv(REFERENCE, windows, timeout=300)
    per_action = Counter()
    fails = []
    for (action, pre, post), status in zip(windows, statuses):
        name = action["name"] if isinstance(action, dict) else action
        per_action[(name, status)] += 1
        if status != "pass":
            fails.append((name, action, pre, post, status))

    n_pass = sum(1 for s in statuses if s == "pass")
    print(f"reference replay: {n_pass}/{len(windows)} pass "
          f"({100.0 * n_pass / len(windows):.1f}%)")
    for (name, status), cnt in sorted(per_action.items()):
        print(f"  {name:22s} {status:12s} {cnt}")
    if fails:
        print("\nFAILING WINDOWS:")
        for name, action, pre, post, status in fails[:20]:
            data = action.get("data", {}) if isinstance(action, dict) else {}
            print(f"- {name} {status} data={data}\n  pre : {pre}\n  post: {post}")
        sys.exit(1)


if __name__ == "__main__":
    main()
