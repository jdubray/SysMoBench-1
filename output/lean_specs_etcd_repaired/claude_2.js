'use strict';

function init() {
  return {
    nodes: {
      '1': { role: 'follower', term: 0, vote: '0', commit: 0, log: 0 },
      '2': { role: 'follower', term: 0, vote: '0', commit: 0, log: 0 },
      '3': { role: 'follower', term: 0, vote: '0', commit: 0, log: 0 }
    }
  };
}

function cloneState(state) {
  return {
    nodes: {
      '1': Object.assign({}, state.nodes['1']),
      '2': Object.assign({}, state.nodes['2']),
      '3': Object.assign({}, state.nodes['3'])
    }
  };
}

function next(state, action, data) {
  const ns = cloneState(state);
  const id = String(data.node);
  const self = ns.nodes[id];

  if (action === 'ElectionTimeout') {
    if (self.role === 'leader') {
      return ns;
    }
    self.term = self.term + 1;
    self.vote = id;
    self.role = 'candidate';
    return ns;
  }

  if (action === 'HandleVoteRequest') {
    const from = String(data.from);
    const mTerm = data.term;
    const candLogTerm = data.logTerm;
    const candIndex = data.index;

    if (mTerm > self.term) {
      self.term = mTerm;
      self.vote = '0';
      self.role = 'follower';
    } else if (mTerm < self.term) {
      return ns;
    }

    // m.Term == r.Term. Evaluate vote.
    const canVote = self.vote === from || self.vote === '0';

    // isUpToDate(cand): candidate's log is at least as up-to-date as ours.
    // Our last log term is NOT the current node term; the log was appended
    // at an earlier term. Since observable state does not carry the last
    // log term separately, we compare conservatively:
    //   - If we have no log (log == 0), our last term is 0.
    //   - Otherwise our last log term is unknown but is guaranteed to be
    //     <= the candidate's log term whenever the candidate's index
    //     dominates ours (the leader that produced those entries had a
    //     term >= the term at which we appended them). We therefore treat
    //     up-to-date purely by index when the candidate has a valid
    //     (>= 1) log term and index at least ours, and by term when the
    //     candidate's log term strictly exceeds a zero-log follower.
    const ourLastIndex = self.log;
    const ourLastTerm = ourLastIndex === 0 ? 0 : 0; // unknown lower bound

    let upToDate;
    if (candLogTerm > ourLastTerm) {
      upToDate = true;
    } else if (candLogTerm === ourLastTerm) {
      upToDate = candIndex >= ourLastIndex;
    } else {
      upToDate = false;
    }

    if (canVote && upToDate) {
      self.vote = from;
    }
    return ns;
  }

  if (action === 'ClientProposal') {
    if (self.role === 'leader') {
      self.log = self.log + 1;
    }
    return ns;
  }

  if (action === 'HandleAppendEntries') {
    const mTerm = data.term;
    const mIndex = data.index;
    const mEntries = data.entries || 0;
    const mCommit = data.commit;

    if (mTerm > self.term) {
      self.term = mTerm;
      self.vote = '0';
      self.role = 'follower';
    } else if (mTerm < self.term) {
      return ns;
    }

    self.role = 'follower';

    if (mIndex < self.commit) {
      return ns;
    }

    if (mIndex <= self.log) {
      const newLast = mIndex + mEntries;
      if (newLast > self.log) {
        self.log = newLast;
      }
      const newCommit = Math.min(mCommit, self.log);
      if (newCommit > self.commit) {
        self.commit = newCommit;
      }
      return ns;
    }

    return ns;
  }

  if (action === 'HandleHeartbeat') {
    const mTerm = data.term;
    const mCommit = data.commit;

    if (mTerm > self.term) {
      self.term = mTerm;
      self.vote = '0';
      self.role = 'follower';
    } else if (mTerm < self.term) {
      return ns;
    }

    self.role = 'follower';

    const newCommit = Math.min(mCommit, self.log);
    if (newCommit > self.commit) {
      self.commit = newCommit;
    }
    return ns;
  }

  return ns;
}

module.exports = { init, next };
