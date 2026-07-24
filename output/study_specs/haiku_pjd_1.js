function init() {
  return { lockHeld: false, lockHolder: null };
}

function next(state, action, data) {
  if (action === 'AcquireLock') {
    const { thread, callType } = data;
    
    // If lock is already held, acquisition fails
    if (state.lockHeld) {
      // For 'lock' type: busy-wait semantics mean we keep trying
      // For 'try' type: we fail and return None
      // In both cases, the state doesn't change on a failed acquire
      return state;
    }
    
    // Lock is free, acquire it
    return {
      lockHeld: true,
      lockHolder: thread
    };
  }
  
  if (action === 'ReleaseLock') {
    const { thread } = data;
    
    // Only the lock holder can release
    if (state.lockHolder === thread && state.lockHeld) {
      return {
        lockHeld: false,
        lockHolder: null
      };
    }
    
    // Invalid release (not the holder), state unchanged
    return state;
  }
  
  // Unknown action
  return state;
}

module.exports = { init, next };