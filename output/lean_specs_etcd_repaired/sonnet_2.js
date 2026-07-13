'use strict';

function init() {
  return {
    nodes: {
      '1': { role: 'follower', term: 0, vote: '0', commit: 0, log: 0, logTerm: 0 },
      '2': { role: 'follower', term: 0, vote: '0', commit: 0, log: 0, logTerm: 0 },
      '3': { role: 'follower', term: 0, vote: '0', commit: 0, log: 0, logTerm: 0 },
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
    const msgTerm = data.term;
    const fromId = String(data.from);
    const msgLogTerm = data.logTerm;
    const msgIndex = data.index;

    if (msgTerm > node.term) {
      node.term = msgTerm;
      node.vote = '0';
      node.role = 'follower';
    } else if (msgTerm < node.term) {
      return s;
    }

    const canVote = (node.vote === fromId) || (node.vote === '0');

    const myLastLogTerm = node.logTerm;
    const myLastIndex = node.log;

    const upToDate = (msgLogTerm > myLastLogTerm) ||
                     (msgLogTerm === myLastLogTerm && msgIndex >= myLastIndex);

    if (canVote && upToDate) {
      node.vote = fromId;
      node.role = 'follower';
    }

    return s;
  }

  if (action === 'ClientProposal') {
    if (node.role === 'leader') {
      node.log = node.log + 1;
      node.logTerm = node.term;
    }
    return s;
  }

  if (action === 'HandleAppendEntries') {
    const msgTerm = data.term;
    const msgLogTerm = data.logTerm;
    const msgIndex = data.index;
    const entries = data.entries || 0;
    const msgCommit = data.commit;
    const msgEntryTerm = data.entryTerm !== undefined ? data.entryTerm : msgTerm;

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

    if (msgIndex < node.commit) {
      return s;
    }

    if (msgIndex > node.log) {
      return s;
    }

    const numEntries = (typeof entries === 'number') ? entries : 0;
    const newLastIndex = msgIndex + numEntries;

    if (numEntries > 0) {
      if (newLastIndex >= node.log) {
        node.log = newLastIndex;
        node.logTerm = msgEntryTerm;
      } else {
        node.log = newLastIndex;
        node.logTerm = msgEntryTerm;
      }
    }

    if (msgCommit > node.commit) {
      node.commit = Math.min(msgCommit, node.log);
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
      node.commit = Math.min(msgCommit, node.log);
    }

    return s;
  }

  return s;
}

module.exports = { init, next };
