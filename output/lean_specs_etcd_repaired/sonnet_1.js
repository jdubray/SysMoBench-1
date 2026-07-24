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

    // Capture last log term BEFORE any term update
    // Approximation: if log == 0, lastLogTerm = 0; else use current term as proxy
    const nodeLastLogTerm = (node.log === 0) ? 0 : node.term;

    if (msgTerm > node.term) {
      node.term = msgTerm;
      node.vote = '0';
      node.role = 'follower';
    } else if (msgTerm < node.term) {
      return s;
    }

    const canVote = (node.vote === from) || (node.vote === '0');

    const isUpToDate = (msgLogTerm > nodeLastLogTerm) ||
                       (msgLogTerm === nodeLastLogTerm && msgIndex >= node.log);

    if (canVote && isUpToDate) {
      node.vote = from;
      node.role = 'follower';
    }
    return s;
  }

  if (action === 'ClientProposal') {
    if (node.role === 'leader') {
      node.log = node.log + 1;
    }
    return s;
  }

  if (action === 'HandleAppendEntries') {
    const msgTerm = data.term;
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

    const numEntries = (typeof entries === 'number') ? entries : 0;
    if (numEntries > 0) {
      node.log = msgIndex + numEntries;
    }

    const newLastIndex = node.log;
    const newCommit = Math.min(msgCommit, newLastIndex);
    if (newCommit > node.commit) {
      node.commit = newCommit;
    }

    return s;
  }

  if (action === 'HandleHeartbeat') {
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
