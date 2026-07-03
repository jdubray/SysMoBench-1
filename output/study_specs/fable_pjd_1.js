"use strict";

function init() {
  return { lockHeld: false, lockHolder: null };
}

function next(state, action, data) {
  if (action === 'AcquireLock') {
    // Mirrors try_acquire_lock: compare_exchange(false, true).
    // Succeeds only when the lock is currently free. Whether the caller
    // used `lock()` (spinning) or `try_lock()`, a single observable step
    // can only change state if the CAS succeeds; otherwise the state is
    // unchanged (a `lock` call keeps spinning, a `try` call fails).
    if (!state.lockHeld) {
      return { lockHeld: true, lockHolder: data.thread };
    }
    return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
  }

  if (action === 'ReleaseLock') {
    // Mirrors release_lock: store(false, Release), invoked from the guard's
    // Drop, i.e. only ever by the current holder.
    if (state.lockHeld && state.lockHolder === data.thread) {
      return { lockHeld: false, lockHolder: null };
    }
    return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
  }

  // Unknown action: no change.
  return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
}

module.exports = { init, next };