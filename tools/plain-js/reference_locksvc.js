// Reference lean-contract spec for the PGo locksvc lock service — the JS analogue
// of the constrained TLA+ relation. No SAM library: a pure transition function
// over the observable lock-service state, exactly two keys:
//   holder  — the client id currently holding the lock, or null if free
//   waiters — the SET of client ids that have requested and are waiting,
//             represented canonically as an ascending-sorted array
// NOTE: waiters is a set, not a FIFO. The real server grants in ARRIVAL order,
// and arrival order at the server is not observable from client-side events
// (network/goroutine reordering) — so at this projection any waiter may be
// granted when the lock is free. Used by scripts/lean_demo.py (task locksvc).

function init() {
  return { holder: null, waiters: [] };
}

// next(state, action, data) -> new { holder, waiters } (pure; does not mutate state).
//   action ∈ ClientLockRequest | ServerGrantLock | ClientCriticalSection | ClientUnlockRequest
//   data   = { client: <id> }
function next(state, action, data) {
  const holder = state.holder;
  const waiters = state.waiters.slice();
  const c = data.client;

  if (action === 'ClientLockRequest') {
    // c joins the waiting set — unless it is already holding or already waiting.
    if (c !== holder && !waiters.includes(c)) {
      waiters.push(c);
      waiters.sort((a, b) => a - b);
    }
    return { holder, waiters };
  }
  if (action === 'ServerGrantLock') {
    // Grant any waiter, but only when the lock is free.
    if (holder === null && waiters.includes(c)) {
      return { holder: c, waiters: waiters.filter((w) => w !== c) };
    }
    return { holder, waiters };
  }
  if (action === 'ClientCriticalSection') {
    // c is using the lock; the observable lock state does not change.
    return { holder, waiters };
  }
  if (action === 'ClientUnlockRequest') {
    // Only the holder releases; otherwise no observable change.
    if (holder === c) return { holder: null, waiters };
    return { holder, waiters };
  }
  return { holder, waiters };
}

module.exports = { init, next };
