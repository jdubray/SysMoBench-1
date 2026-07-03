"use strict";

function init() {
  return { lockHeld: false, lockHolder: null };
}

function next(state, action, data) {
  if (action === 'AcquireLock') {
    // compare_exchange(false, true): succeeds only when the lock is free.
    // Whether the caller uses `lock` (spins) or `try_lock` (fails fast),
    // the only observable state change is a successful acquisition.
    if (!state.lockHeld) {
      return { lockHeld: true, lockHolder: data.thread };
    }
    // Lock already held: `try` fails, `lock` keeps spinning — no change.
    return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
  }

  if (action === 'ReleaseLock') {
    // release_lock(): store(false, Release) — only invoked by the guard's
    // Drop, i.e., by the current holder. The lock becomes free.
    if (state.lockHeld && state.lockHolder === data.thread) {
      return { lockHeld: false, lockHolder: null };
    }
    // A non-holder cannot drop a guard it does not own — no change.
    return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
  }

  // Unknown action: no change.
  return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
}

module.exports = { init, next };