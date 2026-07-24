function init() {
  return { lockHeld: false, lockHolder: null };
}

function next(state, action, data) {
  if (action === 'AcquireLock') {
    const { thread, callType } = data;
    
    // If lock is already held, acquisition fails
    if (state.lockHeld) {
      // For 'lock' type: busy-wait semantics mean we keep trying
      // For 'try' type: immediate failure, state unchanged
      if (callType === 'try') {
        return state;
      }
      // For 'lock' type, we eventually succeed (modeled as next attempt succeeds)
      // But in a single step, if held, we don't acquire yet
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
  
  // Unknown action, state unchanged
  return state;
}

module.exports = { init, next };