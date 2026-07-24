'use strict';

function init() {
  return { lockHeld: false, lockHolder: null };
}

function next(state, action, data) {
  if (action === 'AcquireLock') {
    // Corresponds to try_acquire_lock(): compare_exchange(false, true).
    // Succeeds only when the lock is free; both 'lock' (spinning) and
    // 'try' (failing) leave the observable state unchanged when held.
    if (state.lockHeld === false) {
      return { lockHeld: true, lockHolder: data.thread };
    }
    return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
  }

  if (action === 'ReleaseLock') {
    // Corresponds to release_lock(): store(false, Release), performed
    // by the guard's Drop — only the holder can release.
    if (state.lockHeld === true && state.lockHolder === data.thread) {
      return { lockHeld: false, lockHolder: null };
    }
    return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
  }

  // Unknown action: no observable change.
  return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
}

module.exports = { init, next };