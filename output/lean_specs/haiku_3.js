function init() {
  return { lockHeld: false, lockHolder: null };
}

function next(state, action, data) {
  if (action === 'AcquireLock') {
    // Lock is free: acquire it
    if (!state.lockHeld) {
      return { lockHeld: true, lockHolder: data.thread };
    }
    // Lock is held: no change (spinning or try_lock fails)
    return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
  }
  
  if (action === 'ReleaseLock') {
    // Only release if the releasing thread holds the lock
    if (state.lockHolder === data.thread) {
      return { lockHeld: false, lockHolder: null };
    }
    // Thread doesn't hold the lock: no change
    return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
  }
  
  // Unknown action: no change
  return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
}

module.exports = { init, next };