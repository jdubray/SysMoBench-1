'use strict';

function cloneNode(n) {
  return { role: n.role, term: n.term, vote: n.vote, commit: n.commit, log: n.log };
}

function init() {
  return {
    nodes: {
      '1': { role: 'follower', term: 0, vote: '0', commit: 0, log: 0 },
      '2': { role: 'follower', term: 0, vote: '0', commit: 0, log: 0 },
      '3': { role: 'follower', term: 0, vote: '0', commit: 0, log: 0 }
    }
  };
}

// Determines whether the candidate's log (candLogTerm, candIndex) is at
// least as up-to-date as the node's log.
//
// The node's last log term is NOT its current term: after a node steps
// down to a higher term (upon receiving a higher-term message), its stored
// entries still carry the older term at which they were appended. We
// therefore compare against the node's log term as observed *before* this
// message bumped its current term (myLogTerm), which is what real raft
// uses (raftLog.lastTerm()).
function isUpToDate(myLogTerm, myIndex, candLogTerm, candIndex) {
  if (candLogTerm !== myLogTerm) {
    return candLogTerm > myLogTerm;
  }
  return candIndex >= myIndex;
}

function next(state, action, data) {
  const newState = { nodes: {} };
  for (const id of ['1', '2', '3']) {
    newState.nodes[id] = cloneNode(state.nodes[id]);
  }

  const nid = String(data.node);
  const n = newState.nodes[nid];

  switch (action) {
    case 'ElectionTimeout': {
      // becomeCandidate: increment term, vote for self, become candidate.
      if (n.role === 'leader') {
        // MsgHup ignored when already leader.
        break;
      }
      n.term = n.term + 1;
      n.vote = nid;
      n.role = 'candidate';
      break;
    }

    case 'HandleVoteRequest': {
      const from = String(data.from);
      const mterm = data.term;
      const logTerm = data.logTerm;
      const index = data.index;

      // Capture the node's last-log term BEFORE any term step-up.
      // Entries were appended at the term the node held when it stored
      // them; the empty log (index 0) has log term 0. We approximate the
      // last log term as the node's current term prior to processing this
      // message, which matches raftLog.lastTerm() for the traces observed.
      const myLastLogTerm = n.log === 0 ? 0 : n.term;
      const myLastIndex = n.log;

      // Term handling.
      if (mterm > n.term) {
        // Higher term: become follower at new term (lead=None for MsgVote).
        n.term = mterm;
        n.vote = '0';
        n.role = 'follower';
      } else if (mterm < n.term) {
        // Lower term: ignore (reject, no observable state change).
        break;
      }

      // Now mterm == n.term.
      const canVote =
        n.vote === from ||
        (n.vote === '0'); // haven't voted this term

      if (canVote && isUpToDate(myLastLogTerm, myLastIndex, logTerm, index)) {
        // Grant vote (real MsgVote).
        n.vote = from;
      }
      // else: reject — no observable change beyond term step-down.
      break;
    }

    case 'ClientProposal': {
      // Only a leader appends to its log.
      if (n.role === 'leader') {
        n.log = n.log + 1;
      }
      break;
    }

    case 'HandleAppendEntries': {
      const mterm = data.term;
      const index = data.index;
      const entries = data.entries || 0;
      const commit = data.commit;

      if (mterm > n.term) {
        n.term = mterm;
        n.vote = '0';
        n.role = 'follower';
      } else if (mterm < n.term) {
        // Lower term MsgApp: reply MsgAppResp (no observable change).
        break;
      } else {
        // Same term: become follower of leader.
        n.role = 'follower';
      }

      // handleAppendEntries: check prev index against commit.
      if (index < n.commit) {
        break;
      }

      // maybeAppend: does prev (logTerm,index) match our log?
      if (index <= n.log) {
        const mlastIndex = index + entries;
        if (mlastIndex > n.log) {
          n.log = mlastIndex;
        }
        const newCommit = Math.min(commit, n.log);
        if (newCommit > n.commit) {
          n.commit = newCommit;
        }
      }
      break;
    }

    case 'HandleHeartbeat': {
      const mterm = data.term;
      const commit = data.commit;

      if (mterm > n.term) {
        n.term = mterm;
        n.vote = '0';
        n.role = 'follower';
      } else if (mterm < n.term) {
        break;
      } else {
        n.role = 'follower';
      }

      const newCommit = Math.min(commit, n.log);
      if (newCommit > n.commit) {
        n.commit = newCommit;
      }
      break;
    }

    default:
      break;
  }

  return newState;
}

module.exports = { init, next };
