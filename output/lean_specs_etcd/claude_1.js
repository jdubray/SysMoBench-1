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
// The observable state gives us log (last index) but not last log term.
// The real raftLog.isUpToDate uses lastEntryID().term. Since our observable
// state has no per-entry terms, we approximate the last log term as the
// node's current term when it has a nonzero log, else 0. For a fresh cluster
// most comparisons reduce to index comparison.
function lastLogTerm(node) {
  return node.log === 0 ? 0 : node.term;
}

function isUpToDate(node, candLogTerm, candIndex) {
  const myTerm = lastLogTerm(node);
  if (candLogTerm !== myTerm) {
    return candLogTerm > myTerm;
  }
  return candIndex >= node.log;
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
      // becomeCandidate: reset(term+1), Vote=self, state=candidate.
      // A leader ignores MsgHup.
      if (node.role === 'leader') {
        break;
      }
      node.term = node.term + 1;
      node.role = 'candidate';
      node.vote = id;
      // reset clears lead, but observable state has no lead field.
      break;
    }

    case 'HandleVoteRequest': {
      const from = String(data.from);
      const mterm = data.term;
      const logTerm = data.logTerm;
      const index = data.index;

      // Step: handle term.
      if (mterm > node.term) {
        // MsgVote with higher term -> become follower at new term, vote reset.
        node.role = 'follower';
        node.term = mterm;
        node.vote = '0';
      } else if (mterm < node.term) {
        // Lower term MsgVote: rejected, no state change.
        break;
      }

      // Now m.Term == r.Term (or was raised to it).
      // canVote: repeat of prior vote OR (no vote and no leader).
      // We have no explicit lead field; model vote==None && (no leader known).
      const canVote = node.vote === from || node.vote === '0';

      if (canVote && isUpToDate(node, logTerm, index)) {
        // Grant vote.
        node.vote = from;
        // electionElapsed reset - not observable.
      }
      // else rejected, no observable change.
      break;
    }

    case 'ClientProposal': {
      // Only a leader appends. Followers/candidates would forward/drop;
      // no observable state change for them.
      if (node.role === 'leader') {
        node.log = node.log + 1;
      }
      break;
    }

    case 'HandleAppendEntries': {
      const from = String(data.from);
      const mterm = data.term;
      const index = data.index;
      const entries = data.entries || 0;
      const commit = data.commit;

      // Handle term.
      if (mterm > node.term) {
        node.role = 'follower';
        node.term = mterm;
        node.vote = '0';
      } else if (mterm < node.term) {
        // Lower term MsgApp -> reply MsgAppResp (no observable state change).
        break;
      } else {
        // Same term: candidate steps down to follower on MsgApp.
        if (node.role === 'candidate') {
          node.role = 'follower';
        }
      }

      // stepFollower MsgApp: lead = from, handleAppendEntries.
      // handleAppendEntries: if prev.index < committed -> ack committed, no change.
      if (index < node.commit) {
        break;
      }

      // maybeAppend: check log match at prev index.
      // We track only last index. Accept if prev index <= our log.
      if (index <= node.log) {
        const lastNewIndex = index + entries;
        if (lastNewIndex > node.log) {
          node.log = lastNewIndex;
        }
        // commitTo min(commit, lastNewIndex)
        const newCommit = Math.min(commit, lastNewIndex);
        if (newCommit > node.commit) {
          node.commit = newCommit;
        }
      }
      // else rejected: no observable state change.
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

      // handleHeartbeat: commitTo(min(commit, lastIndex)).
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