function init() {
  return { holder: null, waiters: [] };
}

function next(state, action, data) {
  const holder = state.holder;
  const waiters = state.waiters.slice();
  const c = data.client;

  switch (action) {
    case 'ClientLockRequest': {
      if (holder !== c && !waiters.includes(c)) {
        waiters.push(c);
      }
      return { holder: holder, waiters: waiters };
    }
    case 'ServerGrantLock': {
      if (holder === null && waiters[0] === c) {
        waiters.shift();
        return { holder: c, waiters: waiters };
      }
      return { holder: holder, waiters: waiters };
    }
    case 'ClientCriticalSection': {
      return { holder: holder, waiters: waiters };
    }
    case 'ClientUnlockRequest': {
      if (holder === c) {
        return { holder: null, waiters: waiters };
      }
      return { holder: holder, waiters: waiters };
    }
    default:
      return { holder: holder, waiters: waiters };
  }
}

module.exports = { init, next };