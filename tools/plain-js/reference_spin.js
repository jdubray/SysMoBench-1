// Reference lean-contract spin spec — the JS analogue of the constrained TLA+
// relation. No SAM library: a pure transition function over exactly two keys.
// Every model in the N=5 study produced a spec equivalent to this (all 100% on
// Phase 3). Used by scripts/lean_demo.py to demonstrate Phases 2/3/4.

function init() {
  return { lockHeld: false, lockHolder: null };
}

// next(state, action, data) -> new { lockHeld, lockHolder } (pure; does not mutate state).
function next(state, action, data) {
  if (action === 'AcquireLock') {
    // Free -> acquire; held -> unchanged (blocking spin and failed try both leave
    // the observable lock untouched, regardless of callType).
    if (!state.lockHeld) return { lockHeld: true, lockHolder: data.thread };
    return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
  }
  if (action === 'ReleaseLock') {
    // Only the holder releases; otherwise no observable change.
    if (state.lockHolder === data.thread) return { lockHeld: false, lockHolder: null };
    return { lockHeld: state.lockHeld, lockHolder: state.lockHolder };
  }
  return state;
}

module.exports = { init, next };
