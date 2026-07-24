'use strict';

const { createInstance } = require('@cognitive-fab/sam-pattern');

const instance = createInstance({ instanceName: 'spin', hasAsyncActions: false });

const INITIAL_STATE = {
  lockHeld: false,
  lockHolder: null,
  threadStatus: { 0: 'idle', 1: 'idle' },
  callType: { 0: null, 1: null },
};

const clone = (value) => JSON.parse(JSON.stringify(value));

const deepMerge = (base, override) => {
  const result = clone(base);
  for (const key of Object.keys(override)) {
    if (
      override[key] !== null &&
      typeof override[key] === 'object' &&
      !Array.isArray(override[key]) &&
      result[key] !== null &&
      typeof result[key] === 'object'
    ) {
      result[key] = deepMerge(result[key], override[key]);
    } else {
      result[key] = override[key];
    }
  }
  return result;
};

const { intents } = instance({
  initialState: clone(INITIAL_STATE),
  component: {
    actions: [
      (data) => ({
        __name: 'AcquireLock',
        thread: data.thread,
        callType: data.callType,
      }),
      (data) => ({
        __name: 'ReleaseLock',
        thread: data.thread,
      }),
    ],
    acceptors: [
      // AcquireLock acceptor
      (model) => (proposal) => {
        if (proposal.__name !== 'AcquireLock') return;

        const { thread, callType } = proposal;
        if (thread !== 0 && thread !== 1) return;

        // Normalize callType: accept 'try' as alias for 'tryLock'
        const normalizedCallType =
          callType === 'try' ? 'tryLock' : callType;

        if (normalizedCallType !== 'lock' && normalizedCallType !== 'tryLock') return;

        const currentStatus = model.threadStatus[thread];

        // A thread that is already 'locked' (holds the lock) cannot acquire again
        if (currentStatus === 'locked') return;

        // Transition idle -> trying (records the call type)
        if (currentStatus === 'idle') {
          model.threadStatus[thread] = 'trying';
          model.callType[thread] = normalizedCallType;
        }

        // Now attempt the CAS (atomic compare_exchange: false -> true)
        if (model.threadStatus[thread] === 'trying') {
          if (!model.lockHeld) {
            // CAS succeeds: acquire the lock
            model.lockHeld = true;
            model.lockHolder = thread;
            model.threadStatus[thread] = 'locked';
            model.callType[thread] = null;
          } else {
            // CAS fails
            if (model.callType[thread] === 'tryLock') {
              // try_lock: non-blocking — return to idle immediately
              model.threadStatus[thread] = 'idle';
              model.callType[thread] = null;
            }
            // lock: blocking — stay in 'trying' (spinning), callType remains
          }
        }
      },

      // ReleaseLock acceptor
      (model) => (proposal) => {
        if (proposal.__name !== 'ReleaseLock') return;

        const { thread } = proposal;
        if (thread !== 0 && thread !== 1) return;

        // Only the current lock holder may release
        if (!model.lockHeld || model.lockHolder !== thread) return;

        model.lockHeld = false;
        model.lockHolder = null;
        model.threadStatus[thread] = 'idle';
        model.callType[thread] = null;
      },
    ],
    reactors: [],
  },
});

const [acquireLockIntent, releaseLockIntent] = intents;

const sanitizeReplacer = (key, value) => {
  if (typeof key === 'string' && key.startsWith('__')) return undefined;
  if (typeof value === 'function') return undefined;
  return value;
};

const getState = () => JSON.parse(JSON.stringify(instance({}).state(), sanitizeReplacer));

const setState = (snapshot) => {
  const merged = deepMerge(INITIAL_STATE, snapshot);
  instance({ initialState: clone(merged) });
};

const init = () => {
  instance({}).state().clearError();
  setState(INITIAL_STATE);
};

const actions = {
  AcquireLock: (data = {}) => acquireLockIntent(data),
  ReleaseLock: (data = {}) => releaseLockIntent(data),
};

const checkerIntents = [
  {
    name: 'AcquireLock',
    intent: actions.AcquireLock,
    values: [
      [{ thread: 0, callType: 'lock' }],
      [{ thread: 0, callType: 'tryLock' }],
      [{ thread: 0, callType: 'try' }],
      [{ thread: 1, callType: 'lock' }],
      [{ thread: 1, callType: 'tryLock' }],
      [{ thread: 1, callType: 'try' }],
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