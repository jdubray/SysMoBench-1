function init() {
  return { holder: null, waiters: [] };
}

function next(state, action, data) {
  const c = data.client;
  switch (action) {
    case 'ClientLockRequest': {
      if (state.holder === c || state.waiters.includes(c)) {
        return { holder: state.holder, waiters: state.waiters.slice() };
      }
      const waiters = state.waiters.slice();
      waiters.push(c);
      waiters.sort((a, b) => a - b);
      return { holder: state.holder, waiters };
    }
    case 'ServerGrantLock': {
      if (state.holder === null && state.waiters.includes(c)) {
        const waiters = state.waiters.filter(x => x !== c);
        return { holder: c, waiters };
      }
      return { holder: state.holder, waiters: state.waiters.slice() };
    }
    case 'ClientCriticalSection': {
      return { holder: state.holder, waiters: state.waiters.slice() };
    }
    case 'ClientUnlockRequest': {
      if (state.holder === c) {
        return { holder: null, waiters: state.waiters.slice() };
      }
      return { holder: state.holder, waiters: state.waiters.slice() };
    }
    default:
      return { holder: state.holder, waiters: state.waiters.slice() };
  }
}

module.exports = { init, next };