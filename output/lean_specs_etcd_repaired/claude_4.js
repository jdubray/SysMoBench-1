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
// index; the node's last-entry term is approximated by the term the node
// held BEFORE processing this message (i.e. the term under which its last
// entry was appended), NOT the (possibly bumped) current term.
function isUpToDate(myLastTerm, myLastIndex, candLogTerm, candIndex) {
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
      return ns;
    }

    case 'HandleVoteRequest': {
      const from = String(data.from);
      const mTerm = data.term;
      const logTerm = data.logTerm;
      const index = data.index;

      // Capture the node's own last-entry term BEFORE any term step-up.
      // Its last log entry was appended under its current term (or 0 if
      // the log is empty).
      const myLastTerm = node.log === 0 ? 0 : node.term;
      const myLastIndex = node.log;

      // Term handling: if message term is higher, step down to follower and
      // clear our vote so we are free to grant it this term.
      if (mTerm > node.term) {
        node.term = mTerm;
        node.vote = '0';
        node.role = 'follower';
      } else if (mTerm < node.term) {
        // Lower term: reject, no observable state change.
        return ns;
      }

      // Now mTerm == node.term. Decide whether to grant the vote.
      // We may vote if we haven't voted this term, or already voted for
      // this same candidate.
      const canVote = node.vote === from || node.vote === '0';

      const upToDate = isUpToDate(myLastTerm, myLastIndex, logTerm, index);

      if (canVote && upToDate) {
        node.vote = from;
        node.role = 'follower';
      }
      // else reject — vote unchanged (term/role step-down already applied).
      return ns;
    }

    case 'ClientProposal': {
      if (node.role === 'leader') {
        node.log = node.log + 1;
      }
      return ns;
    }

    case 'HandleAppendEntries': {
      const mTerm = data.term;
      const index = data.index; // prevLogIndex
      const entries = data.entries || 0;
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

      if (index < node.commit) {
        return ns;
      }

      if (index <= node.log) {
        const newLast = index + entries;
        if (newLast > node.log) {
          node.log = newLast;
        }
        const newCommit = Math.min(commit, node.log);
        if (newCommit > node.commit) {
          node.commit = newCommit;
        }
        return ns;
      }

      return ns;
    }

    case 'HandleHeartbeat': {
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
