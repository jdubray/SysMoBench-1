"use strict";

/**
 * Pure transition function modeling the observable behavior of the
 * Asterinas SpinLock (ostd/src/sync/spin.rs).
 *
 * Observable state:
 *   lockHeld   : boolean — true iff the AtomicBool `lock` is true
 *   lockHolder : 0 | 1 | null — the thread holding the lock, or null
 */

function init() {
  return { lockHeld: false, lockHolder: null };
}

function next(state, action, data) {
  const lockHeld = state.lockHeld;
  const lockHolder = state.lockHolder;

  if (action === 'AcquireLock') {
    // Both `lock()` (spinning) and `try_lock()` bottom out in
    // compare_exchange(false, true): the lock can only transition to
    // held-by-thread when it is currently free. If it is held:
    //   - `try` fails immediately (no state change)
    //   - `lock` keeps spinning (no observable state change this step)
    if (!lockHeld) {
      return { lockHeld: true, lockHolder: data.thread };
    }
    return { lockHeld: lockHeld, lockHolder: lockHolder };
  }

  if (action === 'ReleaseLock') {
    // release_lock() stores false; it is only ever invoked by the guard's
    // Drop, i.e. by the current holder.
    if (lockHeld && lockHolder === data.thread) {
      return { lockHeld: false, lockHolder: null };
    }
    return { lockHeld: lockHeld, lockHolder: lockHolder };
  }

  // Unknown action: no change.
  return { lockHeld: lockHeld, lockHolder: lockHolder };
}

module.exports = { init, next };