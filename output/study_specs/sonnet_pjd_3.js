"use strict";

function init() {
  return { lockHeld: false, lockHolder: null };
}

function next(state, action, data) {
  if (action === "AcquireLock") {
    const thread = data.thread;
    const callType = data.callType;

    if (callType === "lock") {
      // Busy-waits until acquired: if lock is free, acquire it; otherwise spin (state unchanged)
      if (!state.lockHeld) {
        return { lockHeld: true, lockHolder: thread };
      } else {
        // Still spinning — observable state does not change
        return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
      }
    } else if (callType === "try") {
      // try_lock: one attempt only — succeeds if free, fails immediately otherwise
      if (!state.lockHeld) {
        return { lockHeld: true, lockHolder: thread };
      } else {
        // try_lock failed — state unchanged
        return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
      }
    }

    // Unknown callType — return state unchanged
    return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
  }

  if (action === "ReleaseLock") {
    const thread = data.thread;

    // Only the holder may release the lock
    if (state.lockHeld && state.lockHolder === thread) {
      return { lockHeld: false, lockHolder: null };
    }

    // Not the holder or lock not held — state unchanged
    return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
  }

  // Unknown action — return state unchanged
  return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
}

module.exports = { init, next };