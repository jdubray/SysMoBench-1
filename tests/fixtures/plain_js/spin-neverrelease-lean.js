// BROKEN lean-contract spin spec: ReleaseLock is a no-op — the lock is never
// freed after the first acquire. Passes all three SAFETY invariants (a stuck
// lock trivially preserves mutual exclusion), so safety-only Phase 4 cannot
// fail it. Used to prove the explorer's bounded PROGRESS checks (EF
// reachability) catch this class: from any held state, no reachable state has
// the lock free => ReleaseProgress is violated.

function init() {
  return { lockHeld: false, lockHolder: null };
}

function next(state, action, data) {
  if (action === 'AcquireLock') {
    if (!state.lockHeld) return { lockHeld: true, lockHolder: data.thread };
    return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
  }
  if (action === 'ReleaseLock') {
    // BROKEN: never releases.
    return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
  }
  return state;
}

module.exports = { init, next };
