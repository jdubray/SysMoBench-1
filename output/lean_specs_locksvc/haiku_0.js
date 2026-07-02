function init() {
  return { holder: null, waiters: [] };
}

function next(state, action, data) {
  const { client } = data;
  const { holder, waiters } = state;

  switch (action) {
    case 'ClientLockRequest': {
      // Guard: client must not already be holder or in queue
      if (holder === client || waiters.includes(client)) {
        return { holder, waiters };
      }
      // Append client to back of queue
      return { holder, waiters: [...waiters, client] };
    }

    case 'ServerGrantLock': {
      // Guard: lock must be free AND client must be at head of queue
      if (holder === null && waiters.length > 0 && waiters[0] === client) {
        // Grant lock to client, remove from head of queue
        return { holder: client, waiters: waiters.slice(1) };
      }
      // No change if guard fails
      return { holder, waiters };
    }

    case 'ClientCriticalSection': {
      // Client uses the lock it holds; observable state unchanged
      return { holder, waiters };
    }

    case 'ClientUnlockRequest': {
      // Guard: client must be the holder
      if (holder === client) {
        // Release the lock
        return { holder: null, waiters };
      }
      // No change if guard fails
      return { holder, waiters };
    }

    default:
      return { holder, waiters };
  }
}

module.exports = { init, next };