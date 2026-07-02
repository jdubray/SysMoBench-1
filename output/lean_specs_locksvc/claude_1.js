function init() {
  return { holder: null, waiters: [] };
}

function next(state, action, data) {
  const holder = state.holder;
  const waiters = state.waiters;
  const c = data.client;

  switch (action) {
    case 'ClientLockRequest': {
      if (holder === c || waiters.includes(c)) {
        return { holder, waiters: waiters.slice() };
      }
      return { holder, waiters: waiters.concat([c]) };
    }
    case 'ServerGrantLock': {
      if (holder === null && waiters.length > 0 && waiters[0] === c) {
        return { holder: c, waiters: waiters.slice(1) };
      }
      return { holder, waiters: waiters.slice() };
    }
    case 'ClientCriticalSection': {
      return { holder, waiters: waiters.slice() };
    }
    case 'ClientUnlockRequest': {
      if (holder === c) {
        return { holder: null, waiters: waiters.slice() };
      }
      return { holder, waiters: waiters.slice() };
    }
    default:
      return { holder, waiters: waiters.slice() };
  }
}

module.exports = { init, next };