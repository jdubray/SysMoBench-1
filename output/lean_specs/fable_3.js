'use strict';

function init() {
  return { lockHeld: false, lockHolder: null };
}

function next(state, action, data) {
  if (action === 'AcquireLock') {
    if (state.lockHeld === false) {
      // compare_exchange(false, true) succeeds: thread acquires the lock.
      return { lockHeld: true, lockHolder: data.thread };
    }
    // Lock already held: blocking lock() spins (no observable change),
    // try_lock() fails (no observable change).
    return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
  }

  if (action === 'ReleaseLock') {
    if (state.lockHeld === true && state.lockHolder === data.thread) {
      // store(false, Release): lock is freed.
      return { lockHeld: false, lockHolder: null };
    }
    // Thread does not hold the lock: no observable change.
    return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
  }

  // Unknown action: no change.
  return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
}

module.exports = { init, next };