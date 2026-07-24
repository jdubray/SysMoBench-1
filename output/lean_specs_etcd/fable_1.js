// Pure transition function modeling the observable single-step behavior of
// etcd/raft (raft.go above) for a deterministic 3-node cluster.
// Assumptions matching the running configuration: PreVote = false,
// CheckQuorum = false (so no leases, plain elections).

function initNode() {
  return { role: 'follower', term: 0, vote: '0', commit: 0, log: 0 };
}

function init() {
  return {
    nodes: {
      '1': initNode(),
      '2': initNode(),
      '3': initNode()
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
      // hup() -> campaign(campaignElection) -> becomeCandidate()
      // Leaders ignore MsgHup. Followers and candidates bump term,
      // vote for themselves and become (or stay) candidate.
      if (n.role === 'leader') break;
      n.role = 'candidate';
      n.term = n.term + 1;
      n.vote = id;
      break;
    }

    case 'HandleVoteRequest': {
      const from = String(data.from);
      const mterm = data.term;
      const preTerm = state.nodes[id].term;

      if (mterm > n.term) {
        // Step(): higher-term MsgVote -> becomeFollower(m.Term, None)
        n.term = mterm;
        n.vote = '0';
        n.role = 'follower';
      } else if (mterm < n.term) {
        // Rejected with local term; no observable local change.
        break;
      }

      // canVote: repeat vote, or not yet voted (no known leader tracked here).
      const canVote = n.vote === from || n.vote === '0';

      // isUpToDate(candLastID): candidate's last entry term strictly greater
      // than anything we can hold (its logTerm exceeds our whole term), or
      // its last index reaches our last index.
      const upToDate = data.logTerm > preTerm || data.index >= n.log;

      if (canVote && upToDate) {
        // Cast the vote (MsgVote records the vote and resets election timer).
        n.vote = from;
      }
      // Rejection produces only a message; no further local change.
      break;
    }

    case 'ClientProposal': {
      // stepLeader MsgProp -> appendEntry (log grows by one entry).
      // Followers forward to the leader (no local change); candidates drop.
      if (n.role === 'leader') {
        n.log = n.log + 1;
      }
      break;
    }

    case 'HandleAppendEntries': {
      const mterm = data.term;

      if (mterm > n.term) {
        // becomeFollower(m.Term, m.From)
        n.term = mterm;
        n.vote = '0';
        n.role = 'follower';
      } else if (mterm < n.term) {
        // Lower-term MsgApp is ignored (only a response may be sent).
        break;
      } else {
        if (n.role === 'leader') break; // no equal-term MsgApp handling on leader
        if (n.role === 'candidate') {
          // becomeFollower(m.Term, m.From) at same term keeps Vote.
          n.role = 'follower';
        }
      }

      const entries = data.entries || 0;

      if (data.index < n.commit) {
        // Reply with commit index; no local change.
        break;
      }

      if (data.index <= n.log) {
        // Log matches at prev (observable approximation): append entries,
        // then commitTo(min(m.Commit, lastnewi)).
        const lastnewi = data.index + entries;
        if (lastnewi > n.log) n.log = lastnewi;
        const toCommit = Math.min(data.commit, lastnewi);
        if (toCommit > n.commit) n.commit = toCommit;
      }
      // else: reject (hint response only); no local change.
      break;
    }

    case 'HandleHeartbeat': {
      const mterm = data.term;

      if (mterm > n.term) {
        // becomeFollower(m.Term, m.From)
        n.term = mterm;
        n.vote = '0';
        n.role = 'follower';
      } else if (mterm < n.term) {
        break;
      } else {
        if (n.role === 'leader') break;
        if (n.role === 'candidate') {
          n.role = 'follower'; // same term: Vote preserved
        }
      }

      // handleHeartbeat -> commitTo(m.Commit); leader guarantees
      // m.Commit <= follower's log, so a plain max is faithful.
      if (data.commit > n.commit) n.commit = data.commit;
      break;
    }

    default:
      break;
  }

  return s;
}

module.exports = { init, next };