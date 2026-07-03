"use strict";

function init() {
  return { lockHeld: false, lockHolder: null };
}

function next(state, action, data) {
  if (action === "AcquireLock") {
    const thread = data.thread;
    const callType = data.callType;

    if (!state.lockHeld) {
      // Lock is free — acquire it regardless of callType ('lock' spins until acquired, 'try' succeeds immediately)
      return { lockHeld: true, lockHolder: thread };
    } else {
      // Lock is already held
      if (callType === "try") {
        // try_lock fails immediately, state unchanged
        return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
      } else {
        // 'lock' spins — in a single observable step where the lock is held,
        // the spinning thread makes no progress; state unchanged
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