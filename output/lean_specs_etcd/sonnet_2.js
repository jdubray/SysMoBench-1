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
    const msgTerm = data.term;
    const fromId = String(data.from);
    const msgLogTerm = data.logTerm;
    const msgIndex = data.index;

    // Step function: handle term comparison first
    if (msgTerm > node.term) {
      // Higher term: step down to follower
      // For MsgVote with higher term, we become follower first
      // (unless inLease check applies, but we don't track electionElapsed here)
      node.term = msgTerm;
      node.vote = '0';
      node.role = 'follower';
    } else if (msgTerm < node.term) {
      // Lower term: reject, no state change
      return s;
    }

    // Now decide whether to grant vote
    // canVote: already voted for this candidate, or haven't voted and no leader,
    // or PreVote for future term (not applicable here since this is HandleVoteRequest = MsgVote)
    const canVote = (node.vote === fromId) ||
                    (node.vote === '0');

    // Check if candidate log is up-to-date
    // isUpToDate: candLastTerm > lastTerm, or (candLastTerm == lastTerm && candLastIndex >= lastIndex)
    // We use node.log as lastIndex; we don't have per-entry terms in observable state.
    // We approximate: use msgLogTerm vs node's implicit last log term.
    // Since we only have node.log (last index) and node.term, we need to approximate.
    // The real check uses raftLog.lastEntryID() which has both index and term.
    // We'll use: candLogTerm > node's last log term OR (equal terms and candIndex >= node.log)
    // We don't store last log term explicitly, so we approximate it as node.term for committed
    // entries, but that's not quite right either.
    // 
    // In the observable state we only have node.log (last log index) and node.term.
    // For a fresh cluster, last log term would be 0 if log=0, or the term of the last entry.
    // We'll track this as best we can: if log=0, lastLogTerm=0; otherwise we can't know exactly.
    // However, in practice for a 3-node cluster starting fresh, the log terms follow the node term.
    // 
    // Best approximation: treat node's last log term as 0 if log==0, else use node.term
    // (since entries are only appended by leaders in their term).
    // Actually for the initial election from term 0, log=0, lastLogTerm=0.
    // After a leader appends, log>0 and those entries have the leader's term.
    // We'll use: lastLogTerm = (node.log === 0) ? 0 : node.term
    // This is imperfect but matches the common case.
    
    const myLastLogTerm = (node.log === 0) ? 0 : node.term;
    const myLastIndex = node.log;
    
    const upToDate = (msgLogTerm > myLastLogTerm) ||
                     (msgLogTerm === myLastLogTerm && msgIndex >= myLastIndex);

    if (canVote && upToDate) {
      // Grant vote
      node.vote = fromId;
      node.role = 'follower';
      // electionElapsed = 0 (not tracked in observable state)
    }
    // else: reject, no state change beyond the term update already done

    return s;
  }

  if (action === 'ClientProposal') {
    // Only leader can append; followers/candidates drop or forward
    if (node.role === 'leader') {
      node.log = node.log + 1;
    }
    // followers and candidates: proposal dropped or forwarded, no observable state change
    return s;
  }

  if (action === 'HandleAppendEntries') {
    const msgTerm = data.term;
    const fromId = String(data.from);
    const msgLogTerm = data.logTerm;   // prevLogTerm
    const msgIndex = data.index;       // prevLogIndex
    const entries = data.entries || 0; // number of entries (0 means heartbeat/commit update)
    const msgCommit = data.commit;

    // Term handling
    if (msgTerm < node.term) {
      // Ignore lower term messages
      return s;
    }

    if (msgTerm > node.term) {
      node.term = msgTerm;
      node.vote = '0';
      node.role = 'follower';
    } else {
      // Same term
      if (node.role === 'candidate') {
        // Candidate sees AppendEntries from valid leader in same term -> become follower
        node.role = 'follower';
      }
    }

    // Reset election elapsed (not tracked), set lead (not tracked in observable state)
    // stepFollower: electionElapsed=0, lead=from

    // handleAppendEntries logic:
    // Check if prevLog matches. We approximate log matching.
    // If msgIndex > node.log, we can't match (we don't have that entry)
    // If msgIndex <= node.log, we need to check term at msgIndex matches msgLogTerm
    // Since we don't store per-entry terms, we approximate:
    // - If msgIndex == 0, it always matches (empty prev)
    // - If msgIndex <= node.log and msgLogTerm matches what we'd expect, accept
    // 
    // For the observable state, we approximate: accept if msgIndex <= node.log
    // (we assume log is consistent since we don't track divergence in this model)
    // and msgIndex >= node.commit (early return check: if prev.index < committed, send committed)

    // Early return: if prevIndex < committed, the follower responds with committed index
    // but state doesn't change (commit stays same, log stays same)
    if (msgIndex < node.commit) {
      // No state change to observable fields
      return s;
    }

    // Check log match: prevIndex must be <= our log length
    if (msgIndex > node.log) {
      // We don't have the prev entry -> reject, no state change
      return s;
    }

    // Log matches (approximation): accept the entries
    const numEntries = (typeof entries === 'number') ? entries : 0;
    const newLastIndex = msgIndex + numEntries;
    
    if (newLastIndex > node.log) {
      node.log = newLastIndex;
    }
    // Possibly truncate conflicting entries: if newLastIndex < node.log, truncate
    // In the real impl, maybeAppend truncates conflicting entries
    if (newLastIndex < node.log && numEntries >= 0) {
      // If we appended entries that conflict, truncate to newLastIndex
      // Only truncate if we actually processed entries (not just a commit update with 0 entries)
      // Actually in real raft, if entries conflict they get overwritten
      // For 0 entries (pure commit update), don't truncate
      if (numEntries > 0) {
        node.log = newLastIndex;
      }
    }

    // Update commit index
    if (msgCommit > node.commit) {
      node.commit = Math.min(msgCommit, node.log);
    }

    return s;
  }

  if (action === 'HandleHeartbeat') {
    const msgTerm = data.term;
    const fromId = String(data.from);
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
    // electionElapsed=0, lead=from (not in observable state)
    if (msgCommit > node.commit) {
      node.commit = Math.min(msgCommit, node.log);
    }

    return s;
  }

  return s;
}

module.exports = { init, next };