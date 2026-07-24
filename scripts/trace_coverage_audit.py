#!/usr/bin/env python3
"""Trace-coverage audit (review point 8): what the conformance numbers rest on.

Quantifies the quiet weaknesses of the trace corpora so every conformance claim
can carry its qualifier:

  spin:    combo coverage of the observable domain, which contention shapes are
           present (try-only vs blocking), and what the projection makes
           invisible by construction.
  locksvc: schedule diversity across runs (distinct action sequences / grant
           orders), workload shape (single acquire-release cycle per client),
           and the verified (not assumed) premise of the grant-before-CS reorder.

Usage:
    python scripts/trace_coverage_audit.py
"""
import sys
from collections import Counter
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from tla_eval.evaluation.semantics.trace_loader import load_trace_windows


def spin_audit():
    w = load_trace_windows("spin")
    combos = Counter()
    for a, pre, post in w:
        d = a["data"]
        combos[(pre["lockHeld"], pre["lockHolder"], a["name"],
                d.get("thread"), d.get("callType"))] += 1

    # Full observable domain: 3 reachable pre-states x 6 actions.
    pres = [(False, None), (True, 0), (True, 1)]
    domain = []
    for p in pres:
        for t in (0, 1):
            for ct in ("lock", "try"):
                domain.append((p[0], p[1], "AcquireLock", t, ct))
            domain.append((p[0], p[1], "ReleaseLock", t, None))

    covered = set(combos)
    print("===== spin =====")
    print("Provenance: TWO hand-authored deterministic ktest scenarios")
    print("(test_spin_2thread, test_spin_seq); no randomized or adversarial schedule.")
    print(f"Combo coverage: {len(covered)}/{len(domain)} observable (pre, action, data) combos.")
    missing = [c for c in domain if c not in covered]
    print("Uncovered combos:")
    for c in missing:
        print(f"  pre=({c[0]},{c[1]}) {c[2]}(thread={c[3]}, ct={c[4]})")
    lock_on_held = [c for c in covered if c[2] == "AcquireLock" and c[0] and c[4] == "lock"]
    try_on_held = [c for c in covered if c[2] == "AcquireLock" and c[0] and c[4] == "try"]
    print(f"Contention windows: try-on-held combos covered={len(try_on_held)}, "
          f"BLOCKING lock-on-held combos covered={len(lock_on_held)}.")
    print("=> The corpus contains ZERO windows of a blocking lock() observed while")
    print("   the lock is held. The instrumentation emits the acquire event at")
    print("   acquisition SUCCESS (where pre is free), so the spin phase — the")
    print("   behavior the primitive is named for — produces no observable window")
    print("   in this 2-variable projection: a woken blocking waiter is")
    print("   indistinguishable from an uncontended acquire.")


def locksvc_audit():
    print("\n===== locksvc =====")
    files = sorted((PROJECT_ROOT / "data/sys_traces/locksvc").glob("*.ndjson"))
    sequences = []
    import json
    for f in files:
        seq = []
        for line in f.read_text(encoding="utf-8").splitlines():
            rec = json.loads(line)
            if "action" in rec:
                seq.append((rec["action"], rec["data"]["client"]))
        sequences.append(tuple(seq))
    per_run = Counter(a for s in sequences for a, _ in s)
    grant_orders = [tuple(c for a, c in s if a == "ServerGrantLock") for s in sequences]
    print(f"Runs: {len(sequences)}; windows/action: {dict(per_run)} — every run is the")
    print("SAME terminating workload (each of 3 clients acquires exactly once and")
    print("releases: 12 windows/run by protocol completion, hence exactly 15/action).")
    print(f"Schedule diversity: {len(set(sequences))}/{len(sequences)} distinct action "
          f"sequences; grant orders: {grant_orders}")
    print("=> Concurrency sampling is schedule-order variation over one fixed")
    print("   workload — no re-requests, no contention beyond 3 one-shot clients,")
    print("   no failure/timeout paths.")
    print("Reorder premise: verified per-event at corpus build (every CriticalSection")
    print("step READS GrantMsg=3 from the network — message-passing happens-before;")
    print("see validate_cs_consumed_grant in scripts/harness/locksvc/build_windows.py).")


def main():
    spin_audit()
    locksvc_audit()
    print("\n===== The qualifier every 100% carries =====")
    print("Conformance here means: conformance to a two-variable observable")
    print("projection of deterministic, hand-authored (spin) or fixed-workload")
    print("(locksvc) schedules, on the combos those schedules reach. It is not")
    print("evidence about uncovered combos, invisible-in-projection behavior")
    print("(the blocking spin), richer workloads, or adversarial interleavings.")


if __name__ == "__main__":
    main()
