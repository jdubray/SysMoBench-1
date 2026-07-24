module.exports = { init, next };

function init() {
  return {
    nodes: {
      '1': { role: 'follower', term: 0, vote: '0', commit: 0, log: 0 },
      '2': { role: 'follower', term: 0, vote: '0', commit: 0, log: 0 },
      '3': { role: 'follower', term: 0, vote: '0', commit: 0, log: 0 }
    }
  };
}

function next(state, action, data) {
  const newState = JSON.parse(JSON.stringify(state));
  const node = data.node;
  const nodeState = newState.nodes[node];

  switch (action) {
    case 'ElectionTimeout':
      handleElectionTimeout(nodeState, node);
      break;

    case 'HandleVoteRequest':
      handleVoteRequest(nodeState, data);
      break;

    case 'ClientProposal':
      handleClientProposal(nodeState, node);
      break;

    case 'HandleAppendEntries':
      handleAppendEntries(nodeState, data);
      break;

    case 'HandleHeartbeat':
      handleHeartbeat(nodeState, data);
      break;
  }

  return newState;
}

function handleElectionTimeout(nodeState, nodeId) {
  // A follower or candidate times out and starts an election
  if (nodeState.role === 'follower' || nodeState.role === 'candidate') {
    nodeState.term += 1;
    nodeState.vote = nodeId;
    nodeState.role = 'candidate';
  }
}

function handleVoteRequest(nodeState, data) {
  const { from, term, logTerm, index } = data;

  // If request term is lower than current term, reject
  if (term < nodeState.term) {
    return;
  }

  // If request term is higher, update term and become follower
  if (term > nodeState.term) {
    nodeState.term = term;
    nodeState.vote = '0';
    nodeState.role = 'follower';
  }

  // Determine if we can vote for this candidate
  const candLastLogTerm = logTerm;
  const candLastLogIndex = index;
  const ourLastLogTerm = nodeState.term; // Simplified: assume last entry has current term
  const ourLastLogIndex = nodeState.log;

  // Can vote if:
  // 1. We haven't voted in this term, OR we already voted for this candidate
  // 2. Candidate's log is at least as up-to-date as ours
  const canVote = (nodeState.vote === '0' || nodeState.vote === from) &&
                  isLogUpToDate(candLastLogTerm, candLastLogIndex, ourLastLogTerm, ourLastLogIndex);

  if (canVote) {
    nodeState.vote = from;
    nodeState.role = 'follower';
  }
}

function isLogUpToDate(candTerm, candIndex, ourTerm, ourIndex) {
  if (candTerm !== ourTerm) {
    return candTerm > ourTerm;
  }
  return candIndex >= ourIndex;
}

function handleClientProposal(nodeState, nodeId) {
  // Only leaders can accept proposals
  if (nodeState.role === 'leader') {
    nodeState.log += 1;
  }
}

function handleAppendEntries(nodeState, data) {
  const { from, term, logTerm, index, entries, commit } = data;

  // If request term is lower than current term, reject
  if (term < nodeState.term) {
    return;
  }

  // If request term is higher, update term and become follower
  if (term > nodeState.term) {
    nodeState.term = term;
    nodeState.vote = '0';
    nodeState.role = 'follower';
  } else if (term === nodeState.term && nodeState.role === 'candidate') {
    // If we're a candidate and receive an append from current term, become follower
    nodeState.role = 'follower';
  }

  // Check log matching property: our log must match at prevLogIndex
  // If prevLogIndex > 0, we need log entry at prevLogIndex with term prevLogTerm
  // Simplified: if index > 0 and logTerm doesn't match our understanding, reject
  const logMatches = (index === 0) || (index <= nodeState.log);
  
  if (!logMatches) {
    return;
  }

  // Handle log entries - only append if log matches
  if (entries > 0) {
    // Only append if we have the matching previous entry
    if (index === 0 || index <= nodeState.log) {
      nodeState.log = index + entries;
    }
  }

  // Update commit index to min(leader's commit, our last log index)
  const newCommit = Math.min(commit, nodeState.log);
  if (newCommit > nodeState.commit) {
    nodeState.commit = newCommit;
  }
}

function handleHeartbeat(nodeState, data) {
  const { from, term, commit } = data;

  // If request term is lower than current term, ignore
  if (term < nodeState.term) {
    return;
  }

  // If request term is higher, update term and become follower
  if (term > nodeState.term) {
    nodeState.term = term;
    nodeState.vote = '0';
    nodeState.role = 'follower';
  } else if (term === nodeState.term && nodeState.role === 'candidate') {
    // If we're a candidate and receive a heartbeat from current term, become follower
    nodeState.role = 'follower';
  }

  // Update commit index to min(leader's commit, our last log index)
  const newCommit = Math.min(commit, nodeState.log);
  if (newCommit > nodeState.commit) {
    nodeState.commit = newCommit;
  }
}
