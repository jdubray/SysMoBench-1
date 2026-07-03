"use strict";

function init() {
  return { lockHeld: false, lockHolder: null };
}

function next(state, action, data) {
  if (action === "AcquireLock") {
    const thread = data.thread;
    const callType = data.callType;

    if (!state.lockHeld) {
      // Lock is free — both 'lock' and 'try' succeed
      return { lockHeld: true, lockHolder: thread };
    } else {
      // Lock is already held
      if (callType === "try") {
        // try_lock fails immediately, state unchanged
        return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
      } else {
        // 'lock' spins until acquired — in a single observable step where
        // the lock becomes available and is acquired by this thread.
        // If the lock is held by someone else, this step cannot complete
        // (the thread is still spinning). We model the only observable
        // transition: the moment the CAS succeeds.
        // Since the harness only records steps where something changes,
        // and 'lock' busy-waits, the only observable post-state for
        // 'lock' when it was contended is still spinning (no state change).
        return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
      }
    }
  } else if (action === "ReleaseLock") {
    const thread = data.thread;

    if (state.lockHeld && state.lockHolder === thread) {
      // Holder releases the lock
      return { lockHeld: false, lockHolder: null };
    } else {
      // Not the holder or lock not held — no valid release, state unchanged
      return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
    }
  } else {
    // Unknown action — identity
    return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
  }
}

module.exports = { init, next };