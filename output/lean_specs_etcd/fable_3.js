// Trace-level specification of etcd/raft (3-node cluster) over the observable
// state { role, term, vote, commit, log } per node.
//
// Assumptions matching the traced configuration: PreVote and CheckQuorum are
// disabled (plain elections, lower-term messages are simply ignored), quorum
// is 2 of 3 so a campaigning node stays candidate within its own step window
// (vote tallying / winning and leader commit advancement are separate trace
// steps outside these action windows).

function initialNode() {
  return { role: 'follower', term: 0, vote: '0', commit: 0, log: 0 };
}

function init() {
  return {
    nodes: {
      '1': initialNode(),
      '2': initialNode(),
      '3': initialNode()
    }
  };
}

function cloneState(state) {
  const nodes = {};
  for (const id of Object.keys(state.nodes)) {
    const n = state.nodes[id];
    nodes[id] = {
      role: n.role,
      term: n.term,
      vote: n.vote,
      commit: n.commit,
      log: n.log
    };
  }
  return { nodes };
}

function next(state, action, data) {
  const s = cloneState(state);
  const id = String(data.node);
  const n = s.nodes[id];

  switch (action) {
    case 'ElectionTimeout': {
      // tickElection -> MsgHup -> hup -> campaign -> becomeCandidate.
      // Leaders run tickHeartbeat instead; no election from leader state.
      if (n.role === 'leader') break;
      n.role = 'candidate';
      n.term = n.term + 1;
      n.vote = id; // votes for itself
      break;
    }

    case 'HandleVoteRequest': {
      const from = String(data.from);
      const mterm = data.term;

      // m.Term < r.Term: ignored (no observable change).
      if (mterm < n.term) break;

      const preTerm = n.term;

      // m.Term > r.Term: becomeFollower(m.Term, None) before voting logic.
      if (mterm > n.term) {
        n.role = 'follower';
        n.term = mterm;
        n.vote = '0';
      }

      // canVote: repeat of an already-cast vote, or no vote yet this term
      // (and no known leader; leaders/candidates always have vote==self).
      const canVote = n.vote === from || n.vote === '0';

      // isUpToDate against our last entry. Last log term is approximated by
      // the pre-message term (entries are appended at the appender's term),
      // and 0 for an empty log.
      const lastTerm = n.log === 0 ? 0 : preTerm;
      const upToDate =
        data.logTerm > lastTerm ||
        (data.logTerm === lastTerm && data.index >= n.log);

      if (canVote && upToDate) {
        n.vote = from; // cast the vote (r.Vote = m.From)
      }
      // rejection: no further observable change.
      break;
    }

    case 'ClientProposal': {
      // Leader: appendEntry -> one new entry at the tail. Self-ack /
      // commit advancement happens in later trace steps.
      // Follower: forwards to leader (no local change).
      // Candidate: proposal dropped (no local change).
      if (n.role === 'leader') {
        n.log = n.log + 1;
      }
      break;
    }

    case 'HandleAppendEntries': {
      const mterm = data.term;
      const entLen = Array.isArray(data.entries)
        ? data.entries.length
        : (data.entries || 0);

      // Lower term: ignored (or an immediate response; no local change).
      if (mterm < n.term) break;

      if (mterm > n.term) {
        // becomeFollower(m.Term, m.From)
        n.role = 'follower';
        n.term = mterm;
        n.vote = '0';
      } else if (n.role === 'candidate') {
        // becomeFollower(m.Term, m.From) at same term keeps the vote.
        n.role = 'follower';
      } else if (n.role === 'leader') {
        // stepLeader has no MsgApp case at the same term.
        break;
      }

      // handleAppendEntries:
      if (data.index < n.commit) {
        // Reply with commit index; no local change.
        break;
      }
      if (data.index <= n.log) {
        // Log matches at prev (approximated by index containment):
        // maybeAppend succeeds, lastnewi = index + len(entries),
        // commitTo(min(m.Commit, lastnewi)).
        const lastnewi = data.index + entLen;
        n.log = Math.max(n.log, lastnewi);
        n.commit = Math.max(n.commit, Math.min(data.commit, lastnewi));
      }
      // else: rejection response only; no local change.
      break;
    }

    case 'HandleHeartbeat': {
      const mterm = data.term;

      if (mterm < n.term) break;

      if (mterm > n.term) {
        n.role = 'follower';
        n.term = mterm;
        n.vote = '0';
      } else if (n.role === 'candidate') {
        n.role = 'follower'; // same-term step down, vote kept
      } else if (n.role === 'leader') {
        break; // stepLeader ignores MsgHeartbeat
      }

      // handleHeartbeat: commitTo(m.Commit) — only ever raises commit;
      // leader guarantees m.Commit <= follower's log (min(Match, committed)).
      n.commit = Math.max(n.commit, Math.min(data.commit, n.log));
      break;
    }

    default:
      break;
  }

  return s;
}

module.exports = { init, next };