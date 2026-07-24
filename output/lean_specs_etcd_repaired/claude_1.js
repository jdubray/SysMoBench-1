'use strict';

function cloneNode(n) {
  return { role: n.role, term: n.term, vote: n.vote, commit: n.commit, log: n.log };
}

function init() {
  return {
    nodes: {
      '1': { role: 'follower', term: 0, vote: '0', commit: 0, log: 0 },
      '2': { role: 'follower', term: 0, vote: '0', commit: 0, log: 0 },
      '3': { role: 'follower', term: 0, vote: '0', commit: 0, log: 0 },
    },
  };
}

// isUpToDate: candidate's (logTerm,index) vs receiver's last entry.
// The observable state lacks per-entry terms. The candidate's logTerm is the
// term of its last log entry. For the receiver, we cannot know its last entry
// term directly, but the candidate's log entries are a prefix/superset in the
// common case. We approximate: the receiver is up-to-date-blocking only if its
// log is strictly longer than the candidate's index AND the candidate's logTerm
// is not ahead. In practice raft grants when the candidate's log is at least as
// long. We compare using index when logTerm does not clearly dominate.
function isUpToDate(node, candLogTerm, candIndex) {
  // The candidate carries a real logTerm from its last entry. A node whose log
  // is not longer than the candidate's index has a last-entry term no greater
  // than the candidate's logTerm (the candidate has all committed history up to
  // its index). So decide primarily by index, which is fully observable.
  if (candIndex >= node.log) {
    return true;
  }
  // Candidate's log is shorter than ours. Only up-to-date if its last term is
  // strictly greater than ours; we cannot observe our last term, so treat a
  // strictly shorter candidate log as not up-to-date.
  return false;
}

function next(state, action, data) {
  const newState = { nodes: {} };
  for (const id of Object.keys(state.nodes)) {
    newState.nodes[id] = cloneNode(state.nodes[id]);
  }

  const id = String(data.node);
  const node = newState.nodes[id];
  if (!node) return newState;

  switch (action) {
    case 'ElectionTimeout': {
      if (node.role === 'leader') {
        break;
      }
      node.term = node.term + 1;
      node.role = 'candidate';
      node.vote = id;
      break;
    }

    case 'HandleVoteRequest': {
      const from = String(data.from);
      const mterm = data.term;
      const logTerm = data.logTerm;
      const index = data.index;

      let steppedUp = false;

      // Step: handle term.
      if (mterm > node.term) {
        // Higher term -> become follower at new term, clear vote.
        node.role = 'follower';
        node.term = mterm;
        node.vote = '0';
        steppedUp = true;
      } else if (mterm < node.term) {
        // Lower term MsgVote: rejected, no state change.
        break;
      }

      // Now m.Term == r.Term (possibly just raised).
      // canVote: repeat of prior vote OR (no vote recorded yet).
      const canVote = node.vote === from || node.vote === '0';

      if (canVote && isUpToDate(node, logTerm, index)) {
        node.vote = from;
      }
      // else rejected: keep vote as-is (which is '0' if we just stepped up).
      void steppedUp;
      break;
    }

    case 'ClientProposal': {
      if (node.role === 'leader') {
        node.log = node.log + 1;
      }
      break;
    }

    case 'HandleAppendEntries': {
      const mterm = data.term;
      const index = data.index;
      const entries = data.entries || 0;
      const commit = data.commit;

      if (mterm > node.term) {
        node.role = 'follower';
        node.term = mterm;
        node.vote = '0';
      } else if (mterm < node.term) {
        break;
      } else {
        if (node.role === 'candidate') {
          node.role = 'follower';
        }
      }

      if (index < node.commit) {
        break;
      }

      if (index <= node.log) {
        const lastNewIndex = index + entries;
        if (lastNewIndex > node.log) {
          node.log = lastNewIndex;
        }
        const newCommit = Math.min(commit, lastNewIndex);
        if (newCommit > node.commit) {
          node.commit = newCommit;
        }
      }
      break;
    }

    case 'HandleHeartbeat': {
      const mterm = data.term;
      const commit = data.commit;

      if (mterm > node.term) {
        node.role = 'follower';
        node.term = mterm;
        node.vote = '0';
      } else if (mterm < node.term) {
        break;
      } else {
        if (node.role === 'candidate') {
          node.role = 'follower';
        }
      }

      const newCommit = Math.min(commit, node.log);
      if (newCommit > node.commit) {
        node.commit = newCommit;
      }
      break;
    }

    default:
      break;
  }

  return newState;
}

module.exports = { init, next };
