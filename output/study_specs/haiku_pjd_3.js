function init() {
  return { lockHeld: false, lockHolder: null };
}

function next(state, action, data) {
  if (action === 'AcquireLock') {
    const { thread, callType } = data;
    
    // If lock is already held, acquisition fails
    if (state.lockHeld) {
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
    
    return state;
  }
  
  return state;
}

module.exports = { init, next };