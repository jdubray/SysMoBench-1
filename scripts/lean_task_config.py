#!/usr/bin/env python3
"""Per-task configuration for the lean-contract pipeline (Phases 2/3/4).

Each task supplies the explorer's action input-domain and the safety invariants
(as "(state) => boolean" predicate sources), plus the path to the reference lean
spec. Keeps lean_demo.py and lean_full_pipeline_study.py task-agnostic.
"""
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]

# ---- spin: Asterinas spinlock, observable state { lockHeld, lockHolder } ----
_SPIN = {
    "actions": [
        {"action": "AcquireLock", "data": {"thread": 0, "callType": "lock"}},
        {"action": "AcquireLock", "data": {"thread": 0, "callType": "try"}},
        {"action": "AcquireLock", "data": {"thread": 1, "callType": "lock"}},
        {"action": "AcquireLock", "data": {"thread": 1, "callType": "try"}},
        {"action": "ReleaseLock", "data": {"thread": 0}},
        {"action": "ReleaseLock", "data": {"thread": 1}},
    ],
    "invariants": [
        {"name": "LockStatusConsistency",
         "predicate": "(s) => s.lockHeld === (s.lockHolder !== null)"},
        {"name": "ValidHolder",
         "predicate": "(s) => s.lockHolder === null || s.lockHolder === 0 || s.lockHolder === 1"},
        {"name": "MutualExclusion",
         "predicate": "(s) => !s.lockHeld || (s.lockHolder === 0 || s.lockHolder === 1)"},
    ],
    "reference": PROJECT_ROOT / "tools/plain-js/reference_spin.js",
    "source_file": "ostd/src/sync/spin.rs",
}

# ---- locksvc: PGo lock service, observable state { holder, waiters } (3 clients) ----
_CLIENTS = (1, 2, 3)
_LOCKSVC = {
    "actions": [
        {"action": a, "data": {"client": c}}
        for a in ("ClientLockRequest", "ServerGrantLock",
                  "ClientCriticalSection", "ClientUnlockRequest")
        for c in _CLIENTS
    ],
    "invariants": [
        # At most one holder, and a valid client id (or free).
        {"name": "ValidHolder",
         "predicate": "(s) => s.holder === null || (Number.isInteger(s.holder) && s.holder >= 1 && s.holder <= 3)"},
        # The holder is not simultaneously waiting in the queue (mutual exclusion of role).
        {"name": "HolderNotWaiting",
         "predicate": "(s) => s.holder === null || !s.waiters.includes(s.holder)"},
        # FCFS integrity: no client appears twice in the wait queue.
        {"name": "NoDuplicateWaiters",
         "predicate": "(s) => new Set(s.waiters).size === s.waiters.length"},
    ],
    "reference": PROJECT_ROOT / "tools/plain-js/reference_locksvc.js",
    "source_file": "systems/locksvc/locksvc.go",
}

TASKS = {"spin": _SPIN, "locksvc": _LOCKSVC}


def get(task: str) -> dict:
    if task not in TASKS:
        raise KeyError(f"no lean task config for '{task}'; known: {sorted(TASKS)}")
    return TASKS[task]
