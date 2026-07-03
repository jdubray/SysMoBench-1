'use strict';

function init() {
  return { lockHeld: false, lockHolder: null };
}

function next(state, action, data) {
  if (action === 'AcquireLock') {
    // compare_exchange(false, true): succeeds only when the lock is free.
    // A blocking `lock` spins until free; a `try` simply fails.
    // In either case, the observable state only changes when the
    // acquisition actually succeeds (lock currently free).
    if (!state.lockHeld) {
      return { lockHeld: true, lockHolder: data.thread };
    }
    // Lock already held: failed try_lock or still-spinning lock().
    // No observable state change in this step.
    return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
  }

  if (action === 'ReleaseLock') {
    // release_lock(): store(false). Only the holder drops its guard.
    if (state.lockHeld && state.lockHolder === data.thread) {
      return { lockHeld: false, lockHolder: null };
    }
    // Release by a non-holder should not occur; state unchanged.
    return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
  }

  // Unknown action: no change.
  return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
}

module.exports = { init, next };