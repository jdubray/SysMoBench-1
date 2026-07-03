function init() {
  return { lockHeld: false, lockHolder: null };
}

function next(state, action, data) {
  if (action === 'AcquireLock') {
    // compare_exchange(false, true): only succeeds if lock is free.
    if (!state.lockHeld) {
      return { lockHeld: true, lockHolder: data.thread };
    }
    // Lock is held: acquisition fails/blocks; state unchanged.
    return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
  }

  if (action === 'ReleaseLock') {
    // release_lock stores false unconditionally; only the holder releases.
    if (state.lockHeld && state.lockHolder === data.thread) {
      return { lockHeld: false, lockHolder: null };
    }
    return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
  }

  return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
}

module.exports = { init, next };