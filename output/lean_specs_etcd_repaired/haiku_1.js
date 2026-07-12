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

  // If request term is higher, update our term and clear vote
  if (term > nodeState.term) {
    nodeState.term = term;
    nodeState.vote = '0';
  }

  // If request term is lower, reject (don't change state)
  if (term < nodeState.term) {
    return;
  }

  // term == nodeState.term at this point
  // We can vote if:
  // 1. We haven't voted yet in this term, OR
  // 2. We already voted for this candidate
  const canVote = nodeState.vote === '0' || nodeState.vote === from;

  // Check if candidate's log is at least as up-to-date as ours
  // Compare by term first, then by index
  const candidateLogUpToDate = logTerm > nodeState.log || 
                               (logTerm === nodeState.log && index >= nodeState.log) ||
                               (nodeState.log === 0);

  if (canVote && candidateLogUpToDate) {
    nodeState.vote = from;
    // Receiving a vote request resets election timeout (step down if leader)
    if (nodeState.role === 'leader') {
      nodeState.role = 'follower';
    }
  }
}

function handleClientProposal(nodeState, nodeId) {
  // Only leaders can accept proposals
  if (nodeState.role === 'leader') {
    nodeState.log += 1;
  }
  // Followers and candidates drop proposals
}

function handleAppendEntries(nodeState, data) {
  const { from, term, logTerm, index, entries, commit } = data;

  // If request term is higher, become follower
  if (term > nodeState.term) {
    nodeState.term = term;
    nodeState.vote = '0';
    nodeState.role = 'follower';
  }

  // If request term is lower, reject
  if (term < nodeState.term) {
    return;
  }

  // term == nodeState.term
  // Become follower if we're not already
  if (nodeState.role !== 'follower') {
    nodeState.role = 'follower';
  }

  // Check if we have the entry at (index, logTerm)
  // For this simplified model, we assume log matching works if:
  // - index is 0 (no previous entry needed), OR
  // - index <= our log (we have entries up to that point)
  const logMatches = index === 0 || index <= nodeState.log;

  if (!logMatches) {
    // Reject the append
    return;
  }

  // Accept the append
  if (entries > 0) {
    nodeState.log += entries;
  }

  // Update commit index
  if (commit > nodeState.commit) {
    nodeState.commit = Math.min(commit, nodeState.log);
  }
}

function handleHeartbeat(nodeState, data) {
  const { from, term, commit } = data;

  // If request term is higher, become follower
  if (term > nodeState.term) {
    nodeState.term = term;
    nodeState.vote = '0';
    nodeState.role = 'follower';
  }

  // If request term is lower, ignore
  if (term < nodeState.term) {
    return;
  }

  // term == nodeState.term
  // Become follower if we're not already
  if (nodeState.role !== 'follower') {
    nodeState.role = 'follower';
  }

  // Update commit index
  if (commit > nodeState.commit) {
    nodeState.commit = Math.min(commit, nodeState.log);
  }
}
