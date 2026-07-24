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
        // 'lock' spins until acquired — but since this models a single step
        // where the lock is held by someone else, the state does not change
        // (the thread is still waiting/spinning)
        return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
      }
    }
  } else if (action === "ReleaseLock") {
    const thread = data.thread;

    if (state.lockHeld && state.lockHolder === thread) {
      // Only the holder can release the lock
      return { lockHeld: false, lockHolder: null };
    } else {
      // No-op: thread doesn't hold the lock
      return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
    }
  } else {
    // Unknown action — return state unchanged
    return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
  }
}

module.exports = { init, next };