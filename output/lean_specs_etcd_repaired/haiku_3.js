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
  // Only followers and candidates can start elections
  if (nodeState.role === 'leader') {
    return;
  }

  // Increment term and become candidate
  nodeState.term += 1;
  nodeState.vote = nodeId;
  nodeState.role = 'candidate';
}

function handleVoteRequest(nodeState, data) {
  const { from, term, logTerm, index } = data;

  // If request term is higher, update our term and become follower
  if (term > nodeState.term) {
    nodeState.term = term;
    nodeState.vote = '0';
    nodeState.role = 'follower';
  }

  // If request term is lower, reject (don't grant vote)
  if (term < nodeState.term) {
    return;
  }

  // At this point: term === nodeState.term
  // Check if we can vote for this candidate
  const canVote = nodeState.vote === '0' || nodeState.vote === from;

  if (!canVote) {
    return;
  }

  // Check if candidate's log is at least as up-to-date as ours
  const candidateLastTerm = logTerm;
  const ourLastTerm = nodeState.log > 0 ? nodeState.term : 0;

  const isUpToDate = candidateLastTerm > ourLastTerm ||
    (candidateLastTerm === ourLastTerm && index >= nodeState.log);

  if (isUpToDate) {
    nodeState.vote = from;
  }
}

function handleClientProposal(nodeState, nodeId) {
  // Only leaders can accept proposals
  if (nodeState.role !== 'leader') {
    return;
  }

  // Append entry to log
  nodeState.log += 1;
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

  // At this point: term === nodeState.term
  // We have a valid leader message, so we're a follower
  nodeState.role = 'follower';

  // Check if we have the entry at prevIndex with prevTerm
  // If prevIndex is 0, it always matches
  if (index > 0) {
    // We need the entry at index to have term logTerm
    // Simplified: if our log is shorter than index, we can't match
    if (nodeState.log < index) {
      return;
    }
  }

  // Append entries if provided
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

  // At this point: term === nodeState.term
  // We have a valid leader message
  nodeState.role = 'follower';

  // Update commit index
  if (commit > nodeState.commit) {
    nodeState.commit = Math.min(commit, nodeState.log);
  }
}
