/**
 * Hand-written reference JS-SAM specification of the Asterinas spinlock.
 *
 * Follows the SysMoBench module contract:
 *   module.exports = { instance, init, actions, getState, setState, checkerIntents }
 *
 * State shape:
 * BROKEN VARIANT of spin-good.js: ReleaseLock never releases (no-op acceptor).
 * Used to prove distinct-state counting is semantic (differs from spin-good)
 * while stepsExplored is combinatorial (identical to spin-good).
 *   lockHeld     boolean — whether the lock is currently held
 *   lockHolder   number|null — thread id of the holder
 *   threadStatus { [threadId]: 'idle' | 'trying' | 'locked' }
 *   callType     { [threadId]: 'lock' | null } — pending blocking call, if any
 */

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
      ({ thread, callType = 'lock' } = {}) => ({ __name: 'AcquireLock', acquire: { thread, callType } }),
      ({ thread } = {}) => ({ __name: 'ReleaseLock', release: { thread } }),
    ],
    acceptors: [
      (model) => ({ acquire }) => {
        if (acquire == null) return;
        const { thread, callType } = acquire;
        const id = String(thread);
        if (model.threadStatus[id] === undefined) return; // unknown thread
        if (model.threadStatus[id] === 'locked') return; // re-entry is a no-op
        if (!model.lockHeld) {
          // CAS succeeds
          model.lockHeld = true;
          model.lockHolder = thread;
          model.threadStatus[id] = 'locked';
          model.callType[id] = null;
        } else if (callType === 'tryLock') {
          // try_lock() never spins: return to idle immediately
          model.threadStatus[id] = 'idle';
          model.callType[id] = null;
        } else {
          // lock() spins: stay in trying until the lock frees up
          model.threadStatus[id] = 'trying';
          model.callType[id] = 'lock';
        }
      },
      (model) => ({ release }) => {
        // BROKEN (mirrors the Fable comparison spec): release is a no-op — the
        // lock is never freed after the first acquire. Reachable state space is
        // smaller than spin-good's, but the checker's step count is identical
        // because it enumerates the same intent-permutation tree.
        if (release == null) return;
      },
    ],
  },
});

const [acquireIntent, releaseIntent] = intents;

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
  AcquireLock: (data = {}) => acquireIntent(data),
  ReleaseLock: (data = {}) => releaseIntent(data),
};

const checkerIntents = [
  {
    name: 'AcquireLock',
    intent: actions.AcquireLock,
    values: [
      [{ thread: 0, callType: 'lock' }],
      [{ thread: 1, callType: 'lock' }],
      [{ thread: 0, callType: 'tryLock' }],
      [{ thread: 1, callType: 'tryLock' }],
    ],
  },
  {
    name: 'ReleaseLock',
    intent: actions.ReleaseLock,
    values: [[{ thread: 0 }], [{ thread: 1 }]],
  },
];

module.exports = { instance, init, actions, getState, setState, checkerIntents };
