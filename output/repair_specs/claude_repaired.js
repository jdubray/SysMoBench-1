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

const { intents } = instance({
  initialState: clone(INITIAL_STATE),
  component: {
    actions: [
      (data = {}) => ({
        __name: 'AcquireLock',
        acquire: true,
        thread: data.thread,
        callType: data.callType,
      }),
      (data = {}) => ({
        __name: 'ReleaseLock',
        release: true,
        thread: data.thread,
      }),
    ],
    acceptors: [
      // AcquireLock: models the atomic CAS as a single synchronized step.
      (model) => ({ acquire, thread, callType }) => {
        if (!acquire) return;
        if (thread !== 0 && thread !== 1) return;

        // Normalize call types: both 'try' and 'tryLock' are non-blocking
        // attempts; 'lock' is the blocking variant.
        const isTry = callType === 'tryLock' || callType === 'try';
        const isBlocking = callType === 'lock';
        if (!isTry && !isBlocking) return;

        // A thread that already holds the lock cannot re-acquire it.
        if (model.threadStatus[thread] === 'locked') return;

        if (!model.lockHeld) {
          // CAS(false -> true) succeeds: acquire the lock.
          model.lockHeld = true;
          model.lockHolder = thread;
          model.threadStatus[thread] = 'locked';
          model.callType[thread] = null;
        } else {
          // CAS fails: lock is currently held by someone else.
          if (isBlocking) {
            // Blocking: remain (or enter) 'trying' and keep spinning.
            model.threadStatus[thread] = 'trying';
            model.callType[thread] = 'lock';
          } else {
            // Non-blocking try_lock: return to 'idle' immediately.
            model.threadStatus[thread] = 'idle';
            model.callType[thread] = null;
          }
        }
      },
      // ReleaseLock: release by a non-holder is a no-op (never throws).
      (model) => ({ release, thread }) => {
        if (!release) return;
        if (thread !== 0 && thread !== 1) return;
        if (!model.lockHeld) return;
        if (model.lockHolder !== thread) return;

        model.lockHeld = false;
        model.lockHolder = null;
        model.threadStatus[thread] = 'idle';
        model.callType[thread] = null;
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

const setState = (snapshot) => { instance({ initialState: clone(snapshot) }); };

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