// Pure transition function modeling the observable single-step behavior of
// etcd/raft (raft.go) for a deterministic 3-node cluster.
// Assumptions matching the traced configuration: PreVote=false, CheckQuorum=false.

'use strict';

var NODE_IDS = ['1', '2', '3'];

function init() {
  var nodes = {};
  for (var i = 0; i < NODE_IDS.length; i++) {
    nodes[NODE_IDS[i]] = { role: 'follower', term: 0, vote: '0', commit: 0, log: 0 };
  }
  return { nodes: nodes };
}

function cloneState(state) {
  var nodes = {};
  for (var i = 0; i < NODE_IDS.length; i++) {
    var id = NODE_IDS[i];
    var n = state.nodes[id];
    nodes[id] = { role: n.role, term: n.term, vote: n.vote, commit: n.commit, log: n.log };
  }
  return { nodes: nodes };
}

function next(state, action, data) {
  var s = cloneState(state);
  var id = String(data.node);
  var n = s.nodes[id];
  if (!n) return s;

  switch (action) {
    case 'ElectionTimeout': {
      // hup() -> campaign(campaignElection) -> becomeCandidate()
      // Leaders ignore MsgHup ("already leader").
      if (n.role !== 'leader') {
        n.role = 'candidate';
        n.term = n.term + 1;
        n.vote = id; // votes for itself
      }
      break;
    }

    case 'HandleVoteRequest': {
      var from = String(data.from);
      var mTerm = data.term;
      var oldTerm = n.term;
      if (mTerm < oldTerm) {
        // stale vote request: rejected, no local state change
        break;
      }
      if (mTerm > oldTerm) {
        // becomeFollower(m.Term, None): term changes, vote reset
        n.term = mTerm;
        n.vote = '0';
        n.role = 'follower';
      }
      // canVote: repeat of a prior vote, or no vote cast yet this term
      var canVote = (n.vote === from) || (n.vote === '0');
      // isUpToDate(candidate last entry) against our last entry.
      // Our last log term is bounded above by our (pre-bump) term; a strictly
      // higher candidate log term always wins, otherwise compare indexes.
      var upToDate = (data.logTerm > oldTerm) || (data.index >= n.log);
      if (canVote && upToDate) {
        n.vote = from; // cast the vote (electionElapsed reset is unobservable)
      }
      break;
    }

    case 'ClientProposal': {
      // Leader appends one entry to its own log (MsgAppResp self-ack and any
      // commit advancement are separate trace steps). Followers forward the
      // proposal (no local change); candidates drop it.
      if (n.role === 'leader') {
        n.log = n.log + 1;
      }
      break;
    }

    case 'HandleAppendEntries': {
      var aTerm = data.term;
      var aOldTerm = n.term;
      if (aTerm < aOldTerm) {
        // stale MsgApp: reply only, no local change
        break;
      }
      if (aTerm > aOldTerm) {
        // becomeFollower(m.Term, m.From): term changes -> vote reset
        n.term = aTerm;
        n.vote = '0';
        n.role = 'follower';
      }
      if (n.role === 'leader') {
        // equal-term MsgApp at a leader: stepLeader has no MsgApp case
        break;
      }
      if (n.role === 'candidate') {
        // becomeFollower(m.Term, m.From) at same term: vote preserved
        n.role = 'follower';
      }
      var ents = data.entries || 0;
      var prevIndex = data.index;
      if (prevIndex < n.commit) {
        // early return: respond with commit index, no state change
        break;
      }
      if (prevIndex > n.log) {
        // log doesn't contain prev entry: reject, no state change
        break;
      }
      // accepted: append entries (already-present entries keep the log),
      // then commitTo(min(m.Commit, lastIndexOfAppend))
      var mlast = prevIndex + ents;
      if (n.log < mlast) {
        n.log = mlast;
      }
      var toCommit = Math.min(data.commit, mlast);
      if (toCommit > n.commit) {
        n.commit = toCommit;
      }
      break;
    }

    case 'HandleHeartbeat': {
      var hTerm = data.term;
      var hOldTerm = n.term;
      if (hTerm < hOldTerm) {
        // stale heartbeat: reply only, no local change
        break;
      }
      if (hTerm > hOldTerm) {
        // becomeFollower(m.Term, m.From): term changes -> vote reset
        n.term = hTerm;
        n.vote = '0';
        n.role = 'follower';
      }
      if (n.role === 'leader') {
        // equal-term heartbeat at a leader: not handled by stepLeader
        break;
      }
      if (n.role === 'candidate') {
        // becomeFollower at same term: vote preserved
        n.role = 'follower';
      }
      // handleHeartbeat: commitTo(m.Commit). In the real system the leader
      // only ever sends min(r.raftLog.committed, pr.Match) as m.Commit, so
      // the advanced commit index never exceeds the follower's last log
      // index (raftLog.commitTo would panic otherwise). Model that
      // guarantee explicitly by clamping to our last index.
      var hCommit = Math.min(data.commit, n.log);
      if (hCommit > n.commit) {
        n.commit = hCommit;
      }
      break;
    }

    default:
      break;
  }

  return s;
}

module.exports = { init: init, next: next };
