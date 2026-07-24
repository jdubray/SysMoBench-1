function init() {
  return { lockHeld: false, lockHolder: null };
}

function next(state, action, data) {
  if (action === 'AcquireLock') {
    if (!state.lockHeld) {
      return { lockHeld: true, lockHolder: data.thread };
    }
    return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
  }

  if (action === 'ReleaseLock') {
    if (state.lockHolder === data.thread) {
      return { lockHeld: false, lockHolder: null };
    }
    return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
  }

  return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
}

module.exports = { init, next };