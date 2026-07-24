/**
 * Hand-written reference JS-SAM spec of the finixpos payment workflow.
 * Positive control for the study (docs/finixpos_study_plan.md §4).
 * Follows the module contract in tla_eval/tasks/finixpos/prompts/js-sam/direct_call.txt.
 */

'use strict';

const { createInstance } = require('@cognitive-fab/sam-pattern');

const instance = createInstance({ instanceName: 'finixpos', hasAsyncActions: false });

const INITIAL_STATE = {
  txState: 'IDLE',
  orderId: null,
  amountCents: null,
  transferId: null,
  declineCode: null,
  approvedAmountCents: null,
  paymentId: null,
};

const clone = (value) => JSON.parse(JSON.stringify(value));

const { intents } = instance({
  initialState: clone(INITIAL_STATE),
  component: {
    actions: [
      (data = {}) => ({ __name: 'INITIATE_PAYMENT', kind: 'INITIATE_PAYMENT',
        orderId: data.orderId, amountCents: data.amountCents }),
      (data = {}) => ({ __name: 'TRANSFER_CREATED', kind: 'TRANSFER_CREATED',
        transferId: data.transferId }),
      () => ({ __name: 'VERIFICATION_STARTED', kind: 'VERIFICATION_STARTED' }),
      (data = {}) => ({ __name: 'TAP_APPROVED', kind: 'TAP_APPROVED',
        approvedAmount: data.approvedAmount }),
      (data = {}) => ({ __name: 'TAP_DECLINED', kind: 'TAP_DECLINED',
        declineCode: data.declineCode ?? null }),
      (data = {}) => ({ __name: 'PAYMENT_RECORDED', kind: 'PAYMENT_RECORDED',
        paymentId: data.paymentId ?? null }),
      () => ({ __name: 'CANCEL_PAYMENT', kind: 'CANCEL_PAYMENT' }),
      () => ({ __name: 'CANCEL_CONFIRMED', kind: 'CANCEL_CONFIRMED' }),
      () => ({ __name: 'EXIT_FLOW', kind: 'EXIT_FLOW' }),
    ],
    acceptors: [
      (model) => (proposal) => {
        const { kind } = proposal;
        if (!kind) return;

        if (kind === 'INITIATE_PAYMENT' && model.txState === 'IDLE') {
          model.txState = 'INITIATING';
          model.orderId = proposal.orderId;
          model.amountCents = proposal.amountCents;
          model.transferId = null;
          model.declineCode = null;
          model.approvedAmountCents = null;
          model.paymentId = null;
          return;
        }

        if (kind === 'TRANSFER_CREATED' && model.txState === 'INITIATING') {
          model.txState = 'AWAITING_TAP';
          model.transferId = proposal.transferId;
          return;
        }

        if (kind === 'VERIFICATION_STARTED' && model.txState === 'INITIATING') {
          model.txState = 'AWAITING_VERIFICATION';
          return;
        }

        if (kind === 'TAP_APPROVED') {
          if (
            model.txState === 'AWAITING_TAP' &&
            typeof proposal.approvedAmount === 'number' &&
            proposal.approvedAmount < (model.amountCents ?? 0)
          ) {
            // Partial-payment guard: pre-FSM rewrite to TAP_DECLINED.
            model.txState = 'DECLINED';
            model.declineCode = 'PARTIAL_PAYMENT';
            return;
          }
          if (['AWAITING_TAP', 'AWAITING_VERIFICATION', 'CANCELLING'].includes(model.txState)) {
            model.txState = 'RECORDING';
            model.approvedAmountCents =
              typeof proposal.approvedAmount === 'number' ? proposal.approvedAmount : null;
          }
          return;
        }

        if (kind === 'TAP_DECLINED') {
          if (['INITIATING', 'AWAITING_TAP', 'AWAITING_VERIFICATION', 'CANCELLING'].includes(model.txState)) {
            model.txState = 'DECLINED';
            model.declineCode = proposal.declineCode ?? null;
          }
          return;
        }

        if (kind === 'PAYMENT_RECORDED' && model.txState === 'RECORDING') {
          model.txState = 'COMPLETED';
          model.paymentId = proposal.paymentId ?? null;
          return;
        }

        if (kind === 'CANCEL_PAYMENT' &&
            ['INITIATING', 'AWAITING_TAP'].includes(model.txState)) {
          model.txState = 'CANCELLING';
          return;
        }

        if (kind === 'CANCEL_CONFIRMED' && model.txState === 'CANCELLING') {
          model.txState = 'CANCELLED';
          return;
        }

        if (kind === 'EXIT_FLOW' &&
            ['COMPLETED', 'DECLINED', 'CANCELLED'].includes(model.txState)) {
          model.txState = 'IDLE';
          model.orderId = null;
          model.amountCents = null;
          model.transferId = null;
          model.declineCode = null;
          model.approvedAmountCents = null;
          model.paymentId = null;
        }
      },
    ],
  },
});

const [
  initiateIntent, transferIntent, verificationIntent, approvedIntent,
  declinedIntent, recordedIntent, cancelIntent, cancelConfirmedIntent, exitIntent,
] = intents;

const sanitizeReplacer = (key, value) => {
  if (typeof key === 'string' && key.startsWith('__')) return undefined;
  if (key === 'kind') return undefined;
  if (typeof value === 'function') return undefined;
  return value;
};

const getState = () => {
  const raw = JSON.parse(JSON.stringify(instance({}).state(), sanitizeReplacer));
  const out = {};
  for (const k of Object.keys(INITIAL_STATE)) out[k] = raw[k] === undefined ? null : raw[k];
  return out;
};

const setState = (snapshot) => { instance({ initialState: clone(snapshot) }); };

const init = () => {
  instance({}).state().clearError();
  setState(INITIAL_STATE);
};

const actions = {
  INITIATE_PAYMENT: (data = {}) => initiateIntent(data),
  TRANSFER_CREATED: (data = {}) => transferIntent(data),
  VERIFICATION_STARTED: (data = {}) => verificationIntent(data),
  TAP_APPROVED: (data = {}) => approvedIntent(data),
  TAP_DECLINED: (data = {}) => declinedIntent(data),
  PAYMENT_RECORDED: (data = {}) => recordedIntent(data),
  CANCEL_PAYMENT: (data = {}) => cancelIntent(data),
  CANCEL_CONFIRMED: (data = {}) => cancelConfirmedIntent(data),
  EXIT_FLOW: (data = {}) => exitIntent(data),
};

const checkerIntents = [
  { name: 'INITIATE_PAYMENT', intent: actions.INITIATE_PAYMENT,
    values: [[{ orderId: 'O1', amountCents: 1000 }]] },
  { name: 'TRANSFER_CREATED', intent: actions.TRANSFER_CREATED,
    values: [[{ transferId: 'TR1' }]] },
  { name: 'VERIFICATION_STARTED', intent: actions.VERIFICATION_STARTED, values: [[{}]] },
  { name: 'TAP_APPROVED', intent: actions.TAP_APPROVED,
    values: [[{ approvedAmount: 1000 }], [{ approvedAmount: 500 }], [{ approvedAmount: 1500 }]] },
  { name: 'TAP_DECLINED', intent: actions.TAP_DECLINED,
    values: [[{ declineCode: 'INSUFFICIENT_FUNDS' }], [{ declineCode: 'CANCELLATION_VIA_DEVICE' }],
             [{ declineCode: 'IMMEDIATE_FAILURE' }], [{ declineCode: null }]] },
  { name: 'PAYMENT_RECORDED', intent: actions.PAYMENT_RECORDED,
    values: [[{ paymentId: 'P1' }], [{ paymentId: null }]] },
  { name: 'CANCEL_PAYMENT', intent: actions.CANCEL_PAYMENT, values: [[{}]] },
  { name: 'CANCEL_CONFIRMED', intent: actions.CANCEL_CONFIRMED, values: [[{}]] },
  { name: 'EXIT_FLOW', intent: actions.EXIT_FLOW, values: [[{}]] },
];

module.exports = { instance, init, actions, getState, setState, checkerIntents };
