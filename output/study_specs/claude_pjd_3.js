'use strict';

function init() {
  return { lockHeld: false, lockHolder: null };
}

function next(state, action, data) {
  if (action === 'AcquireLock') {
    // compare_exchange(false, true): succeeds only if lock is free.
    if (!state.lockHeld) {
      return { lockHeld: true, lockHolder: data.thread };
    }
    // Lock already held: acquisition does not change observable state.
    // (For 'lock', busy-waits; for 'try', returns None.)
    return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
  }

  if (action === 'ReleaseLock') {
    // release_lock stores false unconditionally, but only the holder releases.
    if (state.lockHeld && state.lockHolder === data.thread) {
      return { lockHeld: false, lockHolder: null };
    }
    return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
  }

  return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
}

module.exports = { init, next };