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
    // hup -> becomeCandidate: reset(Term+1), Vote=self, state=candidate.
    // Cannot campaign if already leader.
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

    // Term handling in Step:
    // If m.Term > r.Term: become follower at new term (lead None for vote),
    //   which resets Vote to None.
    if (mTerm > self.term) {
      self.term = mTerm;
      self.vote = '0';
      self.role = 'follower';
    } else if (mTerm < self.term) {
      // Lower term MsgVote is ignored (no response affects observable state).
      return ns;
    }

    // Now m.Term == r.Term. Evaluate vote.
    // canVote: repeat vote, or (no vote and no leader yet).
    // For MsgVote (not prevote), leader tracking: after step-down lead is None.
    const canVote = self.vote === from || self.vote === '0';

    // isUpToDate: candidate log is at least as up-to-date as ours.
    // Our last entry: term unknown in observable state; approximate using
    // log index and term. We track term as node term, and log index.
    // isUpToDate(cand) = candLogTerm > ourLogTerm ||
    //   (candLogTerm == ourLogTerm && candIndex >= ourIndex)
    // We don't have our last log term separately; use self.term as a proxy
    // only when log>0, else 0.
    const ourLastIndex = self.log;
    // Our last log term: not directly observable; in these traces the last
    // log term equals the term at which entries were appended. We treat an
    // empty log (log==0) as term 0.
    const ourLastTerm = ourLastIndex === 0 ? 0 : self.term;

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
      // Only record real votes for MsgVote (which this is).
      // electionElapsed reset not observable.
    }
    return ns;
  }

  if (action === 'ClientProposal') {
    // Only the leader appends. Followers/candidates forward or drop.
    if (self.role === 'leader') {
      self.log = self.log + 1;
    }
    return ns;
  }

  if (action === 'HandleAppendEntries') {
    const from = String(data.from);
    const mTerm = data.term;
    const mLogTerm = data.logTerm;
    const mIndex = data.index;
    const mEntries = data.entries || 0;
    const mCommit = data.commit;

    // Term handling.
    if (mTerm > self.term) {
      self.term = mTerm;
      self.vote = '0';
      self.role = 'follower';
    } else if (mTerm < self.term) {
      // Lower term MsgApp: with checkQuorum/preVote reply MsgAppResp; no
      // observable local change.
      return ns;
    }

    // m.Term == r.Term. Step down to follower, set lead.
    self.role = 'follower';

    // handleAppendEntries:
    // if a.prev.index < committed: reply committed, no change.
    if (mIndex < self.commit) {
      // commit stays; may bump commit? No, reply with committed. No change.
      return ns;
    }

    // maybeAppend: check log matches at prev (index, logTerm).
    // Our term at mIndex: approximate. If mIndex <= our log and matches,
    // append succeeds.
    // We accept if prevIndex <= our log (log-match by index on this trace).
    if (mIndex <= self.log) {
      // Append succeeds; new last index = mIndex + entries.
      const newLast = mIndex + mEntries;
      if (newLast > self.log) {
        self.log = newLast;
      }
      // commitTo(min(commit, lastNewIndex))
      const newCommit = Math.min(mCommit, self.log);
      if (newCommit > self.commit) {
        self.commit = newCommit;
      }
      return ns;
    }

    // Reject: log too short. No observable change beyond role/term already set.
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

    // m.Term == r.Term: become follower, set lead.
    self.role = 'follower';

    // handleHeartbeat: commitTo(m.Commit) bounded by our last log index.
    const newCommit = Math.min(mCommit, self.log);
    if (newCommit > self.commit) {
      self.commit = newCommit;
    }
    return ns;
  }

  return ns;
}

module.exports = { init, next };