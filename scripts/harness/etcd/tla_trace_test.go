// SysMoBench etcd task — deterministic trace-capture scenarios.
//
// Each TestTLATrace_* test drives a 3-node raft cluster by hand through
// RawNode (no goroutines, no randomized timeouts: elections are triggered
// with Campaign(), heartbeats with a single Tick() at HeartbeatTick=1), and
// records every upstream TracingEvent (state_trace.go) into
// $TRACES_DIR/etcd_runNN.events.ndjson via NdjsonTraceLogger.
//
// Messages are delivered one at a time in a fixed, per-scenario order (the
// order varies across scenarios — that is the schedule diversity). After
// every Step/Tick/Propose/Campaign the node's Ready cycle is fully drained,
// so all trace events belonging to one processing step are contiguous in the
// raw file — the property scripts/harness/etcd/build_windows.py relies on.

//go:build with_tla

package raft

import (
	"os"
	"path/filepath"
	"testing"

	pb "go.etcd.io/raft/v3/raftpb"
)

type tlaNode struct {
	rn      *RawNode
	storage *MemoryStorage
}

type tlaCluster struct {
	t     *testing.T
	nodes map[uint64]*tlaNode
	inbox map[uint64][]*pb.Message
}

// newTLACluster builds three identically configured nodes (peers 1,2,3,
// ElectionTick=10, HeartbeatTick=1) sharing one NdjsonTraceLogger writing to
// $TRACES_DIR/<run>.events.ndjson (or a test temp dir if TRACES_DIR is unset).
func newTLACluster(t *testing.T, run string) *tlaCluster {
	t.Helper()
	dir := os.Getenv("TRACES_DIR")
	if dir == "" {
		dir = t.TempDir()
	}
	logger, err := NewNdjsonTraceLogger(filepath.Join(dir, run+".events.ndjson"))
	if err != nil {
		t.Fatalf("trace logger: %v", err)
	}
	t.Cleanup(func() { _ = logger.Close() })

	c := &tlaCluster{
		t:     t,
		nodes: map[uint64]*tlaNode{},
		inbox: map[uint64][]*pb.Message{},
	}
	for id := uint64(1); id <= 3; id++ {
		storage := newTestMemoryStorage(withPeers(1, 2, 3))
		cfg := newTestConfig(id, 10, 1, storage)
		cfg.TraceLogger = logger
		rn, err := NewRawNode(cfg)
		if err != nil {
			t.Fatalf("node %d: %v", id, err)
		}
		c.nodes[id] = &tlaNode{rn: rn, storage: storage}
	}
	return c
}

// drain runs node id's Ready cycles to quiescence: persists entries and hard
// state to its MemoryStorage and queues outbound messages per recipient.
func (c *tlaCluster) drain(id uint64) {
	c.t.Helper()
	n := c.nodes[id]
	for n.rn.HasReady() {
		rd := n.rn.Ready()
		if len(rd.Entries) > 0 {
			if err := n.storage.Append(rd.Entries); err != nil {
				c.t.Fatalf("node %d append: %v", id, err)
			}
		}
		if !IsEmptyHardState(rd.HardState) {
			if err := n.storage.SetHardState(rd.HardState); err != nil {
				c.t.Fatalf("node %d hardstate: %v", id, err)
			}
		}
		for _, m := range rd.Messages {
			c.inbox[m.GetTo()] = append(c.inbox[m.GetTo()], m)
		}
		n.rn.Advance(rd)
	}
}

// deliver steps every message queued for `to` that was sent by `from`, one at
// a time (draining `to` after each), preserving queue order. Messages from
// other senders stay queued.
func (c *tlaCluster) deliver(to, from uint64) {
	c.t.Helper()
	queue := c.inbox[to]
	c.inbox[to] = nil
	var rest []*pb.Message
	for _, m := range queue {
		if m.GetFrom() != from {
			rest = append(rest, m)
			continue
		}
		if err := c.nodes[to].rn.Step(m); err != nil {
			c.t.Fatalf("node %d step %s from %d: %v", to, m.GetType(), from, err)
		}
		c.drain(to)
	}
	c.inbox[to] = append(rest, c.inbox[to]...)
}

// pump delivers all queued messages in a fixed (to, from) sweep order until
// the cluster is quiescent.
func (c *tlaCluster) pump() {
	for {
		total := 0
		for to := uint64(1); to <= 3; to++ {
			total += len(c.inbox[to])
		}
		if total == 0 {
			return
		}
		for to := uint64(1); to <= 3; to++ {
			for from := uint64(1); from <= 3; from++ {
				c.deliver(to, from)
			}
		}
	}
}

// discard drops every message queued for `to` (simulates a lossy link).
func (c *tlaCluster) discard(to uint64) {
	c.inbox[to] = nil
}

func (c *tlaCluster) campaign(id uint64) {
	c.t.Helper()
	if err := c.nodes[id].rn.Campaign(); err != nil {
		c.t.Fatalf("node %d campaign: %v", id, err)
	}
	c.drain(id)
}

func (c *tlaCluster) propose(id uint64, data string) {
	c.t.Helper()
	if err := c.nodes[id].rn.Propose([]byte(data)); err != nil {
		c.t.Fatalf("node %d propose: %v", id, err)
	}
	c.drain(id)
}

func (c *tlaCluster) tick(id uint64) {
	c.nodes[id].rn.Tick()
	c.drain(id)
}

func (c *tlaCluster) requireState(id uint64, st StateType) {
	c.t.Helper()
	if got := c.nodes[id].rn.Status().RaftState; got != st {
		c.t.Fatalf("node %d state = %s, want %s", id, got, st)
	}
}

// elect makes `id` campaign and win with votes delivered in the given order,
// then pumps until quiescent (noop entry replicated and committed everywhere).
func (c *tlaCluster) elect(id uint64, voteOrder ...uint64) {
	c.t.Helper()
	c.campaign(id)
	for _, v := range voteOrder {
		c.deliver(v, id) // vote request reaches v
	}
	for _, v := range voteOrder {
		c.deliver(id, v) // v's vote response reaches the candidate
	}
	c.requireState(id, StateLeader)
	c.pump() // replicate + commit the leader's noop entry everywhere
}

// TestTLATrace_Election: node 1 times out, campaigns, wins votes from 2 and 3
// (delivered 2 first), becomes leader; noop entry replicated and committed.
func TestTLATrace_Election(t *testing.T) {
	c := newTLACluster(t, "etcd_run01")
	c.campaign(1)
	c.deliver(2, 1)
	c.deliver(3, 1)
	c.deliver(1, 2) // quorum: 1 becomes leader here
	c.deliver(1, 3)
	c.requireState(1, StateLeader)
	// Replicate the noop: node 2 first, then 3; responses in the same order.
	c.deliver(2, 1)
	c.deliver(3, 1)
	c.deliver(1, 2)
	c.deliver(1, 3)
	c.pump() // commit-index updates reach the followers
	c.requireState(2, StateFollower)
	c.requireState(3, StateFollower)
}

// TestTLATrace_Proposal: election (votes 3 then 2), then three client
// proposals replicated and committed with per-round varied delivery order.
func TestTLATrace_Proposal(t *testing.T) {
	c := newTLACluster(t, "etcd_run02")
	c.elect(1, 3, 2)

	c.propose(1, "x1")
	c.deliver(2, 1)
	c.deliver(3, 1)
	c.deliver(1, 2)
	c.deliver(1, 3)
	c.pump()

	c.propose(1, "x2")
	c.propose(1, "x3") // two entries in flight in one round
	c.deliver(3, 1)    // node 3 first this round
	c.deliver(2, 1)
	c.deliver(1, 3)
	c.deliver(1, 2)
	c.pump()

	if commit := c.nodes[1].rn.Status().HardState.GetCommit(); commit < 4 {
		t.Fatalf("leader commit = %d, want >= 4 (noop + 3 proposals)", commit)
	}
}

// TestTLATrace_Heartbeat: election, two proposals, then two heartbeat rounds
// with opposite delivery orders.
func TestTLATrace_Heartbeat(t *testing.T) {
	c := newTLACluster(t, "etcd_run03")
	c.elect(1, 2, 3)

	c.propose(1, "h1")
	c.propose(1, "h2")
	c.pump()

	c.tick(1) // HeartbeatTick=1: one tick broadcasts heartbeats
	c.deliver(3, 1)
	c.deliver(2, 1)
	c.deliver(1, 3)
	c.deliver(1, 2)

	c.tick(1)
	c.deliver(2, 1)
	c.deliver(3, 1)
	c.deliver(1, 2)
	c.deliver(1, 3)
	c.pump()
}

// TestTLATrace_VoteRejection: node 2 is cut off while 1 replicates two entries
// to 3 only; 2 then campaigns with a stale log and is rejected by both peers
// (which still bump their term); node 1 re-campaigns at a higher term, wins,
// and catches node 2 up.
func TestTLATrace_VoteRejection(t *testing.T) {
	c := newTLACluster(t, "etcd_run04")
	c.elect(1, 2, 3)

	c.propose(1, "v1")
	c.propose(1, "v2")
	c.discard(2)    // node 2 never sees these appends
	c.deliver(3, 1) // node 3 stays current
	c.deliver(1, 3) // leader commits on quorum {1,3}
	c.discard(2)    // drop the commit-index update to 2 as well
	c.deliver(3, 1)
	c.discard(2)

	// Stale node 2 campaigns: peers bump to its term but reject the vote.
	c.campaign(2)
	c.deliver(1, 2)
	c.deliver(3, 2)
	c.deliver(2, 1)
	c.deliver(2, 3)
	c.requireState(2, StateFollower) // quorum of rejections: steps down
	c.requireState(1, StateFollower) // and the peers' term moved on

	// Node 1 re-campaigns at a higher term with the longest log and wins.
	c.campaign(1)
	c.deliver(2, 1) // candidate 2 steps down and grants
	c.deliver(3, 1)
	c.deliver(1, 2)
	c.deliver(1, 3)
	c.requireState(1, StateLeader)
	c.pump() // noop replication; node 2's log catches up via reject/retry

	lead := c.nodes[1].rn.Status().HardState.GetCommit()
	if n2 := c.nodes[2].rn.Status().HardState.GetCommit(); n2 != lead {
		t.Fatalf("node 2 commit = %d, want %d (caught up)", n2, lead)
	}
}

// TestTLATrace_SecondElection: leader 1 established with a committed proposal,
// then node 2 (log up to date) campaigns and wins a higher-term election; the
// old leader observes the new term via the new leader's append.
func TestTLATrace_SecondElection(t *testing.T) {
	c := newTLACluster(t, "etcd_run05")
	c.elect(1, 2, 3)
	c.propose(1, "s1")
	c.pump() // fully replicated + committed on all three

	c.campaign(2)
	c.deliver(3, 2) // node 3 votes first this time
	c.deliver(1, 2) // old leader steps down and votes
	c.deliver(2, 3)
	c.deliver(2, 1)
	c.requireState(2, StateLeader)
	// New leader's noop: deliver to 3 first, then the old leader.
	c.deliver(3, 2)
	c.deliver(1, 2)
	c.deliver(2, 3)
	c.deliver(2, 1)
	c.pump()

	// Two heartbeat rounds from the NEW leader (higher-term heartbeats),
	// delivered in opposite orders.
	c.tick(2)
	c.deliver(1, 2)
	c.deliver(3, 2)
	c.deliver(2, 1)
	c.deliver(2, 3)
	c.tick(2)
	c.deliver(3, 2)
	c.deliver(1, 2)
	c.deliver(2, 3)
	c.deliver(2, 1)
	c.pump()

	for id := uint64(1); id <= 3; id++ {
		if term := c.nodes[id].rn.Status().HardState.GetTerm(); term != 2 {
			t.Fatalf("node %d term = %d, want 2", id, term)
		}
	}
	c.requireState(1, StateFollower)
}
