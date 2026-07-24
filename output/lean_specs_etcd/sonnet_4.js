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

    // Now handle the vote request (MsgVote case in Step)
    // canVote: already voted for this candidate, or haven't voted and no leader,
    // or PreVote for future term (not applicable here)
    const canVote = (node.vote === from) ||
                    (node.vote === '0');
    // isUpToDate: candidate's log is at least as up-to-date as ours
    const isUpToDate = (msgLogTerm > node.term) ||
                       (msgLogTerm === node.term && msgIndex >= node.log) ||
                       // more general: compare (logTerm, index) lexicographically
                       (msgLogTerm > getLastLogTerm(node)) ||
                       (msgLogTerm === getLastLogTerm(node) && msgIndex >= node.log);

    // We need to check isUpToDate properly:
    // The candidate's last entry is (msgLogTerm, msgIndex)
    // Our last entry is (lastTerm, lastIndex) but we only track log index, not term
    // In the observable state we only have log index, not per-entry terms
    // We'll use a simplified check: candidate is up to date if
    // msgLogTerm > our "last log term" OR (equal terms and msgIndex >= our log)
    // Since we don't track per-entry terms, we approximate:
    // treat our last log term as node.term for entries we have
    // Actually in the real impl, isUpToDate compares (candLastTerm, candLastIndex) vs (ourLastTerm, ourLastIndex)
    // We don't have ourLastTerm in observable state, so we use node.term as approximation
    // But actually the node's term may differ from its last log entry term
    // The best we can do with observable state: use node.term as last log term proxy

    const ourLastLogTerm = node.term; // approximation
    const candUpToDate = (msgLogTerm > ourLastLogTerm) ||
                         (msgLogTerm === ourLastLogTerm && msgIndex >= node.log);

    if (canVote && candUpToDate) {
      // Grant vote
      node.vote = from;
      node.role = 'follower';
      // electionElapsed reset (not observable)
    }
    // else: reject, no state change

    return s;
  }

  if (action === 'ClientProposal') {
    // Only leader can accept proposals
    if (node.role !== 'leader') {
      return s;
    }
    // appendEntry: increment log index
    node.log = node.log + 1;
    return s;
  }

  if (action === 'HandleAppendEntries') {
    // Step() with MsgApp
    const from = String(data.from);
    const msgTerm = data.term;
    const msgLogTerm = data.logTerm;
    const msgIndex = data.index;
    const entries = data.entries || 0;
    const msgCommit = data.commit;

    // Term handling
    if (msgTerm < node.term) {
      // ignore / send AppResp with rejection - no state change
      return s;
    }

    if (msgTerm > node.term) {
      node.term = msgTerm;
      node.vote = '0';
      node.role = 'follower';
    } else {
      // msgTerm === node.term
      // candidate receiving AppEntries from leader -> become follower
      if (node.role === 'candidate') {
        node.role = 'follower';
      }
    }

    // stepFollower handleAppendEntries
    // electionElapsed = 0 (not observable)
    // lead = from (not observable)

    // Check if we can append:
    // prev entry must match: index=msgIndex, term=msgLogTerm
    // We only track last log index, not per-entry terms
    // Simplified: if msgIndex <= node.log, we can check consistency
    // If msgIndex > node.log, we can't append (missing entries)

    // Log consistency check:
    // If msgIndex > node.log: we don't have the prev entry -> reject (no state change to log)
    // If msgIndex <= node.log: we assume terms match (simplified)
    // This is a simplification since we don't track per-entry terms

    if (msgIndex > node.log) {
      // Can't append, missing previous entries
      return s;
    }

    // We can append (prev entry exists or index is 0)
    // New log index after append
    const newLastIndex = msgIndex + entries;
    if (newLastIndex > node.log) {
      node.log = newLastIndex;
    } else if (entries > 0) {
      // Truncate conflicting entries and append
      node.log = newLastIndex;
    }

    // Update commit index
    if (msgCommit > node.commit) {
      node.commit = Math.min(msgCommit, node.log);
    }

    return s;
  }

  if (action === 'HandleHeartbeat') {
    // Step() with MsgHeartbeat
    const from = String(data.from);
    const msgTerm = data.term;
    const msgCommit = data.commit;

    // Term handling
    if (msgTerm < node.term) {
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

    // handleHeartbeat: commitTo(msgCommit)
    if (msgCommit > node.commit) {
      node.commit = Math.min(msgCommit, node.log);
    }

    return s;
  }

  return s;
}

function getLastLogTerm(node) {
  // We don't have per-entry log terms in observable state
  // Use node.term as approximation of last log entry term
  return node.term;
}

module.exports = { init, next };