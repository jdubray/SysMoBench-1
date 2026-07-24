# etcd (Raft) trace-capture harness

Produces the deterministic `(pre, action, post)` window corpora in
`data/sys_traces/etcd/` that ground Phase 3 (transition validation) for the
`etcd` task. Mirrors the locksvc harness pattern: a Go test drives the real
system, a Python fold projects the raw events into the window NDJSON schema.

**Upstream:** `github.com/etcd-io/raft` @ `26647d57a34382bc60457ad508cea835ed9b52da`
(fresh clone at `artifacts/etcd`; also pinned per-run in
`data/sys_traces/etcd/PROVENANCE.txt`).

## Pieces

| File | Role |
|---|---|
| `artifacts/etcd/tla_spec_trace.go` | `NdjsonTraceLogger` — implements upstream's `TraceLogger` interface (behind `//go:build with_tla`), appending each `TracingEvent` as one JSON line to `$TRACES_DIR/etcd_runNN.events.ndjson`. Upstream already instruments every interesting transition (`state_trace.go`); this is only the sink. |
| `artifacts/etcd/tla_trace_test.go` | Five `TestTLATrace_*` scenarios driving a deterministic 3-node cluster via `RawNode` — no goroutines, no randomness (elections via `Campaign()`, heartbeats via a single `Tick()` at `HeartbeatTick=1`), messages hand-delivered one at a time in a fixed per-scenario order. |
| `build_windows.py` | Folds raw events into window NDJSON + self-consistency checks (exits non-zero on any violation or on a target action with zero windows). |
| `run.sh` | test → fold → provenance pin, honoring the `task.yaml > tv.harness` contract (`TRACES_DIR`, `go test -tags with_tla -run 'TestTLATrace_' ...`). |
| `reference_lean_spec.js` | Hand-authored reference lean spec (positive control). |
| `replay_reference.py` | Replays the corpus against the reference via the benchmark's own path (`trace_loader` + sandboxed `tools/plain-js/tv.mjs`; needs Docker). |

## Scenarios (schedule diversity = varied delivery orders)

1. `etcd_run01` **Election** — node 1 campaigns, votes delivered 2→3, wins, noop replicated/committed.
2. `etcd_run02` **Proposal** — election (votes 3→2), then 3 proposals; round 1 delivered 2→3, round 2 (two entries in flight) delivered 3→2.
3. `etcd_run03` **Heartbeat** — election, 2 proposals, two heartbeat rounds in opposite delivery orders.
4. `etcd_run04` **VoteRejection** — node 2 partitioned during replication; its stale-log campaign bumps peers' terms but is rejected by quorum (it steps down); node 1 re-elects at a higher term and catches node 2 up through the append reject/retry protocol.
5. `etcd_run05` **SecondElection** — node 2 (up-to-date log) wins a higher-term election over sitting leader 1; the term change propagates to all nodes; two heartbeat rounds from the new leader.

## Projection (whole-cluster; the choice and its evidence)

```json
{"nodes": {"1": {"role": "follower|candidate|leader", "term": T,
                 "vote": "0"|nid, "commit": C, "log": L}, "2": {...}, "3": {...}}}
```

`log` is the node's last log index (upstream traces `LogSize = lastIndex`).

**Whole-cluster vs per-node:** per-node windows are incompatible with the
loader's stream form (consecutive lines would carry *different* nodes'
states, so `pre` would be meaningless), while whole-cluster windows proved
fully self-consistent — zero violations and a 100% reference replay — so the
whole-cluster projection was chosen without needing the fallback.

**Empirically calibrated payload semantics** (verified in the captured
streams): `Receive*` events fire at `Step()` entry and carry the **pre**
state; `Become*` fire after the role switch (**post**); `Replicate` fires
before the log append (pre log size); `Send*`/`Ready`/`Commit` carry the
current post-mutation state. The harness drains each node's Ready cycle after
every step, so a step's events are contiguous — a window for action `E` on
node `n` closes at the first event from a different node (or the next action
event), by which point `n`'s last event has delivered its exact post state.
Vote-granting illustrates why the last event matters: the grant is recorded
*after* the response send, so only the trailing `Ready` shows the new `vote`.

**Off-action state changes** (leader win on a vote response, leader commit
advance on an append response) are emitted as auxiliary non-target lines
(`BecomeLeader`, `Commit`, `BecomeFollower`). `trace_loader` skips them for
scoring but advances the state stream through them, so every scored window's
pre/post is exact — nothing is smeared across unrelated events.

## Action mapping

| Canonical action | Raw event | data |
|---|---|---|
| `ElectionTimeout` | `BecomeCandidate` | `{node}` |
| `HandleVoteRequest` | `ReceiveRequestVoteRequest` (`MsgVote`) | `{node, from, term, logTerm, index}` |
| `ClientProposal` | `Replicate` on the leader, excluding the noop entry immediately after `BecomeLeader` | `{node}` |
| `HandleAppendEntries` | `ReceiveAppendEntriesRequest` with `msg.type == MsgApp` (incl. `entries == 0` commit-index updates) | `{node, from, term, logTerm, index, entries, commit}` |
| `HandleHeartbeat` | `ReceiveAppendEntriesRequest` with `msg.type == MsgHeartbeat` (upstream maps `MsgHeartbeat` to the same event name; `msg.type` disambiguates) | `{node, from, term, commit}` |

## Documented projection approximations

The projection carries log *size* but not per-entry terms, so two raft checks
are index-approximated (both exact on these corpora by construction):

1. **Vote up-to-dateness** — `m.index >= voter.log` instead of the
   `(lastTerm, lastIndex)` lexicographic compare. The scenarios keep last-log
   terms equal at every vote decision, so the index compare decides.
2. **Append log-match** — `m.index <= follower.log` instead of
   `term(m.index) == m.logTerm`. All logs in these schedules are prefixes of
   the leader's log, so index containment implies the term match.

Also: raft's same-term `lead == None` vote condition is unobservable; every
campaign in the corpus is at a strictly higher term than its receivers, so
the condition never binds.

## Validation results (acceptance bar)

- All five `TestTLATrace_*` scenarios pass; fold self-consistency: **0 violations**
  (monotone terms/commits/log sizes, `commit <= log`, only the acting node's
  slice changes per line, per-action effect sanity, one leader per term).
- Regenerating the corpus is byte-identical (determinism check).
- Per-action target windows (97 total): ElectionTimeout 8, HandleVoteRequest 16,
  ClientProposal 8, HandleAppendEntries 57, HandleHeartbeat 8.
- **Positive control:** `replay_reference.py` → **97/97 pass (100%)** through
  the benchmark's own trace_loader + sandboxed plain-JS replay path.

## Regenerate

```bash
bash scripts/harness/etcd/run.sh                    # capture + fold -> data/sys_traces/etcd
python scripts/harness/etcd/replay_reference.py     # positive control (Docker)
```
