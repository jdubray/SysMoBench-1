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

// Determines whether the candidate's log (logTerm,index) is at least as
// up-to-date as the node's log. We only track last log index and current
// term as observable state. We approximate the last log term with the
// node's term (entries are appended at the node's current term).
function isUpToDate(node, candLogTerm, candIndex) {
  const myLogTerm = node.term;
  const myIndex = node.log;
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
      // (No PreVote in observable model.)
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

      // Term handling.
      if (mterm > n.term) {
        // Higher term: become follower at new term (lead=None for MsgVote).
        n.term = mterm;
        n.vote = '0';
        n.role = 'follower';
      } else if (mterm < n.term) {
        // Lower term: ignore (reject, but no observable state change).
        break;
      }

      // Now mterm == n.term.
      const canVote =
        n.vote === from ||
        (n.vote === '0'); // haven't voted and no known leader (we don't track lead)

      if (canVote && isUpToDate(n, logTerm, index)) {
        // Grant vote (real MsgVote).
        n.vote = from;
        // electionElapsed reset — not observable.
        // Remain follower (role unchanged unless already changed above).
      }
      // else: reject — no observable state change beyond term step-down.
      break;
    }

    case 'ClientProposal': {
      // Only a leader appends to its log.
      if (n.role === 'leader') {
        n.log = n.log + 1;
      }
      // Followers/candidates drop or forward — no observable change.
      break;
    }

    case 'HandleAppendEntries': {
      const from = String(data.from);
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
        // Reply with committed index; nothing observable changes.
        break;
      }

      // maybeAppend: does prev (logTerm,index) match our log?
      // We approximate a match when index <= our log.
      if (index <= n.log) {
        // Append accepted. New last index = index + entries.
        const mlastIndex = index + entries;
        if (mlastIndex > n.log) {
          n.log = mlastIndex;
        }
        // commitTo: min(leaderCommit, mlastIndex).
        const newCommit = Math.min(commit, n.log);
        if (newCommit > n.commit) {
          n.commit = newCommit;
        }
      }
      // else: reject (log doesn't match) — no observable change beyond term.
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

      // handleHeartbeat: commitTo(min(commit, log)).
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