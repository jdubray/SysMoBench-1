function init() {
  return { lockHeld: false, lockHolder: null };
}

function next(state, action, data) {
  if (action === 'AcquireLock') {
    // compare_exchange(false -> true): only succeeds if lock is free.
    if (!state.lockHeld) {
      return { lockHeld: true, lockHolder: data.thread };
    }
    // Lock already held: acquisition does not change observable state.
    // (busy-wait for 'lock', immediate failure for 'try')
    return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
  }

  if (action === 'ReleaseLock') {
    // store(false, Release): releasing thread must be the holder.
    if (state.lockHeld && state.lockHolder === data.thread) {
      return { lockHeld: false, lockHolder: null };
    }
    return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
  }

  return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
}

module.exports = { init, next };