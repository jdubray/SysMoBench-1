'use strict';

function init() {
  return { lockHeld: false, lockHolder: null };
}

function next(state, action, data) {
  if (action === 'AcquireLock') {
    if (!state.lockHeld) {
      // Lock is free: compare_exchange(false, true) succeeds,
      // regardless of whether this was lock() or try_lock().
      return { lockHeld: true, lockHolder: data.thread };
    }
    // Lock is held: a blocking lock() spins (no observable change),
    // and a failing try_lock() leaves the lock unchanged.
    return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
  }

  if (action === 'ReleaseLock') {
    if (state.lockHeld && state.lockHolder === data.thread) {
      // release_lock(): store(false, Release)
      return { lockHeld: false, lockHolder: null };
    }
    // Not the holder: no observable change.
    return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
  }

  // Unknown action: no change.
  return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
}

module.exports = { init, next };