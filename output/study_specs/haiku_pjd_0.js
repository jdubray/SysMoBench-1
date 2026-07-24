function init() {
  return { lockHeld: false, lockHolder: null };
}

function next(state, action, data) {
  if (action === 'AcquireLock') {
    const { thread, callType } = data;
    
    // If lock is already held, acquisition fails
    if (state.lockHeld) {
      // try_lock returns None (fails silently)
      // lock() would spin, but we model only the atomic step
      return state;
    }
    
    // Lock is free: acquire it atomically
    // compare_exchange(false, true, Acquire, Relaxed) succeeds
    return {
      lockHeld: true,
      lockHolder: thread
    };
  }
  
  if (action === 'ReleaseLock') {
    const { thread } = data;
    
    // Release only if this thread holds the lock
    if (state.lockHeld && state.lockHolder === thread) {
      return {
        lockHeld: false,
        lockHolder: null
      };
    }
    
    // Invalid release (thread doesn't hold lock) - no state change
    return state;
  }
  
  return state;
}

module.exports = { init, next };