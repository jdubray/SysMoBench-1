// Reference lean-contract spec for the etcd task (etcd-io/raft, 3-node cluster).
//
// Observable state — whole-cluster projection maintained by the harness fold
// (scripts/harness/etcd/build_windows.py):
//   { nodes: { "1": { role, term, vote, commit, log }, "2": {...}, "3": {...} } }
//     role   ∈ "follower" | "candidate" | "leader"
//     term   — current term (number)
//     vote   — votedFor as a string node id, "0" = none
//     commit — commit index (number)
//     log    — last log index (number; the projection has no per-entry terms)
//
// Modeled actions (task.yaml tv.target_actions) with data payloads:
//   ElectionTimeout     { node }
//   HandleVoteRequest   { node, from, term, logTerm, index }
//   ClientProposal      { node }
//   HandleAppendEntries { node, from, term, logTerm, index, entries, commit }
//   HandleHeartbeat     { node, from, term, commit }
//
// Two documented projection approximations (exact on the harness corpora,
// see scripts/harness/etcd/README.md):
//   1. Vote up-to-date check compares candidate lastIndex against the voter's
//      log size only (per-entry terms are not observable; the harness
//      scenarios keep last-log terms equal at every vote decision).
//   2. Append match check is `m.index <= log` (logs are prefixes of the
//      leader's log in the captured schedules, so index containment implies
//      the term-match raft actually performs).

function init() {
  const follower = { role: 'follower', term: 0, vote: '0', commit: 0, log: 0 };
  return {
    nodes: {
      1: { ...follower },
      2: { ...follower },
      3: { ...follower },
    },
  };
}

// next(state, action, data) -> state' (pure; never mutates its input).
function next(state, action, data) {
  const nodes = {};
  for (const id of Object.keys(state.nodes)) nodes[id] = { ...state.nodes[id] };
  const n = nodes[data.node];
  if (!n) return { nodes };

  if (action === 'ElectionTimeout') {
    // becomeCandidate: bump term, vote for self, switch role.
    n.term += 1;
    n.role = 'candidate';
    n.vote = String(data.node);
  } else if (action === 'HandleVoteRequest') {
    if (data.term >= n.term) {
      if (data.term > n.term) {
        // Higher-term MsgVote: step down first (becomeFollower(term, None)).
        n.term = data.term;
        n.role = 'follower';
        n.vote = '0';
      }
      // Grant iff we can vote (repeat vote or none cast) and the candidate's
      // log is at least as up to date as ours (index-determined projection).
      const canVote = n.vote === String(data.from) || n.vote === '0';
      const isUpToDate = data.index >= n.log;
      if (canVote && isUpToDate) n.vote = String(data.from);
    } // lower-term requests are rejected without state change
  } else if (action === 'ClientProposal') {
    // Replicate: only a leader appends a proposal to its log.
    if (n.role === 'leader') n.log += 1;
  } else if (action === 'HandleAppendEntries') {
    if (data.term >= n.term) {
      if (data.term > n.term) {
        n.term = data.term;
        n.vote = '0';
      }
      // An append from the current-term leader: we are (or become) a follower.
      n.role = 'follower';
      // Log match (prefix projection): accept iff we have the prev entry.
      if (data.index <= n.log) {
        const lastNew = data.index + data.entries;
        n.log = Math.max(n.log, lastNew);
        n.commit = Math.max(n.commit, Math.min(data.commit, lastNew));
      } // otherwise reject: no observable change
    } // lower-term appends are ignored
  } else if (action === 'HandleHeartbeat') {
    if (data.term >= n.term) {
      if (data.term > n.term) {
        n.term = data.term;
        n.vote = '0';
      }
      n.role = 'follower';
      // raft's commitTo contract: a leader never advertises a commit index
      // past the follower's log (it sends min(match, committed)); clamp so
      // the model stays safe on arbitrary explorer-generated payloads too.
      n.commit = Math.max(n.commit, Math.min(data.commit, n.log));
    }
  }
  return { nodes };
}

module.exports = { init, next };
