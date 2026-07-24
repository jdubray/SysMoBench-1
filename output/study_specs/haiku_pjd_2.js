function init() {
  return { lockHeld: false, lockHolder: null };
}

function next(state, action, data) {
  if (action === 'AcquireLock') {
    const { thread, callType } = data;
    
    if (state.lockHeld) {
      // Lock is already held
      if (callType === 'try') {
        // try_lock fails, state unchanged
        return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
      } else {
        // lock() spins until acquired (modeled as blocking, no state change here)
        return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
      }
    } else {
      // Lock is free, acquire it
      return { lockHeld: true, lockHolder: thread };
    }
  } else if (action === 'ReleaseLock') {
    const { thread } = data;
    
    // Release the lock (only the holder can release)
    if (state.lockHolder === thread) {
      return { lockHeld: false, lockHolder: null };
    } else {
      // Invalid release (not the holder), state unchanged
      return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
    }
  }
  
  // Unknown action, return state unchanged
  return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
}

module.exports = { init, next };