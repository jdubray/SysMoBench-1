#!/usr/bin/env python3
"""Fold raw etcd-raft TracingEvent streams into observable-state windows.

Input: the per-run raw NDJSON files written by artifacts/etcd tla_spec_trace.go
(NdjsonTraceLogger), one upstream TracingEvent per line. The test harness
(tla_trace_test.go) drives the cluster single-threadedly and drains each node's
Ready cycle after every Step/Tick/Propose/Campaign, so all events belonging to
one processing step of node n are CONTIGUOUS in the file. That property is what
makes the fold below exact.

Observable state — the whole-cluster projection:

    {"nodes": {"1": {"role": "follower|candidate|leader", "term": T,
                     "vote": "0"|nid, "commit": C, "log": L},
               "2": {...}, "3": {...}}}

where `log` is the node's last log index (upstream traces LogSize=lastIndex).
Every TracingEvent carries the emitting node's {term, vote, commit}, role and
log, so the cluster state is maintained by updating that node's slice.

Empirically calibrated payload semantics (verified against captured runs):
  * Receive* events fire at Step() entry — they carry the PRE-processing state.
  * Become{Candidate,Follower,Leader} fire after the role switch — POST state.
  * Replicate fires before the log append — PRE log size.
  * Send*/Ready/Commit carry the node's current (post-mutation) state.
The true post-state of a step is therefore read off the node's LAST event of
that step (the harness guarantees a Ready/Send closes every mutating step).

Action mapping (task.yaml tv.target_actions):
  ElectionTimeout     <- BecomeCandidate
  HandleVoteRequest   <- ReceiveRequestVoteRequest (msg MsgVote)
  ClientProposal      <- Replicate on the leader, EXCEPT the empty entry the
                         leader self-appends right after BecomeLeader (that
                         Replicate is part of the BecomeLeader segment)
  HandleAppendEntries <- ReceiveAppendEntriesRequest with msg.type == MsgApp
                         (any entry count: an empty MsgApp is a commit-index
                         update, still an append-protocol step)
  HandleHeartbeat     <- ReceiveAppendEntriesRequest with msg.type == MsgHeartbeat
                         (upstream maps MsgHeartbeat to the same event name;
                         the msg.type field disambiguates)

Fold: an action event E on node n opens a window whose pre-state is the
cluster before applying E's payload; subsequent events from n (its Step's
sends, role changes, Commit, Ready) update n's slice; the window closes —
emitting one stream-form line with the then-current cluster as post-state —
at the first event from a different node, the next action event, or EOF.

Cluster-state changes that occur OUTSIDE any window (leader election win on a
vote response, leader commit advance on an append response) are emitted as
non-target auxiliary lines (BecomeLeader, Commit, ...). The benchmark's
trace_loader skips windows whose action is not in tv.target_actions but still
advances the state stream through them, so every scored window has pre == the
state immediately before its action and post == the state immediately after
its own processing — nothing is smeared across unrelated events.

Output: stream-form NDJSON (data/sys_traces/etcd/etcd_runNN.ndjson):
    {"state": <initial cluster state>}
    {"action": <name>, "data": {...}, "state": <cluster state AFTER the action>}

The fold also runs self-consistency checks over every emitted line (terms,
commits and log sizes never decrease; commit <= log; only the acting node's
slice changes; per-action effect sanity) and exits non-zero on any violation.

Usage:
    python scripts/harness/etcd/build_windows.py OUT_DIR RAW1.events.ndjson [...]
"""
import json
import sys
from copy import deepcopy
from pathlib import Path

NODES = ("1", "2", "3")

TARGET_OF_EVENT = {
    "BecomeCandidate": "ElectionTimeout",
    "ReceiveRequestVoteRequest": "HandleVoteRequest",
    "Replicate": "ClientProposal",
    # ReceiveAppendEntriesRequest is split on msg.type below.
}

# Aux segment naming: most significant event wins.
AUX_PRIORITY = (
    "BecomeLeader",
    "BecomeFollower",
    "Commit",
    "Replicate",
    "Ready",
)

ROLE_OF = {"StateFollower": "follower", "StateCandidate": "candidate",
           "StateLeader": "leader", "StatePreCandidate": "precandidate"}


def node_slice(ev):
    return {
        "role": ROLE_OF.get(ev["role"], ev["role"]),
        "term": ev["state"]["term"],
        "vote": ev["state"]["vote"],
        "commit": ev["state"]["commit"],
        "log": ev["log"],
    }


def action_of(ev, prev_ev):
    """Map a raw event to (action_name, data) or None if not a target action."""
    name, nid, msg = ev["name"], ev["nid"], ev.get("msg")
    if name == "BecomeCandidate":
        return "ElectionTimeout", {"node": nid}
    if name == "ReceiveRequestVoteRequest":
        return "HandleVoteRequest", {
            "node": nid, "from": msg["from"], "term": msg["term"],
            "logTerm": msg["logTerm"], "index": msg["index"],
        }
    if name == "Replicate":
        # The leader's empty entry right after winning is part of the
        # BecomeLeader transition, not a client proposal.
        if prev_ev and prev_ev["nid"] == nid and prev_ev["name"] == "BecomeLeader":
            return None
        return "ClientProposal", {"node": nid}
    if name == "ReceiveAppendEntriesRequest":
        if msg["type"] == "MsgApp":
            return "HandleAppendEntries", {
                "node": nid, "from": msg["from"], "term": msg["term"],
                "logTerm": msg["logTerm"], "index": msg["index"],
                "entries": msg["entries"], "commit": msg["commit"],
            }
        if msg["type"] == "MsgHeartbeat":
            return "HandleHeartbeat", {
                "node": nid, "from": msg["from"], "term": msg["term"],
                "commit": msg["commit"],
            }
    return None


def fold(events):
    """Fold raw events into [(action, data, post_state), ...] plus init state."""
    cluster = {}
    lines = []

    # Seed each node's slice from its InitState/initial BecomeFollower events.
    i = 0
    while i < len(events) and events[i]["name"] in ("InitState", "ApplyConfChange",
                                                    "BecomeFollower"):
        cluster[events[i]["nid"]] = node_slice(events[i])
        i += 1
    if set(cluster) != set(NODES):
        raise ValueError(f"init events missing nodes: have {sorted(cluster)}")
    init_state = {"nodes": deepcopy(cluster)}

    window = None   # open target-action window: (action, data, node)
    segment = None  # open aux segment: (node, [event names], pre_cluster)
    prev_ev = None

    def close_window():
        nonlocal window
        if window:
            action, data, _node = window
            lines.append((action, data, {"nodes": deepcopy(cluster)}))
            window = None

    def close_segment():
        nonlocal segment
        if segment:
            node, names, pre = segment
            if cluster != pre:  # emit only if the segment changed the state
                name = next((p for p in AUX_PRIORITY if p in names), names[0])
                lines.append((name, {"node": node}, {"nodes": deepcopy(cluster)}))
            segment = None

    for ev in events[i:]:
        nid = ev["nid"]
        act = action_of(ev, prev_ev)
        prev_ev = ev

        if act is not None:
            close_window()
            close_segment()
            window = (act[0], act[1], nid)
            cluster[nid] = node_slice(ev)  # pre for receives, post for becomes
        elif window is not None:
            if nid == window[2]:
                cluster[nid] = node_slice(ev)  # same step: absorb into window
            else:
                close_window()
                segment = (nid, [ev["name"]], deepcopy(cluster))
                cluster[nid] = node_slice(ev)
        else:
            if segment is not None and segment[0] == nid:
                segment[1].append(ev["name"])
            else:
                close_segment()
                segment = (nid, [ev["name"]], deepcopy(cluster))
            cluster[nid] = node_slice(ev)

    close_window()
    close_segment()
    return init_state, lines


# ---------------------------------------------------------------- consistency

TARGET_ACTIONS = {"ElectionTimeout", "HandleVoteRequest", "ClientProposal",
                  "HandleAppendEntries", "HandleHeartbeat"}


def check(run_name, init_state, lines):
    """Self-consistency of the folded stream; returns a list of violations."""
    bad = []
    prev = init_state
    for k, (action, data, state) in enumerate(lines, start=1):
        where = f"{run_name}:{k} {action}"
        actor = data["node"]
        for n in NODES:
            p, q = prev["nodes"][n], state["nodes"][n]
            if q["term"] < p["term"]:
                bad.append(f"{where}: node {n} term decreased {p['term']}->{q['term']}")
            if q["commit"] < p["commit"]:
                bad.append(f"{where}: node {n} commit decreased {p['commit']}->{q['commit']}")
            if q["log"] < p["log"]:
                bad.append(f"{where}: node {n} log shrank {p['log']}->{q['log']}")
            if q["commit"] > q["log"]:
                bad.append(f"{where}: node {n} commit {q['commit']} > log {q['log']}")
            if n != actor and p != q:
                bad.append(f"{where}: non-acting node {n} changed {p} -> {q}")
        p, q = prev["nodes"][actor], state["nodes"][actor]
        if action == "ElectionTimeout":
            ok = (q["term"] == p["term"] + 1 and q["role"] == "candidate"
                  and q["vote"] == actor)
            if not ok:
                bad.append(f"{where}: unexpected effect {p} -> {q}")
        elif action == "ClientProposal":
            if not (q["log"] == p["log"] + 1 and p["role"] == "leader"):
                bad.append(f"{where}: unexpected effect {p} -> {q}")
        elif action == "HandleVoteRequest":
            if q["role"] == "leader":
                bad.append(f"{where}: vote request produced a leader: {q}")
        # Leaders never appear in more than one node per term.
        leaders = {n: s for n, s in state["nodes"].items() if s["role"] == "leader"}
        by_term = {}
        for n, s in leaders.items():
            by_term.setdefault(s["term"], []).append(n)
        for term, ns in by_term.items():
            if len(ns) > 1:
                bad.append(f"{where}: two leaders at term {term}: {ns}")
        prev = state
    return bad


def main():
    if len(sys.argv) < 3:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    out_dir = Path(sys.argv[1])
    out_dir.mkdir(parents=True, exist_ok=True)

    total, violations = 0, []
    counts = {}
    for raw in sys.argv[2:]:
        raw = Path(raw)
        events = [json.loads(line) for line in raw.read_text(encoding="utf-8").splitlines()
                  if line.strip()]
        init_state, lines = fold(events)
        run_name = raw.name.replace(".events.ndjson", "").replace(".ndjson", "")
        violations += check(run_name, init_state, lines)

        out_path = out_dir / f"{run_name}.ndjson"
        with out_path.open("w", encoding="utf-8") as f:
            f.write(json.dumps({"state": init_state}) + "\n")
            for action, data, state in lines:
                f.write(json.dumps({"action": action, "data": data, "state": state}) + "\n")

        per = {}
        for action, _d, _s in lines:
            per[action] = per.get(action, 0) + 1
        counts[run_name] = per
        n_target = sum(v for a, v in per.items() if a in TARGET_ACTIONS)
        total += n_target
        print(f"{out_path.name}: {len(lines)} lines, {n_target} target windows  {per}")

    agg = {}
    for per in counts.values():
        for a, v in per.items():
            if a in TARGET_ACTIONS:
                agg[a] = agg.get(a, 0) + v
    print(f"target windows per action: {agg}")
    print(f"total target windows: {total}")

    if violations:
        print(f"\nSELF-CONSISTENCY VIOLATIONS ({len(violations)}):", file=sys.stderr)
        for v in violations:
            print("  " + v, file=sys.stderr)
        sys.exit(1)
    missing = TARGET_ACTIONS - set(agg)
    if missing:
        print(f"\nERROR: no windows for target action(s): {sorted(missing)}", file=sys.stderr)
        sys.exit(1)
    print("self-consistency: OK")


if __name__ == "__main__":
    main()
