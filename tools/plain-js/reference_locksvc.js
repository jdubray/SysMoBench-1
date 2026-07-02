// Reference lean-contract spec for the PGo locksvc lock service — the JS analogue
// of the constrained TLA+ relation. No SAM library: a pure transition function
// over the observable lock-service state, exactly two keys:
//   holder  — the client id currently holding the lock, or null if free
//   waiters — FIFO queue of client ids that have requested and are waiting
// Grants are first-come-first-served: only the head of `waiters` may be granted,
// and only when the lock is free. Used by scripts/lean_demo.py (task locksvc).

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
    // c joins the line — unless it is already holding or already queued.
    if (c !== holder && !waiters.includes(c)) waiters.push(c);
    return { holder, waiters };
  }
  if (action === 'ServerGrantLock') {
    // FCFS: grant only the head, and only when the lock is free.
    if (holder === null && waiters.length > 0 && waiters[0] === c) {
      return { holder: c, waiters: waiters.slice(1) };
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
