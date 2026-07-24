function init() {
  return { holder: null, waiters: [] };
}

function next(state, action, data) {
  const c = data.client;
  const holder = state.holder;
  const waiters = state.waiters.slice();

  if (action === 'ClientLockRequest') {
    if (holder === c || waiters.includes(c)) {
      return { holder, waiters: state.waiters };
    }
    const newWaiters = waiters.concat(c).sort((a, b) => a - b);
    return { holder, waiters: newWaiters };
  }

  if (action === 'ServerGrantLock') {
    if (holder === null && waiters.includes(c)) {
      const newWaiters = waiters.filter(w => w !== c).sort((a, b) => a - b);
      return { holder: c, waiters: newWaiters };
    }
    return { holder, waiters: state.waiters };
  }

  if (action === 'ClientCriticalSection') {
    return { holder, waiters: state.waiters };
  }

  if (action === 'ClientUnlockRequest') {
    if (holder === c) {
      return { holder: null, waiters: state.waiters };
    }
    return { holder, waiters: state.waiters };
  }

  return { holder, waiters: state.waiters };
}

module.exports = { init, next };