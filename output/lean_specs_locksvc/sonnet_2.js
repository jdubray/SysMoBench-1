module.exports = { init, next };

function init() {
  return { holder: null, waiters: [] };
}

function next(state, action, data) {
  const { holder, waiters } = state;
  const c = data.client;

  if (action === 'ClientLockRequest') {
    if (holder === c || waiters.indexOf(c) !== -1) {
      return { holder, waiters };
    }
    return { holder, waiters: waiters.concat([c]) };
  }

  if (action === 'ServerGrantLock') {
    if (holder === null && waiters.length > 0 && waiters[0] === c) {
      return { holder: c, waiters: waiters.slice(1) };
    }
    return { holder, waiters };
  }

  if (action === 'ClientCriticalSection') {
    return { holder, waiters };
  }

  if (action === 'ClientUnlockRequest') {
    if (holder === c) {
      return { holder: null, waiters };
    }
    return { holder, waiters };
  }

  return { holder, waiters };
}