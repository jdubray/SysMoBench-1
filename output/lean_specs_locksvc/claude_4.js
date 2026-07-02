function init() {
  return { holder: null, waiters: [] };
}

function next(state, action, data) {
  const holder = state.holder;
  const waiters = state.waiters.slice();
  const c = data.client;

  switch (action) {
    case 'ClientLockRequest': {
      if (holder === c || waiters.indexOf(c) !== -1) {
        return { holder, waiters };
      }
      waiters.push(c);
      return { holder, waiters };
    }
    case 'ServerGrantLock': {
      if (holder === null && waiters[0] === c) {
        waiters.shift();
        return { holder: c, waiters };
      }
      return { holder, waiters };
    }
    case 'ClientCriticalSection': {
      return { holder, waiters };
    }
    case 'ClientUnlockRequest': {
      if (holder === c) {
        return { holder: null, waiters };
      }
      return { holder, waiters };
    }
    default:
      return { holder, waiters };
  }
}

module.exports = { init, next };