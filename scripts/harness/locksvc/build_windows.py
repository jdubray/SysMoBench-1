#!/usr/bin/env python3
"""Fold PGo-native locksvc traces into observable-state (pre, action, post) windows.

The lock service's observable state is projected to the logical lock abstraction —
the same shape all study arms model, analogous to spin's {lockHeld, lockHolder}:

    { "holder":  <client id currently holding the lock, or null>,
      "waiters": [<client ids that have requested and are waiting — a SET,
                  canonically sorted ascending>] }

`waiters` is a set, NOT a FIFO. The server serves requests in ARRIVAL order,
and arrival order at the server is not a function of the client-side events the
trace exposes (clients logged sending 1,3,2 in one capture while the server's
queue built as <<3,2,1>> — TCP/goroutine reordering, exactly the property the
upstream locksvc.tla NoPriorityInversion comment warns about). An earlier
version of this fold ordered `waiters` by client-send order and required grants
to go to the head; on reordered runs that silently turned real grants into
no-op windows — wrong ground truth. At this projection FCFS is unobservable;
the observable transitions are:

    ClientLockRequest(c)     waiters := waiters ∪ {c}   (if c isn't holder/waiting)
    ServerGrantLock(c)       if holder==null and c ∈ waiters:
                                 holder := c; waiters := waiters \\ {c}
    ClientCriticalSection(c) no state change (asserts holder==c)
    ClientUnlockRequest(c)   if holder==c: holder := null

Emitted in the loader's *stream form* (one seed `{"state":...}` line then one
`{"action","data","state":<post>}` line per action; consecutive states form
windows).

Empty vclocks in the PGo trace mean a client's CriticalSection can be *logged*
just before its own Grant, even though causally the grant must come first (a
client can't enter the CS without receiving GrantMsg). We repair this by moving
each ServerGrantLock(c) to immediately before that client's CriticalSection when
the log has them inverted — a causally sound reordering — then fold with the
clean transitions above, so every window matches the model semantics exactly.

Usage:
    python scripts/harness/locksvc/build_windows.py OUT_DIR RAW1.ndjson [RAW2.ndjson ...]
"""
import json
import re
import sys
from pathlib import Path

GRANT_MSG = 3
LOCK_MSG = 1
ACTION_OF_LABEL = {
    "AClient.acquireLock": "ClientLockRequest",
    "AClient.criticalSection": "ClientCriticalSection",
    "AClient.unlock": "ClientUnlockRequest",
}


def _var_key(el):
    n = el["name"]
    full = f"{n['prefix']}.{n['name']}" if n.get("prefix") else n["name"]
    if el.get("indices"):
        full += "[" + ",".join(el["indices"]) + "]"
    return full


def target_actions(raw_path: Path):
    """Yield (action_name, client_id) for each target-action event, in recorded order."""
    for line in raw_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        raw = json.loads(line)
        if raw.get("isAbort"):
            continue
        cs = raw.get("csElements", [])
        pc = next((e for e in cs if e.get("tag") == "write"
                   and e.get("name", {}).get("name") == ".pc"), None)
        if pc is None:
            continue
        label = pc["oldValue"].strip('"')
        writes = {_var_key(e): e.get("value") for e in cs
                  if e.get("tag") == "write" and e.get("name", {}).get("name") != ".pc"}
        if label in ACTION_OF_LABEL:
            yield ACTION_OF_LABEL[label], int(raw["self"])
        elif label == "AServer.serverRespond":
            # A grant writes GrantMsg (=3) to network[<client>]; recover the client index.
            for key, val in writes.items():
                if "network[" in key and (val == GRANT_MSG or str(val).strip() == str(GRANT_MSG)):
                    yield "ServerGrantLock", int(re.search(r"network\[(\d+)\]", key).group(1))
                    break


def _repair_grant_before_cs(events):
    """Move each ServerGrantLock(c) to just before that client's CriticalSection when
    the log records them inverted (empty-vclock artifact). Causally sound: a client
    cannot enter its critical section without first receiving the grant."""
    events = list(events)
    for c in {cid for a, cid in events if a == "ClientCriticalSection"}:
        gl = next((i for i, (a, cid) in enumerate(events)
                   if a == "ServerGrantLock" and cid == c), None)
        cs = next((i for i, (a, cid) in enumerate(events)
                   if a == "ClientCriticalSection" and cid == c), None)
        if gl is not None and cs is not None and gl > cs:
            events.insert(cs, events.pop(gl))  # gl > cs, so pop then insert at cs
    return events


def fold(events):
    """Fold an action stream into [(action, client, post_state), ...] over
    {holder, waiters} with waiters as a canonically sorted set."""
    holder = None
    waiters = set()
    out = []
    for action, c in _repair_grant_before_cs(events):
        if action == "ClientLockRequest":
            if c != holder:
                waiters.add(c)
        elif action == "ServerGrantLock":
            if holder is None and c in waiters:
                holder = c
                waiters.discard(c)
        elif action == "ClientCriticalSection":
            pass  # c is using the lock; observable state unchanged (holder==c)
        elif action == "ClientUnlockRequest":
            if holder == c:
                holder = None
        out.append((action, c, {"holder": holder, "waiters": sorted(waiters)}))
    return out


def main():
    if len(sys.argv) < 3:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    out_dir = Path(sys.argv[1])
    out_dir.mkdir(parents=True, exist_ok=True)
    total = 0
    for i, raw in enumerate(sys.argv[2:], start=1):
        windows = fold(list(target_actions(Path(raw))))
        out_path = out_dir / f"locksvc_run{i:02d}.ndjson"
        with out_path.open("w", encoding="utf-8") as f:
            # Pure NDJSON (no comment lines — the trace loader warns on non-JSON).
            f.write('{"state": {"holder": null, "waiters": []}}\n')  # seed / Init
            for action, c, state in windows:
                f.write(json.dumps({"action": action, "data": {"client": c}, "state": state}) + "\n")
        total += len(windows)
        print(f"{out_path.name}: {len(windows)} windows")
    print(f"total: {total} windows across {len(sys.argv) - 2} runs -> {out_dir}")


if __name__ == "__main__":
    main()
