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

// isUpToDate: candidate's (logTerm,index) at least as up-to-date as node's last entry.
// node's last entry term is unknown in observable state; the trace uses the node's
// current term as a proxy for its last-log term only when relevant. We model the
// standard comparison using the node's log index and its term.
function candIsUpToDate(node, logTerm, index) {
  // Compare (logTerm, index) against node's last entry (nodeLastTerm, node.log).
  // We approximate node's last log term with node.term (the term under which its
  // last entries were appended in a deterministic cluster where nodes only append
  // in their current term). Standard rule: up-to-date if
  //   logTerm > nodeLastTerm || (logTerm == nodeLastTerm && index >= node.log)
  const nodeLastTerm = node.term;
  if (logTerm > nodeLastTerm) return true;
  if (logTerm < nodeLastTerm) return false;
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
      // becomeCandidate: term+1, vote for self, role candidate.
      // (Leader ignores MsgHup; but ElectionTimeout on leader here—leaders
      // don't campaign. A leader stays leader. A follower/candidate campaigns.)
      if (n.role === 'leader') {
        // leader ignores MsgHup
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

      // Step: handle message term.
      if (term > n.term) {
        // Higher term: become follower at new term (lead=None for MsgVote),
        // reset vote.
        n.term = term;
        n.vote = '0';
        n.role = 'follower';
      } else if (term < n.term) {
        // Lower term: reject (no observable change to term/vote/role).
        break;
      }

      // Now term == n.term. Decide vote.
      // canVote: repeat vote for same, or haven't voted and no leader.
      const canVote =
        n.vote === from ||
        (n.vote === '0');

      if (canVote && candIsUpToDate(n, logTerm, index)) {
        // grant vote
        n.vote = from;
        // (electionElapsed reset — not observable)
      }
      // else reject — vote unchanged.
      break;
    }

    case 'ClientProposal': {
      // Only a leader appends. Follower/candidate drop or forward (no observable
      // change to log). Leader appends one entry.
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
        // Lower term: reject; send MsgAppResp with our term. No observable change.
        break;
      }

      if (term > n.term) {
        // Higher term MsgApp: become follower at new term, lead=from.
        n.term = term;
        n.vote = '0';
        n.role = 'follower';
      } else {
        // term == n.term: candidate becomes follower; follower stays follower.
        if (n.role === 'candidate') {
          n.role = 'follower';
        } else if (n.role === 'leader') {
          // shouldn't happen at same term, but treat as follower step-down guard.
          n.role = 'follower';
        }
        n.role = 'follower';
      }

      // handleAppendEntries:
      // if prev.index < committed -> ack committed, no change to log.
      if (index < n.commit) {
        // ack with committed; log unchanged
        break;
      }

      // maybeAppend: match at prev (logTerm,index). We model success when the
      // append is consistent: prev.index <= our log (leader's prev is within
      // our log) and the term is compatible. In the deterministic cluster this
      // append succeeds; new last index = index + entries.
      const matchOk = index <= n.log && logTerm <= n.term;

      if (matchOk) {
        const newLast = index + entries;
        if (newLast > n.log) {
          n.log = newLast;
        }
        // commitTo min(commit, newLast)
        const newCommit = Math.min(commit, n.log);
        if (newCommit > n.commit) {
          n.commit = newCommit;
        }
      }
      // else reject: log/commit unchanged.
      break;
    }

    case 'HandleHeartbeat': {
      const from = String(data.from);
      const term = data.term;
      const commit = data.commit;

      if (term < n.term) {
        // lower term: no observable change.
        break;
      }

      if (term > n.term) {
        n.term = term;
        n.vote = '0';
        n.role = 'follower';
      } else {
        if (n.role === 'candidate' || n.role === 'leader') {
          n.role = 'follower';
        }
        n.role = 'follower';
      }

      // handleHeartbeat: commitTo(min(commit, lastIndex)).
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