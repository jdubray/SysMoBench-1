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
    const newTerm = node.term + 1;
    node.term = newTerm;
    node.vote = nodeId;
    node.role = 'candidate';
    return s;
  }

  if (action === 'HandleVoteRequest') {
    const from = String(data.from);
    const msgTerm = data.term;
    const msgLogTerm = data.logTerm;
    const msgIndex = data.index;

    // Save the node's last log term BEFORE any term update
    // We approximate the node's last log entry term as its current term
    // (entries in the log were appended at or before the current term)
    const ourLastLogTerm = node.term;

    if (msgTerm > node.term) {
      node.term = msgTerm;
      node.vote = '0';
      node.role = 'follower';
    } else if (msgTerm < node.term) {
      return s;
    }

    // canVote: haven't voted yet, or already voted for this candidate
    const canVote = (node.vote === '0') || (node.vote === from);

    // isUpToDate: compare candidate's (msgLogTerm, msgIndex) vs our (ourLastLogTerm, node.log)
    // using the pre-update ourLastLogTerm
    const candUpToDate = (msgLogTerm > ourLastLogTerm) ||
                         (msgLogTerm === ourLastLogTerm && msgIndex >= node.log);

    if (canVote && candUpToDate) {
      node.vote = from;
      node.role = 'follower';
    }

    return s;
  }

  if (action === 'ClientProposal') {
    if (node.role !== 'leader') {
      return s;
    }
    node.log = node.log + 1;
    return s;
  }

  if (action === 'HandleAppendEntries') {
    const from = String(data.from);
    const msgTerm = data.term;
    const msgLogTerm = data.logTerm;
    const msgIndex = data.index;
    const entries = data.entries || 0;
    const msgCommit = data.commit;

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

    if (msgIndex > node.log) {
      return s;
    }

    const newLastIndex = msgIndex + entries;
    if (newLastIndex > node.log || entries > 0) {
      node.log = newLastIndex;
    }

    if (msgCommit > node.commit) {
      node.commit = Math.min(msgCommit, node.log);
    }

    return s;
  }

  if (action === 'HandleHeartbeat') {
    const from = String(data.from);
    const msgTerm = data.term;
    const msgCommit = data.commit;

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

    if (msgCommit > node.commit) {
      node.commit = Math.min(msgCommit, node.log);
    }

    return s;
  }

  return s;
}

module.exports = { init, next };
