function init() {
  return { holder: null, waiters: [] };
}

function next(state, action, data) {
  const { client } = data;
  const { holder, waiters } = state;

  switch (action) {
    case 'ClientLockRequest': {
      // Add client to waiters if not already holder or waiting
      if (holder === client || waiters.includes(client)) {
        return { holder, waiters };
      }
      const newWaiters = [...waiters, client].sort((a, b) => a - b);
      return { holder, waiters: newWaiters };
    }

    case 'ServerGrantLock': {
      // Grant lock only if free and client is waiting
      if (holder === null && waiters.includes(client)) {
        const newWaiters = waiters.filter(c => c !== client);
        return { holder: client, waiters: newWaiters };
      }
      return { holder, waiters };
    }

    case 'ClientCriticalSection': {
      // No observable state change
      return { holder, waiters };
    }

    case 'ClientUnlockRequest': {
      // Release lock if client is the holder
      if (holder === client) {
        return { holder: null, waiters };
      }
      return { holder, waiters };
    }

    default:
      return { holder, waiters };
  }
}

module.exports = { init, next };