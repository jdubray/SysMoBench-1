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
    # Bounded EF-progress properties (NOT liveness: no fairness, bounded horizon).
    # Safety invariants provably hold for a never-releasing or inert lock; these
    # catch exactly those classes.
    "progress": [
        {"name": "AcquireProgress",  # a free lock can be acquired
         "from": "(s) => !s.lockHeld", "goal": "(s) => s.lockHeld"},
        {"name": "ReleaseProgress",  # a held lock can be freed
         "from": "(s) => s.lockHeld", "goal": "(s) => !s.lockHeld"},
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
    # Bounded EF-progress (NOT liveness). Unlike spin, these properties are
    # state-changing, so they also give held-out replay real discriminating power.
    "progress": [
        {"name": "GrantProgress",   # a free lock with waiters can be granted
         "from": "(s) => s.holder === null && s.waiters.length > 0",
         "goal": "(s) => s.holder !== null"},
        {"name": "ReleaseProgress",  # a held lock can be freed
         "from": "(s) => s.holder !== null", "goal": "(s) => s.holder === null"},
    ],
    "reference": PROJECT_ROOT / "tools/plain-js/reference_locksvc.js",
    "source_file": "systems/locksvc/locksvc.go",
}

# ---- etcd: etcd-io/raft 3-node cluster, whole-cluster observable state ----
# {"nodes": {"1": {role, term, vote, commit, log}, "2": {...}, "3": {...}}}
# See scripts/harness/etcd/README.md for the projection and its approximations.
_ETCD_NODES = ("1", "2", "3")
_ETCD = {
    # A small representative input domain for bounded exploration (message
    # payloads carry unbounded integers in reality; these values cover the
    # first two terms / log positions the depth bound can reach).
    "actions": (
        [{"action": "ElectionTimeout", "data": {"node": n}} for n in _ETCD_NODES]
        + [{"action": "ClientProposal", "data": {"node": n}} for n in _ETCD_NODES]
        + [
            {"action": "HandleVoteRequest",
             "data": {"node": n, "from": f, "term": t, "logTerm": t - 1, "index": i}}
            for n in _ETCD_NODES for f in _ETCD_NODES if f != n
            for (t, i) in ((1, 0), (2, 1))
        ]
        + [
            {"action": "HandleAppendEntries",
             "data": {"node": n, "from": f, "term": 1, "logTerm": 0,
                      "index": i, "entries": 1, "commit": c}}
            for n in _ETCD_NODES for f in _ETCD_NODES if f != n
            for (i, c) in ((0, 0), (1, 1))
        ]
        + [
            {"action": "HandleHeartbeat",
             "data": {"node": n, "from": f, "term": 1, "commit": 1}}
            for n in _ETCD_NODES for f in _ETCD_NODES if f != n
        ]
    ),
    "invariants": [
        # Election safety: at most one leader per term.
        {"name": "OneLeaderPerTerm",
         "predicate": "(s) => { const t = {}; return Object.values(s.nodes)"
                      ".every((n) => n.role !== 'leader' || (t[n.term] = (t[n.term] || 0) + 1) <= 1); }"},
        # A node never commits past the end of its log.
        {"name": "CommitWithinLog",
         "predicate": "(s) => Object.values(s.nodes).every((n) => n.commit <= n.log)"},
        # votedFor is a known node id or none.
        {"name": "ValidVote",
         "predicate": "(s) => Object.values(s.nodes).every((n) => ['0','1','2','3'].includes(String(n.vote)))"},
    ],
    # Bounded EF-progress (NOT liveness). The explorer checks goal
    # reachability within the explored graph, so `from` must only hold at
    # shallow depth (raft's state space grows with every term/log bump and
    # always has a frontier): anchor both properties at the term-0 states.
    "progress": [
        {"name": "ElectionStart",  # from the initial quiet cluster, a campaign can start
         "from": "(s) => Object.values(s.nodes).every((n) => n.term === 0 && n.role === 'follower')",
         "goal": "(s) => Object.values(s.nodes).some((n) => n.role === 'candidate')"},
        {"name": "VoteGrant",  # ...and some node can grant a vote
         "from": "(s) => Object.values(s.nodes).every((n) => n.term === 0)",
         "goal": "(s) => Object.values(s.nodes).some((n) => n.role === 'follower' && n.vote !== '0')"},
    ],
    "reference": PROJECT_ROOT / "scripts/harness/etcd/reference_lean_spec.js",
    "source_file": "raft.go",
}

TASKS = {"spin": _SPIN, "locksvc": _LOCKSVC, "etcd": _ETCD}


def get(task: str) -> dict:
    if task not in TASKS:
        raise KeyError(f"no lean task config for '{task}'; known: {sorted(TASKS)}")
    return TASKS[task]
