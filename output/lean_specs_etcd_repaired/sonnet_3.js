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
    node.term = node.term + 1;
    node.vote = nodeId;
    node.role = "candidate";
    return s;
  }

  if (action === "HandleVoteRequest") {
    const from = String(data.from);
    const msgTerm = data.term;
    const candLogTerm = data.logTerm;
    const candLogIndex = data.index;

    const origTerm = node.term;
    const origVote = node.vote;
    const nodeLastLogTerm = node.logTerm;
    const nodeLastLogIndex = node.log;

    if (msgTerm > node.term) {
      node.term = msgTerm;
      node.vote = "0";
      node.role = "follower";
    } else if (msgTerm < node.term) {
      return s;
    }

    const canVote = node.vote === from || node.vote === "0";

    const candUpToDate =
      candLogTerm > nodeLastLogTerm ||
      (candLogTerm === nodeLastLogTerm && candLogIndex >= nodeLastLogIndex);

    if (canVote && candUpToDate) {
      node.vote = from;
      node.role = "follower";
    }

    return s;
  }

  if (action === "BecomeLeader") {
    if (node.role !== "candidate") return s;
    node.role = "leader";
    return s;
  }

  if (action === "ClientProposal") {
    if (node.role !== "leader") return s;
    node.log = node.log + 1;
    node.logTerm = node.term;
    return s;
  }

  if (action === "HandleAppendEntries") {
    const from = String(data.from);
    const msgTerm = data.term;
    const prevLogIndex = data.index;
    const prevLogTerm = data.logTerm;
    const entries = data.entries || 0;
    const leaderCommit = data.commit;

    if (msgTerm < node.term) return s;

    if (msgTerm > node.term) {
      node.term = msgTerm;
      node.vote = "0";
    }

    node.role = "follower";

    if (prevLogIndex > node.log) return s;

    const newLastIndex = prevLogIndex + entries;
    if (entries > 0) {
      node.log = newLastIndex;
      node.logTerm = prevLogTerm; // approximation: last appended entry term from leader's prevLogTerm context
      // Actually the entries are at msgTerm
      node.logTerm = msgTerm;
    }

    if (leaderCommit > node.commit) {
      node.commit = Math.min(leaderCommit, node.log);
    }

    return s;
  }

  if (action === "HandleHeartbeat") {
    const from = String(data.from);
    const msgTerm = data.term;
    const leaderCommit = data.commit;

    if (msgTerm < node.term) return s;

    if (msgTerm > node.term) {
      node.term = msgTerm;
      node.vote = "0";
    }

    node.role = "follower";

    if (leaderCommit > node.commit) {
      node.commit = Math.min(leaderCommit, node.log);
    }

    return s;
  }

  if (action === "LeaderCommit") {
    if (node.role !== "leader") return s;
    const newCommit = data.commit;
    if (newCommit > node.commit && newCommit <= node.log) {
      node.commit = newCommit;
    }
    return s;
  }

  return s;
}

module.exports = { init, next };
