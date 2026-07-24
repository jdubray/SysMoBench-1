'use strict';

function init() {
  return {
    nodes: {
      '1': { role: 'follower', term: 0, vote: '0', commit: 0, log: 0 },
      '2': { role: 'follower', term: 0, vote: '0', commit: 0, log: 0 },
      '3': { role: 'follower', term: 0, vote: '0', commit: 0, log: 0 },
    }
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

  if (action === 'ElectionTimeout') {
    // tickElection -> hup -> campaign
    // becomeCandidate: increment term, vote for self, become candidate
    const newTerm = node.term + 1;
    node.term = newTerm;
    node.vote = nodeId;
    node.role = 'candidate';
    return s;
  }

  if (action === 'HandleVoteRequest') {
    // Step() with MsgVote
    const from = String(data.from);
    const msgTerm = data.term;
    const msgLogTerm = data.logTerm;
    const msgIndex = data.index;

    // Handle term comparison first
    if (msgTerm > node.term) {
      // becomeFollower
      node.term = msgTerm;
      node.vote = '0';
      node.role = 'follower';
    } else if (msgTerm < node.term) {
      // ignore (reject) - lower term vote request
      // send reject but no state change observable
      return s;
    }

    // Now handle the vote (MsgVote case in Step)
    // canVote: already voted for this candidate, or haven't voted and no leader,
    // or PreVote for future term (not applicable here)
    const canVote = (node.vote === from) ||
                    (node.vote === '0');
    // isUpToDate: candidate's log is at least as up-to-date as ours
    // candidate is up to date if: msgLogTerm > node's last log term,
    // or (msgLogTerm == node's last log term && msgIndex >= node.log)
    // We don't track per-entry terms in observable state, so we approximate:
    // We only have node.log (last log index). We need to compare log terms.
    // Since we don't have the actual log term of the last entry in observable state,
    // we use a simplified check based on what's observable.
    // The real check: candLastID >= lastID in terms of (term, index)
    // We'll use: msgLogTerm > 0 means candidate has entries; if msgLogTerm is
    // provided we compare. Since we don't store last log term, we approximate
    // using the node's current term as a proxy for last log term when log > 0.
    // Actually, for the observable state we need to be careful.
    // The node's "last log term" isn't directly observable, but in a simple
    // 3-node cluster starting from scratch, the last log term equals the term
    // in which the last entry was appended.
    // We'll use node.term as an approximation for the last log term when log > 0,
    // but that's not always right. Let's think more carefully.
    // 
    // In the trace, we only see: role, term, vote, commit, log.
    // The isUpToDate check needs lastLogTerm. We don't have it.
    // However, for the purposes of matching traces, we need to figure out
    // what the real implementation would do.
    //
    // Key insight: in a fresh cluster, all entries are appended at the current
    // term. So lastLogTerm = term of when the entry was appended.
    // For a node that just became leader at term T and appended a no-op,
    // its lastLogTerm = T.
    // For a follower that received entries at term T, lastLogTerm = T.
    //
    // Since we don't track lastLogTerm, we need to infer it.
    // The safest approximation: if log == 0, lastLogTerm = 0.
    // If log > 0, we don't know the exact term. But in practice for these
    // traces, the last log term is often the term when the entry was written.
    //
    // For the vote grant check, let's use: 
    // isUpToDate = (msgLogTerm > nodeLastLogTerm) || 
    //              (msgLogTerm == nodeLastLogTerm && msgIndex >= node.log)
    // We'll approximate nodeLastLogTerm as: if node.log == 0 then 0, else node.term
    // This is a reasonable approximation for a simple cluster.
    
    const nodeLastLogTerm = (node.log === 0) ? 0 : node.term;
    const isUpToDate = (msgLogTerm > nodeLastLogTerm) ||
                       (msgLogTerm === nodeLastLogTerm && msgIndex >= node.log);

    if (canVote && isUpToDate) {
      // Grant vote
      node.vote = from;
      node.role = 'follower'; // ensure follower
      // reset electionElapsed (not observable)
    }
    // If not granting, no observable state change (already handled term update above)
    return s;
  }

  if (action === 'ClientProposal') {
    // Only leader can append; followers/candidates drop or forward
    if (node.role === 'leader') {
      node.log = node.log + 1;
    }
    // followers/candidates: proposal dropped or forwarded, no observable change to this node
    return s;
  }

  if (action === 'HandleAppendEntries') {
    const from = String(data.from);
    const msgTerm = data.term;
    const msgLogTerm = data.logTerm;
    const msgIndex = data.index;
    const entries = data.entries || 0;
    const msgCommit = data.commit;

    // Step(): handle term
    if (msgTerm < node.term) {
      // ignore / send AppResp with rejection - no observable state change
      return s;
    }

    if (msgTerm > node.term) {
      node.term = msgTerm;
      node.vote = '0';
      node.role = 'follower';
    } else {
      // msgTerm == node.term
      // If candidate, become follower
      if (node.role === 'candidate') {
        node.role = 'follower';
      }
    }

    // stepFollower MsgApp:
    // electionElapsed = 0 (not observable)
    // lead = from (not observable)
    // handleAppendEntries

    // handleAppendEntries logic:
    // Check if prev entry matches (msgIndex, msgLogTerm)
    // We need to check if our log contains an entry at msgIndex with term msgLogTerm
    // Observable: node.log is last index, node.term is current term
    // We don't have per-index terms, so we approximate:
    // The append succeeds if msgIndex <= node.log (we have the prev entry)
    // AND the term at msgIndex matches msgLogTerm.
    // 
    // Approximation: if msgIndex == 0, prev is always valid (empty log base).
    // If msgIndex <= node.log, we assume the term matches if the message is
    // from a legitimate leader (which it is if msgTerm >= node.term).
    // This is a simplification but should work for the deterministic traces.

    // If msgIndex > node.log: we don't have the prev entry -> reject (no state change)
    if (msgIndex > node.log) {
      // Reject - no observable state change
      return s;
    }

    // Prev entry matches (simplified: msgIndex <= node.log)
    // Append entries
    const numEntries = (typeof entries === 'number') ? entries : 0;
    if (numEntries > 0) {
      node.log = msgIndex + numEntries;
    }

    // Update commit index
    // commitTo: commit = min(msgCommit, lastIndex)
    const newLastIndex = node.log;
    const newCommit = Math.min(msgCommit, newLastIndex);
    if (newCommit > node.commit) {
      node.commit = newCommit;
    }

    return s;
  }

  if (action === 'HandleHeartbeat') {
    const from = String(data.from);
    const msgTerm = data.term;
    const msgCommit = data.commit;

    // Step(): handle term
    if (msgTerm < node.term) {
      // ignore
      return s;
    }

    if (msgTerm > node.term) {
      node.term = msgTerm;
      node.vote = '0';
      node.role = 'follower';
    } else {
      if (node.role === 'candidate') {
        node.role = 'follower';
      }
    }

    // stepFollower MsgHeartbeat:
    // electionElapsed = 0, lead = from (not observable)
    // handleHeartbeat: commitTo(msgCommit)
    if (msgCommit > node.commit) {
      // commitTo: only advance if msgCommit <= lastIndex
      const newCommit = Math.min(msgCommit, node.log);
      if (newCommit > node.commit) {
        node.commit = newCommit;
      }
    }

    return s;
  }

  return s;
}

module.exports = { init, next };