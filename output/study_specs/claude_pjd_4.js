function init() {
  return { lockHeld: false, lockHolder: null };
}

function next(state, action, data) {
  if (action === 'AcquireLock') {
    // compare_exchange(false, true): only succeeds if lock is free.
    if (!state.lockHeld) {
      return { lockHeld: true, lockHolder: data.thread };
    }
    // Lock held: acquisition fails to change state.
    // 'try' returns None; 'lock' busy-waits — either way, no state change.
    return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
  }

  if (action === 'ReleaseLock') {
    // release_lock stores false. Only the holder releases.
    if (state.lockHeld && state.lockHolder === data.thread) {
      return { lockHeld: false, lockHolder: null };
    }
    return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
  }

  return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
}

module.exports = { init, next };