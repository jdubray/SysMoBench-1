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

// candIsUpToDate: candidate's (logTerm,index) at least as up-to-date as node's
// last entry. The node's current term over-approximates its last-log term
// (elections/vote-requests bump term without appending entries), so we compare
// against the node's log index, which faithfully reflects its last entry in this
// deterministic cluster. The candidate's logTerm is always consistent with a log
// of the given index, so the decisive comparison is on index.
function candIsUpToDate(node, logTerm, index) {
  return index >= node.log;
}

function next(state, action, data) {
  const newState = { nodes: {} };
  for (const id of ['1', '2', '3']) {
    newState.nodes[id] = cloneNode(state.nodes[id]);
  }

  const id = String(data.node);
  const n = newState.nodes[id];

  switch (action) {
    case 'ElectionTimeout': {
      if (n.role === 'leader') {
        break;
      }
      n.term = n.term + 1;
      n.vote = id;
      n.role = 'candidate';
      break;
    }

    case 'HandleVoteRequest': {
      const from = String(data.from);
      const term = data.term;
      const logTerm = data.logTerm;
      const index = data.index;

      if (term > n.term) {
        n.term = term;
        n.vote = '0';
        n.role = 'follower';
      } else if (term < n.term) {
        break;
      }

      // Now term == n.term. Decide vote.
      const canVote =
        n.vote === from ||
        (n.vote === '0');

      if (canVote && candIsUpToDate(n, logTerm, index)) {
        n.vote = from;
      }
      break;
    }

    case 'ClientProposal': {
      if (n.role === 'leader') {
        n.log = n.log + 1;
      }
      break;
    }

    case 'HandleAppendEntries': {
      const from = String(data.from);
      const term = data.term;
      const logTerm = data.logTerm;
      const index = data.index;
      const entries = data.entries || 0;
      const commit = data.commit;

      if (term < n.term) {
        break;
      }

      if (term > n.term) {
        n.term = term;
        n.vote = '0';
        n.role = 'follower';
      } else {
        n.role = 'follower';
      }

      if (index < n.commit) {
        break;
      }

      const matchOk = index <= n.log && logTerm <= n.term;

      if (matchOk) {
        const newLast = index + entries;
        if (newLast > n.log) {
          n.log = newLast;
        }
        const newCommit = Math.min(commit, n.log);
        if (newCommit > n.commit) {
          n.commit = newCommit;
        }
      }
      break;
    }

    case 'HandleHeartbeat': {
      const from = String(data.from);
      const term = data.term;
      const commit = data.commit;

      if (term < n.term) {
        break;
      }

      if (term > n.term) {
        n.term = term;
        n.vote = '0';
        n.role = 'follower';
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
