"use strict";

function init() {
  return {
    nodes: {
      "1": { role: "follower", term: 0, vote: "0", commit: 0, log: 0 },
      "2": { role: "follower", term: 0, vote: "0", commit: 0, log: 0 },
      "3": { role: "follower", term: 0, vote: "0", commit: 0, log: 0 },
    },
  };
}

function cloneState(state) {
  const nodes = {};
  for (const id of Object.keys(state.nodes)) {
    nodes[id] = Object.assign({}, state.nodes[id]);
  }
  return { nodes };
}

function next(state, action, data) {
  const s = cloneState(state);
  const nodeId = String(data.node);
  const node = s.nodes[nodeId];

  if (action === "ElectionTimeout") {
    // tickElection -> hup -> campaign
    // becomeCandidate: term++, vote for self, role = candidate
    // log stays the same
    const newTerm = node.term + 1;
    node.term = newTerm;
    node.vote = nodeId;
    node.role = "candidate";
    // commit stays the same
    return s;
  }

  if (action === "HandleVoteRequest") {
    // Step() with MsgVote
    const from = String(data.from);
    const msgTerm = data.term;
    const candLogTerm = data.logTerm;
    const candLogIndex = data.index;

    // Handle term comparison first
    if (msgTerm > node.term) {
      // becomeFollower
      node.term = msgTerm;
      node.vote = "0";
      node.role = "follower";
    } else if (msgTerm < node.term) {
      // ignore (reject) - no state change needed for observable state
      // The node sends a rejection but observable state doesn't change
      return s;
    }

    // Now handle the vote request (MsgVote case in Step)
    // canVote: already voted for this candidate, or haven't voted and no leader,
    // or PreVote for future term (not applicable here)
    const canVote =
      node.vote === from ||
      (node.vote === "0"); // lead is not tracked in observable state, treat as None

    // Check if candidate log is up to date
    // isUpToDate: candLogTerm > lastTerm || (candLogTerm == lastTerm && candLogIndex >= lastIndex)
    // We don't have per-entry log terms in observable state, so we approximate:
    // We only know node.log (last log index). We don't know the last log term.
    // For the observable state, we use a simplified check:
    // Since we don't track log terms per entry, we use the node's current term
    // as a proxy for the last log term (this matches what the real implementation
    // would have for a simple cluster).
    // Actually, looking at the observable state carefully:
    // - node.log = last log index
    // - We need to determine if candidate's log is at least as up-to-date
    // In a 3-node cluster trace, the last log term is approximated by the node's term
    // before any term update (since entries are appended at the current term).
    // We use node.term (after potential update above) as the node's last log term
    // only if node.log > 0, otherwise term 0.
    
    // After the term update above, node.term == msgTerm
    // The node's last log term: we don't have it directly.
    // In the traces, nodes start at term 0 with log 0.
    // When a leader appends entries, they're at the leader's term.
    // We'll use a heuristic: if node.log == 0, lastLogTerm = 0,
    // otherwise we don't know exactly. But for the test traces of a simple
    // 3-node cluster, the last log term equals the term in which entries were
    // appended. Since we can't track this without more state, we'll use
    // the node's term before the vote as the last log term when log > 0.
    // 
    // Actually the simplest correct approach for the observable state:
    // We track that after becomeFollower the term is updated.
    // The node's last log term is unknown from observable state alone.
    // For a fresh cluster (all starting at term 0, log 0), the first election:
    // - All nodes have log=0, term=0 initially
    // - Candidate has term=1 (after ElectionTimeout), log=0, logTerm=0
    // - Follower has term=0, log=0 -> after seeing msgTerm=1, becomes follower at term=1
    // - candLogTerm=0 >= follower's lastLogTerm=0, candLogIndex=0 >= follower's log=0 -> up to date
    // So grant vote.
    
    // For the general case, we need to track lastLogTerm. Since we can't,
    // we'll use the following approximation based on what's observable:
    // lastLogTerm = node's term before the message if log > 0, else 0
    // But we already updated node.term above...
    // Let's save the pre-update term for this purpose.
    // We need to restructure slightly.
    
    // Re-approach: save original term before any modification
    // We already modified node.term above. Let's use the saved state.
    // Actually let me restructure the whole function.
    
    // For now, use candLogTerm and candLogIndex vs node's observable state.
    // The node's last log term: approximate as (node.log > 0 ? node.term : 0)
    // but node.term was already updated. We need the pre-update term.
    // Since we cloned state at the top, s.nodes[nodeId] is the modified node.
    // state.nodes[nodeId] is the original.
    const origNode = state.nodes[nodeId];
    const nodeLastLogTerm = origNode.log > 0 ? origNode.term : 0;
    const nodeLastLogIndex = origNode.log;
    
    const candUpToDate =
      candLogTerm > nodeLastLogTerm ||
      (candLogTerm === nodeLastLogTerm && candLogIndex >= nodeLastLogIndex);

    if (canVote && candUpToDate) {
      // Grant vote
      node.vote = from;
      node.role = "follower";
      // electionElapsed reset (not observable)
    }
    // else: reject, no observable state change (node already updated term/role above)
    
    return s;
  }

  if (action === "ClientProposal") {
    // Only leader can append; followers/candidates drop or forward
    if (node.role !== "leader") {
      return s;
    }
    // Leader appends one entry: log++
    node.log = node.log + 1;
    return s;
  }

  if (action === "HandleAppendEntries") {
    // MsgApp received
    const from = String(data.from);
    const msgTerm = data.term;
    const prevLogIndex = data.index;
    const prevLogTerm = data.logTerm;
    const entries = data.entries || 0; // number of entries
    const leaderCommit = data.commit;

    // Term check
    if (msgTerm < node.term) {
      // ignore
      return s;
    }

    if (msgTerm > node.term) {
      node.term = msgTerm;
      node.vote = "0";
    }

    // Become follower (candidate or follower receiving valid AppendEntries)
    node.role = "follower";
    // electionElapsed = 0, lead = from (not observable)

    // Check if log matches at prevLogIndex/prevLogTerm
    // We need to verify the log matches. In observable state we only have
    // node.log (last index). We don't have per-entry terms.
    // 
    // For the observable state approximation:
    // - If prevLogIndex > node.log: log doesn't have that entry -> reject (no state change)
    // - If prevLogIndex == 0: always matches (empty prev)
    // - If prevLogIndex <= node.log: we need to check term at prevLogIndex
    //   We don't have per-entry terms, so we approximate:
    //   If prevLogIndex <= node.log, assume it matches (optimistic)
    //   This works for simple traces where logs are consistent.
    
    // Actually for the test traces, we need to be more careful.
    // The key observable changes are:
    // 1. node.log advances if entries are appended
    // 2. node.commit advances to min(leaderCommit, new last index)
    
    if (prevLogIndex > node.log) {
      // Log doesn't match, reject - no observable state change
      return s;
    }

    // Log matches (or prevLogIndex == 0)
    // Append entries
    const newLastIndex = prevLogIndex + entries;
    if (newLastIndex > node.log) {
      node.log = newLastIndex;
    } else if (entries > 0) {
      // Truncate and rewrite - but in observable state, log index only goes up
      // unless we're overwriting. For simplicity, set to newLastIndex if entries given.
      node.log = newLastIndex;
    }

    // Update commit
    if (leaderCommit > node.commit) {
      node.commit = Math.min(leaderCommit, node.log);
    }

    return s;
  }

  if (action === "HandleHeartbeat") {
    // MsgHeartbeat received
    const from = String(data.from);
    const msgTerm = data.term;
    const leaderCommit = data.commit;

    // Term check
    if (msgTerm < node.term) {
      return s;
    }

    if (msgTerm > node.term) {
      node.term = msgTerm;
      node.vote = "0";
    }

    // Become follower
    node.role = "follower";
    // electionElapsed = 0

    // commitTo
    if (leaderCommit > node.commit) {
      node.commit = leaderCommit;
    }

    return s;
  }

  return s;
}

module.exports = { init, next };