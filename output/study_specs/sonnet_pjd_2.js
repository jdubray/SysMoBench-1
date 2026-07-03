"use strict";

function init() {
  return { lockHeld: false, lockHolder: null };
}

function next(state, action, data) {
  if (action === "AcquireLock") {
    const thread = data.thread;
    const callType = data.callType;

    if (callType === "lock") {
      // Busy-waits until acquired: if lock is free, acquire it; otherwise spin (no state change yet)
      if (!state.lockHeld) {
        return { lockHeld: true, lockHolder: thread };
      } else {
        // Still spinning — state unchanged
        return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
      }
    } else if (callType === "try") {
      // try_lock: one attempt only — succeeds if free, fails otherwise
      if (!state.lockHeld) {
        return { lockHeld: true, lockHolder: thread };
      } else {
        // try_lock failed, state unchanged
        return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
      }
    }
  } else if (action === "ReleaseLock") {
    const thread = data.thread;
    // Only the holder may release the lock
    if (state.lockHeld && state.lockHolder === thread) {
      return { lockHeld: false, lockHolder: null };
    } else {
      // No valid release — state unchanged
      return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
    }
  }

  // Unknown action — return state unchanged
  return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
}

module.exports = { init, next };