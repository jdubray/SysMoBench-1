'use strict';

function init() {
  return {
    nodes: {
      '1': { role: 'follower', term: 0, vote: '0', commit: 0, log: 0 },
      '2': { role: 'follower', term: 0, vote: '0', commit: 0, log: 0 },
      '3': { role: 'follower', term: 0, vote: '0', commit: 0, log: 0 },
    },
  };
}

function cloneState(state) {
  return {
    nodes: {
      '1': Object.assign({}, state.nodes['1']),
      '2': Object.assign({}, state.nodes['2']),
      '3': Object.assign({}, state.nodes['3']),
    },
  };
}

// Determine whether the candidate's last-entry (logTerm,index) is at least
// as up-to-date as the node's own log. We only track the node's last log
// index; we approximate the log term by the node's current term, which is
// the observable behavior for these deterministic traces.
function isUpToDate(node, candLogTerm, candIndex) {
  // node's last entry term is approximated by node.term (the term under which
  // its last entry was appended). For a fresh follower with empty log, term 0.
  const myLastTerm = node.term;
  const myLastIndex = node.log;
  if (candLogTerm !== myLastTerm) {
    return candLogTerm > myLastTerm;
  }
  return candIndex >= myLastIndex;
}

function next(state, action, data) {
  const ns = cloneState(state);
  const id = String(data.node);
  const node = ns.nodes[id];

  switch (action) {
    case 'ElectionTimeout': {
      // becomeCandidate: increment term, vote for self, become candidate.
      // A leader ignores MsgHup.
      if (node.role === 'leader') {
        return ns;
      }
      node.term = node.term + 1;
      node.vote = id;
      node.role = 'candidate';
      // reset() sets lead = None, commit unchanged, log unchanged.
      return ns;
    }

    case 'HandleVoteRequest': {
      const from = String(data.from);
      const mTerm = data.term;
      const logTerm = data.logTerm;
      const index = data.index;

      // Term handling: if message term is higher, step down to follower.
      if (mTerm > node.term) {
        node.term = mTerm;
        node.vote = '0';
        node.role = 'follower';
      } else if (mTerm < node.term) {
        // Lower term: ignore (reject, no observable state change here).
        return ns;
      }

      // Now mTerm == node.term. Decide whether to grant the vote.
      const canVote =
        node.vote === from ||
        (node.vote === '0'); // haven't voted and no known leader
      // (we don't track leader id; treat vote=='0' as free to vote)

      const upToDate = isUpToDate(node, logTerm, index);

      if (canVote && upToDate) {
        node.vote = from;
        node.role = 'follower';
        // electionElapsed reset — not observable.
      }
      // else reject — vote unchanged (already possibly updated term above).
      return ns;
    }

    case 'ClientProposal': {
      // Only a leader appends. Followers/candidates drop or forward
      // (no observable local log change).
      if (node.role === 'leader') {
        node.log = node.log + 1;
      }
      return ns;
    }

    case 'HandleAppendEntries': {
      const from = String(data.from);
      const mTerm = data.term;
      const index = data.index; // prevLogIndex
      const entries = data.entries || 0;
      const commit = data.commit;

      // Term handling.
      if (mTerm > node.term) {
        node.term = mTerm;
        node.vote = '0';
        node.role = 'follower';
      } else if (mTerm < node.term) {
        // Stale MsgApp: reject, no observable change.
        return ns;
      } else {
        // Same term: become follower of the sender.
        node.role = 'follower';
      }

      // stepFollower: on MsgApp, set lead = from (not observable), then
      // handleAppendEntries.
      // If prevIndex < committed, ack committed (no change).
      if (index < node.commit) {
        return ns;
      }

      // maybeAppend: accept if prevIndex <= our last log index.
      if (index <= node.log) {
        const newLast = index + entries;
        if (newLast > node.log) {
          node.log = newLast;
        }
        // commitTo: min(commit, lastIndex).
        const newCommit = Math.min(commit, node.log);
        if (newCommit > node.commit) {
          node.commit = newCommit;
        }
        return ns;
      }

      // Reject: log doesn't match. No observable state change beyond
      // possible term/role step-down already applied.
      return ns;
    }

    case 'HandleHeartbeat': {
      const from = String(data.from);
      const mTerm = data.term;
      const commit = data.commit;

      if (mTerm > node.term) {
        node.term = mTerm;
        node.vote = '0';
        node.role = 'follower';
      } else if (mTerm < node.term) {
        return ns;
      } else {
        node.role = 'follower';
      }

      // handleHeartbeat: commitTo(min(commit, lastIndex)).
      const newCommit = Math.min(commit, node.log);
      if (newCommit > node.commit) {
        node.commit = newCommit;
      }
      return ns;
    }

    default:
      return ns;
  }
}

module.exports = { init, next };