'use strict';

function init() {
  return { holder: null, waiters: [] };
}

function next(state, action, data) {
  const holder = state.holder;
  const waiters = state.waiters.slice();
  const c = data && data.client;

  switch (action) {
    case 'ClientLockRequest': {
      if (holder === c || waiters.indexOf(c) !== -1) {
        return { holder: holder, waiters: waiters };
      }
      waiters.push(c);
      return { holder: holder, waiters: waiters };
    }
    case 'ServerGrantLock': {
      if (holder === null && waiters.length > 0 && waiters[0] === c) {
        return { holder: c, waiters: waiters.slice(1) };
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