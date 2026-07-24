// Pure transition function modeling the observable single-step behavior of
// etcd/raft (raft.go) for a deterministic 3-node cluster.
//
// Observable state per node: { role, term, vote, commit, log }

function freshNode() {
  return { role: 'follower', term: 0, vote: '0', commit: 0, log: 0 };
}

function init() {
  return {
    nodes: {
      '1': freshNode(),
      '2': freshNode(),
      '3': freshNode(),
    },
  };
}

function next(state, action, data) {
  const id = String(data.node);
  const old = state.nodes[id];
  // working copy of the acting node
  const n = {
    role: old.role,
    term: old.term,
    vote: old.vote,
    commit: old.commit,
    log: old.log,
  };

  switch (action) {
    case 'ElectionTimeout': {
      // hup() -> campaign(campaignElection) -> becomeCandidate()
      // Leaders ignore MsgHup ("already leader").
      if (n.role !== 'leader') {
        n.role = 'candidate';
        n.term = n.term + 1;
        n.vote = id; // votes for itself
      }
      break;
    }

    case 'HandleVoteRequest': {
      const from = String(data.from);
      const mTerm = data.term;
      if (mTerm > n.term) {
        // Step(): higher-term MsgVote -> becomeFollower(m.Term, None)
        n.term = mTerm;
        n.vote = '0';
        n.role = 'follower';
      }
      if (mTerm === n.term) {
        // canVote: repeat vote, or no vote cast yet (and no known leader).
        const canVote = n.vote === from || n.vote === '0';
        // isUpToDate approximation over observable state:
        // grant if candidate's log is at least as long, or its last log term
        // is provably newer than anything the voter can hold.
        const upToDate = data.index >= n.log || data.logTerm > old.term;
        if (canVote && upToDate) {
          n.vote = from;
        }
      }
      // mTerm < n.term: rejection sent, no observable state change.
      break;
    }

    case 'ClientProposal': {
      // Leader appends one entry to its own log (self-ack / commit advance
      // are separate steps). Followers forward, candidates drop: no change.
      if (n.role === 'leader') {
        n.log = n.log + 1;
      }
      break;
    }

    case 'HandleAppendEntries': {
      const mTerm = data.term;
      if (mTerm < n.term) {
        // stale message: response only, no state change
        break;
      }
      if (mTerm > n.term) {
        // becomeFollower(m.Term, from)
        n.term = mTerm;
        n.vote = '0';
        n.role = 'follower';
      } else if (n.role === 'candidate') {
        // same term: candidate steps down (vote preserved, term unchanged)
        n.role = 'follower';
      }
      // A leader at the same term never processes MsgApp.
      if (n.role === 'follower') {
        const idx = data.index;
        const ents = data.entries || 0;
        if (idx < n.commit) {
          // early return: ack with commit index, no local change
        } else if (idx <= n.log) {
          // log matches at idx (observable approximation): append/overwrite
          const last = idx + ents;
          if (ents > 0) {
            // conflicting suffixes are truncated and replaced
            n.log = last;
          }
          const c = Math.min(data.commit, last);
          if (c > n.commit) {
            n.commit = c;
          }
        }
        // idx > n.log: reject, no state change
      }
      break;
    }

    case 'HandleHeartbeat': {
      const mTerm = data.term;
      if (mTerm < n.term) {
        // stale heartbeat: ignored / response only
        break;
      }
      if (mTerm > n.term) {
        n.term = mTerm;
        n.vote = '0';
        n.role = 'follower';
      } else if (n.role === 'candidate') {
        n.role = 'follower';
      }
      if (n.role === 'follower') {
        // commitTo(m.Commit): only ever advances
        if (data.commit > n.commit) {
          n.commit = data.commit;
        }
      }
      break;
    }

    default:
      break;
  }

  // rebuild full cluster state without mutating the input
  const nodes = {};
  for (const key of Object.keys(state.nodes)) {
    if (key === id) {
      nodes[key] = n;
    } else {
      const o = state.nodes[key];
      nodes[key] = {
        role: o.role,
        term: o.term,
        vote: o.vote,
        commit: o.commit,
        log: o.log,
      };
    }
  }
  return { nodes };
}

module.exports = { init, next };