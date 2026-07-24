'use strict';

// Pure transition function modeling the observable single-step behavior of
// etcd/raft (raft.go) for a deterministic 3-node cluster.
// Assumptions matching the traced implementation: PreVote=false, CheckQuorum=false.

function cloneNode(n) {
  return { role: n.role, term: n.term, vote: n.vote, commit: n.commit, log: n.log };
}

function init() {
  const mk = () => ({ role: 'follower', term: 0, vote: '0', commit: 0, log: 0 });
  return { nodes: { '1': mk(), '2': mk(), '3': mk() } };
}

function next(state, action, data) {
  const id = String(data.node);
  const pre = state.nodes[id];
  const n = cloneNode(pre);

  switch (action) {
    case 'ElectionTimeout': {
      // hup() -> campaign(campaignElection) -> becomeCandidate()
      // Leaders ignore MsgHup ("already leader"). Vote counting for the
      // self-vote happens in later steps, not here.
      if (n.role !== 'leader') {
        n.role = 'candidate';
        n.term = pre.term + 1;
        n.vote = id;
      }
      break;
    }

    case 'ClientProposal': {
      // stepLeader MsgProp -> appendEntry (one entry). Followers forward,
      // candidates drop: no local observable change for them.
      if (n.role === 'leader') {
        n.log = pre.log + 1;
      }
      break;
    }

    case 'HandleVoteRequest': {
      const from = String(data.from);
      const mTerm = data.term;
      const preTerm = pre.term;

      if (mTerm < preTerm) {
        // "ignored a message with lower term": no change.
        break;
      }
      if (mTerm > preTerm) {
        // Step(): becomeFollower(m.Term, None) for MsgVote with higher term.
        n.term = mTerm;
        n.vote = '0';
        n.role = 'follower';
      }
      // canVote: repeat of a prior vote, or no vote cast yet (lead == None
      // after stepping down for a higher-term vote request).
      const canVote = (n.vote === from) || (n.vote === '0');
      // isUpToDate(candidate last entry) — the observable state carries no
      // per-entry log terms; approximate the voter's last log term by its
      // pre-message term when it has entries (entries were appended by a
      // leader of that term in these traces).
      const estLastTerm = pre.log > 0 ? preTerm : 0;
      const upToDate = (data.logTerm > estLastTerm) || (data.index >= pre.log);
      if (canVote && upToDate) {
        n.vote = from; // record the (real) vote
      }
      break;
    }

    case 'HandleAppendEntries': {
      const mTerm = data.term;
      if (mTerm < pre.term) {
        // Lower-term MsgApp: replied to / ignored, no local state change.
        break;
      }
      if (mTerm > pre.term) {
        // becomeFollower(m.Term, from): term bump resets the vote.
        n.term = mTerm;
        n.vote = '0';
        n.role = 'follower';
      } else {
        // Equal term: candidates step down (vote preserved, same term);
        // a leader never sees an equal-term MsgApp from another leader.
        if (pre.role === 'leader') break;
        n.role = 'follower';
      }

      const entries = data.entries || 0;
      const prevIndex = data.index;

      if (prevIndex < n.commit) {
        // Early return path: respond with commit index, no local change.
        break;
      }
      if (prevIndex <= n.log) {
        // Log matches at prevIndex (consistent-prefix assumption):
        // maybeAppend succeeds.
        const lastnewi = prevIndex + entries;
        if (lastnewi > n.log) n.log = lastnewi;
        const c = Math.min(data.commit, lastnewi);
        if (c > n.commit) n.commit = c;
      }
      // else: rejection (hint reply), no local state change.
      break;
    }

    case 'HandleHeartbeat': {
      const mTerm = data.term;
      if (mTerm < pre.term) {
        // Lower-term heartbeat: ignored locally.
        break;
      }
      if (mTerm > pre.term) {
        n.term = mTerm;
        n.vote = '0';
        n.role = 'follower';
      } else {
        if (pre.role === 'leader') break; // impossible in practice
        n.role = 'follower'; // candidates step down; followers stay
      }
      // handleHeartbeat: commitTo(m.Commit); leader guarantees
      // m.Commit <= min(match, committed) so it never exceeds our log.
      if (data.commit > n.commit) n.commit = data.commit;
      break;
    }

    default:
      break;
  }

  const nodes = {};
  for (const k of Object.keys(state.nodes)) {
    nodes[k] = (k === id) ? n : cloneNode(state.nodes[k]);
  }
  return { nodes };
}

module.exports = { init, next };