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
      () => ({ __name: 'AcquireLock', acquireLock: true }),
      () => ({ __name: 'ReleaseLock', releaseLock: true }),
    ],
    acceptors: [
      (model) => ({ acquireLock, thread, callType }) => {
        if (!acquireLock || thread === undefined || callType === undefined) return;

        // If lock is free, acquire it immediately
        if (!model.lockHeld) {
          model.lockHeld = true;
          model.lockHolder = thread;
          model.threadStatus[thread] = 'locked';
          model.callType[thread] = null;
          return;
        }

        // Lock is held by someone else
        if (callType === 'lock') {
          // Blocking call: transition to 'trying' state (will spin/retry)
          model.threadStatus[thread] = 'trying';
          model.callType[thread] = 'lock';
        } else if (callType === 'tryLock' || callType === 'try') {
          // Non-blocking call: return to 'idle' immediately (no retry)
          model.threadStatus[thread] = 'idle';
          model.callType[thread] = null;
        }
      },
      (model) => ({ releaseLock, thread }) => {
        if (!releaseLock || thread === undefined) return;

        // Only the lock holder can release
        if (model.lockHolder === thread && model.lockHeld) {
          model.lockHeld = false;
          model.lockHolder = null;
          model.threadStatus[thread] = 'idle';
          model.callType[thread] = null;
        }
      },
    ],
    reactors: [
      (model) => () => {
        // Reactor: if a thread is in 'trying' state (spinning on lock()),
        // it will automatically retry on the next step.
        // This models the spin loop behavior.
      },
    ],
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
  instance({ initialState: clone(snapshot) });
};

const init = () => {
  instance({}).state().clearError();
  setState(INITIAL_STATE);
};

const actions = {
  AcquireLock: (data = {}) => {
    acquireLockIntent(data);
    return getState();
  },
  ReleaseLock: (data = {}) => {
    releaseLockIntent(data);
    return getState();
  },
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