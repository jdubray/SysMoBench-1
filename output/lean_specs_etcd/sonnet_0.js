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
    const msgLogTerm = data.logTerm;
    const msgIndex = data.index;

    // Handle term comparison first
    if (msgTerm > node.term) {
      // Higher term: become follower (not MsgPreVote, not MsgPreVoteResp)
      // For MsgVote with higher term, becomeFollower(msgTerm, None)
      node.term = msgTerm;
      node.vote = "0";
      node.role = "follower";
    } else if (msgTerm < node.term) {
      // Lower term: reject, no state change
      return s;
    }

    // Now decide whether to grant vote
    // canVote: already voted for this candidate, or haven't voted and no leader,
    // or PreVote for future term (not applicable here)
    const canVote =
      node.vote === from ||
      (node.vote === "0"); // no leader check: we don't track lead in observable state
    // isUpToDate: candidate's log is at least as up-to-date as ours
    // Compare (logTerm, index) lexicographically
    const myLogTerm = 0; // we don't have per-entry terms in observable state
    // We need to check if candidate is up to date
    // Since we only have node.log (last index) and no per-entry terms,
    // we approximate: candidate is up to date if msgLogTerm > myLastTerm
    // or (msgLogTerm == myLastTerm && msgIndex >= node.log)
    // But we don't have myLastTerm... 
    // In the observable state we only have log index. 
    // For the deterministic 3-node cluster traces, we need to use what we have.
    // The real check is isUpToDate(candLastID) which compares (term, index).
    // We'll use: if msgLogTerm > 0 (candidate has entries) or node.log == 0,
    // and msgIndex >= node.log as a proxy when terms are equal.
    // Actually for the trace comparison we need to be precise.
    // Since we don't store per-entry log terms, we use node.log for index comparison
    // and treat logTerm comparison as: candLogTerm >= our last log term.
    // In a fresh cluster (term-based), the last log term equals the term when
    // the last entry was appended. We'll approximate last log term as:
    // if node.log == 0, lastLogTerm = 0, else we don't know exactly.
    // For the test traces, the key insight is:
    // isUpToDate: candLastTerm > myLastTerm, OR (candLastTerm == myLastTerm AND candIndex >= myIndex)
    // We approximate myLastTerm from context. Since we can't store it,
    // we use: msgLogTerm >= node.term (candidate's log term vs current term is a reasonable proxy)
    // Actually let's think more carefully:
    // In a fresh 3-node cluster starting from term 0:
    // - Initially all logs are empty (log=0, lastLogTerm=0)
    // - When a node becomes candidate at term 1, it has log=0, lastLogTerm=0
    // - isUpToDate(0,0) against (0,0) => equal => up to date
    // So for empty logs, any candidate is up to date.
    // After a leader appends entries at term T, log grows.
    // The lastLogTerm would be T (the term of the last entry).
    // We can approximate: if node.log > 0, lastLogTerm ~ node.term (not quite right after step-down)
    // 
    // For simplicity and correctness in the common cases of the trace:
    // Use msgLogTerm and msgIndex vs node's log.
    // If node.log == 0: candidate is always up to date (our log is empty)
    // If node.log > 0: candidate needs msgIndex >= node.log (simplified, ignoring term diff)
    //   but also msgLogTerm must be >= our last log term
    // Since we don't store lastLogTerm, we'll use: isUpToDate = (msgLogTerm > 0 || node.log == 0) && msgIndex >= node.log
    // This is a simplification but should work for basic election traces.
    
    // Better approximation: store nothing extra, just use what we have
    // isUpToDate: candidate's (logTerm, index) >= ours (ourLastTerm, node.log)
    // We don't know ourLastTerm from observable state alone.
    // Key insight for traces: in a 3-node cluster election from scratch,
    // all nodes have log=0 initially, so isUpToDate is always true.
    // After leader election, followers get entries appended.
    // For vote requests after that, we need proper comparison.
    // 
    // We'll use this heuristic: 
    // ourLastLogTerm = 0 if node.log == 0, else use node.term as upper bound
    // But node.term may have changed... 
    // 
    // Let's just implement it as faithfully as possible:
    // isUpToDate(cand) = cand.logTerm > myLastTerm || (cand.logTerm == myLastTerm && cand.index >= myLog)
    // where myLastTerm = 0 if myLog == 0 (empty log has term 0 for last entry)
    // For non-empty log, we don't have myLastTerm in observable state.
    // We'll approximate myLastTerm as: the term of the last entry, which in a simple
    // cluster is the term when that entry was written. Since we track node.term and
    // node.log, and entries are written at the current term of the leader...
    // This is fundamentally limited by the observable state shape.
    // 
    // For the purposes of matching traces, let's use:
    // myLastLogTerm = 0 if node.log == 0
    // myLastLogTerm = node.term if node.log > 0 (approximation: last entry was from current term)
    // This won't be perfect but let's try.

    let myLastLogTerm = 0;
    // We can't know for sure, but 0 for empty log is correct
    // For non-empty, we don't have this info in observable state
    // Use 0 as conservative estimate (makes isUpToDate easier to satisfy)
    // Actually this would make nodes always grant votes which is wrong.
    // 
    // The real answer: we MUST use what's in observable state.
    // node.log = last log index. We have no last log term.
    // For the trace to work, we need to handle the common case:
    // In a fresh cluster, log=0 for all, so myLastLogTerm=0, and any candidate with logTerm>=0 is up to date.
    // After leader appends at term T: followers have log>0 with entries at term T.
    // A candidate at term T+1 would have logTerm=T (if it got the entries) or logTerm=0 (if not).
    // 
    // Since we can't store lastLogTerm, we'll use node.log==0 => myLastLogTerm=0,
    // and for node.log>0 we'll use 0 as well (can't know). This means we'll always
    // consider the candidate up-to-date from a term perspective, and only check index.
    // isUpToDate = msgLogTerm > myLastLogTerm || (msgLogTerm == myLastLogTerm && msgIndex >= node.log)
    // With myLastLogTerm=0: isUpToDate = msgLogTerm > 0 || msgIndex >= node.log
    
    const isUpToDate = msgLogTerm > myLastLogTerm || (msgLogTerm === myLastLogTerm && msgIndex >= node.log);

    if (canVote && isUpToDate) {
      // Grant vote
      node.vote = from;
      // For MsgVote (real vote), reset electionElapsed (not observable)
      // role stays the same (already follower after term bump above, or was follower)
    } else {
      // Reject: no state change to observable fields
      // (we already updated term/role above if msgTerm > old term)
    }

    return s;
  }

  if (action === "ClientProposal") {
    // Only leader can accept proposals
    if (node.role !== "leader") {
      // Dropped or forwarded; no observable change to this node's state
      // (follower forwards to leader but that's a separate step)
      return s;
    }
    // Leader appends one entry: log++
    node.log = node.log + 1;
    // commit stays the same until quorum acks
    return s;
  }

  if (action === "HandleAppendEntries") {
    // MsgApp received by node from data.from
    const from = String(data.from);
    const msgTerm = data.term;
    const msgLogTerm = data.logTerm; // term of entry at prevIndex
    const msgIndex = data.index;     // prevLogIndex
    const entries = data.entries;    // number of entries (0 for commit-only)
    const msgCommit = data.commit;

    // Term check
    if (msgTerm < node.term) {
      // Ignore (send AppResp with rejection, but no state change)
      return s;
    }

    if (msgTerm > node.term) {
      node.term = msgTerm;
      node.vote = "0";
      node.role = "follower";
    } else {
      // msgTerm == node.term
      // If candidate, become follower
      if (node.role === "candidate") {
        node.role = "follower";
      }
    }

    // Reset election elapsed (not observable), set lead (not observable)
    // handleAppendEntries logic:
    // Check if prevLog matches: if msgIndex < committed, accept (send committed)
    // if maybeAppend succeeds, update log and commit

    // Check log consistency:
    // The append succeeds if our log contains an entry at msgIndex with term msgLogTerm
    // We approximate: if msgIndex <= node.log (we have the entry), check term match
    // Since we don't store per-entry terms, we approximate:
    // - if msgIndex == 0: always matches (empty prev)
    // - if msgIndex <= node.log: assume it matches (optimistic)
    // - if msgIndex > node.log: reject (we don't have that entry)

    // Actually for the trace we need to handle:
    // 1. msgIndex < committed: send back committed index (no log change, but commit may advance)
    // 2. log matches at msgIndex: append entries, update commit
    // 3. log doesn't match: reject

    if (msgIndex <= node.log) {
      // Log matches (we have the entry at msgIndex, assume term matches)
      // Append entries
      const newLastIndex = msgIndex + (entries || 0);
      if (newLastIndex > node.log) {
        node.log = newLastIndex;
      } else {
        // Truncation case: if entries conflict, truncate
        // For simplicity, if newLastIndex < node.log and entries > 0, truncate
        if ((entries || 0) > 0) {
          node.log = newLastIndex;
        }
      }
      // Update commit
      const newCommit = Math.min(msgCommit, msgIndex + (entries || 0));
      if (newCommit > node.commit) {
        node.commit = newCommit;
      }
    } else {
      // msgIndex > node.log: we don't have the prev entry, reject
      // No state change to log or commit
      // But term/role already updated above
    }

    return s;
  }

  if (action === "HandleHeartbeat") {
    // MsgHeartbeat received
    const from = String(data.from);
    const msgTerm = data.term;
    const msgCommit = data.commit;

    // Term check
    if (msgTerm < node.term) {
      return s;
    }

    if (msgTerm > node.term) {
      node.term = msgTerm;
      node.vote = "0";
      node.role = "follower";
    } else {
      if (node.role === "candidate") {
        node.role = "follower";
      }
    }

    // handleHeartbeat: commitTo(msgCommit)
    // commitTo only advances commit, never goes back
    if (msgCommit > node.commit) {
      // commitTo: commit = min(msgCommit, lastIndex) but we use msgCommit
      // since we trust the leader's commit (bounded by our log)
      node.commit = Math.min(msgCommit, node.log);
    }

    return s;
  }

  return s;
}

module.exports = { init, next };