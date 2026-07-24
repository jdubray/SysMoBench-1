"use strict";

function init() {
  return {
    nodes: {
      "1": { role: "follower", term: 0, vote: "0", commit: 0, log: 0, logTerm: 0 },
      "2": { role: "follower", term: 0, vote: "0", commit: 0, log: 0, logTerm: 0 },
      "3": { role: "follower", term: 0, vote: "0", commit: 0, log: 0, logTerm: 0 },
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
    const newTerm = node.term + 1;
    node.term = newTerm;
    node.vote = nodeId;
    node.role = "candidate";
    return s;
  }

  if (action === "BecomeLeader") {
    node.role = "leader";
    return s;
  }

  if (action === "HandleVoteRequest") {
    const from = String(data.from);
    const msgTerm = data.term;
    const msgLogTerm = data.logTerm;
    const msgIndex = data.index;

    if (msgTerm > node.term) {
      node.term = msgTerm;
      node.vote = "0";
      node.role = "follower";
    } else if (msgTerm < node.term) {
      return s;
    }

    const canVote = node.vote === from || node.vote === "0";

    // isUpToDate: compare (msgLogTerm, msgIndex) vs (node.logTerm, node.log)
    const myLastLogTerm = node.logTerm || 0;
    const isUpToDate =
      msgLogTerm > myLastLogTerm ||
      (msgLogTerm === myLastLogTerm && msgIndex >= node.log);

    if (canVote && isUpToDate) {
      node.vote = from;
    }

    return s;
  }

  if (action === "ClientProposal") {
    if (node.role !== "leader") {
      return s;
    }
    node.log = node.log + 1;
    node.logTerm = node.term;
    return s;
  }

  if (action === "HandleAppendEntries") {
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
      node.vote = "0";
      node.role = "follower";
    } else {
      if (node.role === "candidate") {
        node.role = "follower";
      }
    }

    if (msgIndex <= node.log) {
      const newLastIndex = msgIndex + entries;
      if (newLastIndex > node.log) {
        node.log = newLastIndex;
        if (entries > 0) {
          // The term of the last appended entry comes from the message
          // For a single batch, entries are from the leader's term (msgTerm)
          node.logTerm = msgTerm;
        }
      } else {
        if (entries > 0) {
          node.log = newLastIndex;
          node.logTerm = msgTerm;
        }
      }
      const newCommit = Math.min(msgCommit, msgIndex + entries);
      if (newCommit > node.commit) {
        node.commit = newCommit;
      }
    }

    return s;
  }

  if (action === "HandleHeartbeat") {
    const from = String(data.from);
    const msgTerm = data.term;
    const msgCommit = data.commit;

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

    if (msgCommit > node.commit) {
      node.commit = Math.min(msgCommit, node.log);
    }

    return s;
  }

  return s;
}

module.exports = { init, next };
