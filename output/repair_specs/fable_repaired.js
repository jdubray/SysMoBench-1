'use strict';

const { createInstance } = require('@cognitive-fab/sam-pattern');

const instance = createInstance({ instanceName: 'spin', hasAsyncActions: false });

// Model of ostd/src/sync/spin.rs
//
// - lockHeld / lockHolder : the AtomicBool `lock` plus ownership bookkeeping
// - threadStatus[t]       : 'idle' | 'trying' | 'locked'
//     'idle'   -> thread not interacting with the lock
//     'trying' -> thread inside acquire_lock() busy-wait loop (blocking lock() only)
//     'locked' -> thread holds a SpinLockGuard
// - callType[t]           : 'lock' when a blocking lock() call is pending (spinning),
//                           null otherwise. try_lock() never leaves a pending call.
const INITIAL_STATE = {
  lockHeld: false,
  lockHolder: null,
  threadStatus: { 0: 'idle', 1: 'idle' },
  callType: { 0: null, 1: null },
};

const clone = (value) => JSON.parse(JSON.stringify(value));

const isValidThread = (t) => t === 0 || t === 1;

// try_lock() may be referred to as 'tryLock' or 'try'; blocking lock() as 'lock'.
const normalizeCallType = (callType) => {
  if (callType === 'lock') return 'lock';
  if (callType === 'tryLock' || callType === 'try') return 'tryLock';
  return null;
};

// Ensure the per-thread bookkeeping objects exist and are consistent with the
// authoritative lockHeld/lockHolder fields (snapshots may be partial).
const ensureBookkeeping = (model) => {
  if (!model.threadStatus || typeof model.threadStatus !== 'object') {
    model.threadStatus = { 0: 'idle', 1: 'idle' };
  }
  if (!model.callType || typeof model.callType !== 'object') {
    model.callType = { 0: null, 1: null };
  }
  for (const t of [0, 1]) {
    if (model.threadStatus[t] === undefined) model.threadStatus[t] = 'idle';
    if (model.callType[t] === undefined) model.callType[t] = null;
  }
  // lockHolder is the source of truth for who holds the guard.
  if (model.lockHeld && isValidThread(model.lockHolder)) {
    model.threadStatus[model.lockHolder] = 'locked';
    model.callType[model.lockHolder] = null;
  }
};

const { intents } = instance({
  initialState: clone(INITIAL_STATE),
  component: {
    actions: [
      // AcquireLock: models one attempt at compare_exchange(false, true).
      // For callType 'lock' this is one iteration of the busy-wait loop in
      // acquire_lock(); for 'tryLock' (alias 'try') this is the single attempt
      // in try_lock().
      (data = {}) => ({
        __name: 'AcquireLock',
        acquire: true,
        thread: data.thread,
        callType: data.callType,
      }),
      // ReleaseLock: models SpinLockGuard::drop -> release_lock().
      (data = {}) => ({
        __name: 'ReleaseLock',
        release: true,
        thread: data.thread,
      }),
    ],
    acceptors: [
      // Acceptor for AcquireLock proposals (the CAS happens atomically here,
      // as a single synchronized SAM step).
      (model) => (proposal) => {
        if (!proposal || !proposal.acquire) return;
        const t = proposal.thread;
        const callType = normalizeCallType(proposal.callType);
        if (!isValidThread(t)) return;
        if (callType === null) return;

        ensureBookkeeping(model);

        // A thread already holding the lock cannot re-acquire (non-reentrant).
        if (model.lockHeld && model.lockHolder === t) return;
        if (model.threadStatus[t] === 'locked') return;

        // A thread already spinning in a blocking lock() call may only retry
        // the CAS as part of that same blocking call.
        if (model.threadStatus[t] === 'trying' && callType !== 'lock') return;

        // Atomic compare_exchange(false, true, Acquire, Relaxed)
        if (!model.lockHeld) {
          // CAS success: acquire the lock.
          model.lockHeld = true;
          model.lockHolder = t;
          model.threadStatus[t] = 'locked';
          model.callType[t] = null;
        } else if (callType === 'lock') {
          // CAS failure on blocking lock(): keep spinning (core::hint::spin_loop).
          model.threadStatus[t] = 'trying';
          model.callType[t] = 'lock';
        } else {
          // CAS failure on try_lock(): return None immediately, back to idle.
          model.threadStatus[t] = 'idle';
          model.callType[t] = null;
        }
      },
      // Acceptor for ReleaseLock proposals (SpinLockGuard drop).
      (model) => (proposal) => {
        if (!proposal || !proposal.release) return;
        const t = proposal.thread;
        if (!isValidThread(t)) return;

        ensureBookkeeping(model);

        // Release by a non-holder is an invalid proposal: no-op.
        // Ownership is determined by lockHeld/lockHolder (authoritative).
        if (!model.lockHeld) return;
        if (model.lockHolder !== t) return;

        // store(false, Release)
        model.lockHeld = false;
        model.lockHolder = null;
        model.threadStatus[t] = 'idle';
        model.callType[t] = null;
      },
    ],
    reactors: [],
  },
});

const [acquireIntent, releaseIntent] = intents;

const sanitizeReplacer = (key, value) => {
  if (typeof key === 'string' && key.startsWith('__')) return undefined;
  if (typeof value === 'function') return undefined;
  return value;
};

const getState = () => JSON.parse(JSON.stringify(instance({}).state(), sanitizeReplacer));

// Merge (possibly partial) snapshots over the initial state, then reconcile
// the per-thread bookkeeping with lockHeld/lockHolder.
const normalizeSnapshot = (snapshot) => {
  const base = clone(INITIAL_STATE);
  const snap = snapshot ? clone(snapshot) : {};

  if ('lockHeld' in snap) base.lockHeld = snap.lockHeld;
  if ('lockHolder' in snap) base.lockHolder = snap.lockHolder;

  if (snap.threadStatus && typeof snap.threadStatus === 'object') {
    for (const t of [0, 1]) {
      if (snap.threadStatus[t] !== undefined) base.threadStatus[t] = snap.threadStatus[t];
    }
  }
  if (snap.callType && typeof snap.callType === 'object') {
    for (const t of [0, 1]) {
      if (snap.callType[t] !== undefined) base.callType[t] = snap.callType[t];
    }
  }

  ensureBookkeeping(base);
  return base;
};

const setState = (snapshot) => {
  instance({ initialState: normalizeSnapshot(snapshot) });
};

const init = () => {
  instance({}).state().clearError();
  setState(INITIAL_STATE);
};

const actions = {
  AcquireLock: (data = {}) => acquireIntent(data),
  ReleaseLock: (data = {}) => releaseIntent(data),
};

const checkerIntents = [
  {
    name: 'AcquireLock',
    intent: actions.AcquireLock,
    values: [
      [{ thread: 0, callType: 'lock' }],
      [{ thread: 0, callType: 'tryLock' }],
      [{ thread: 1, callType: 'lock' }],
      [{ thread: 1, callType: 'tryLock' }],
    ],
  },
  {
    name: 'ReleaseLock',
    intent: actions.ReleaseLock,
    values: [
      [{ thread: 0 }],
      [{ thread: 1 }],
    ],
  },
];

module.exports = { instance, init, actions, getState, setState, checkerIntents };