'use strict';

const { createInstance } = require('@cognitive-fab/sam-pattern');

const instance = createInstance({ instanceName: 'finixpos', hasAsyncActions: false });

// txState: 'IDLE' | 'INITIATING' | 'AWAITING_TAP' | 'AWAITING_VERIFICATION'
//        | 'RECORDING' | 'COMPLETED' | 'DECLINED' | 'CANCELLING' | 'CANCELLED'
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
      // INITIATE_PAYMENT
      (data = {}) => ({
        __name: 'INITIATE_PAYMENT',
        __actionName: 'INITIATE_PAYMENT',
        orderId: data.orderId,
        amountCents: data.amountCents,
      }),
      // TRANSFER_CREATED
      (data = {}) => ({
        __name: 'TRANSFER_CREATED',
        __actionName: 'TRANSFER_CREATED',
        transferId: data.transferId,
      }),
      // VERIFICATION_STARTED
      () => ({ __name: 'VERIFICATION_STARTED', __actionName: 'VERIFICATION_STARTED' }),
      // TAP_APPROVED
      (data = {}) => ({
        __name: 'TAP_APPROVED',
        __actionName: 'TAP_APPROVED',
        approvedAmount: data.approvedAmount,
      }),
      // TAP_DECLINED
      (data = {}) => ({
        __name: 'TAP_DECLINED',
        __actionName: 'TAP_DECLINED',
        declineCode: data.declineCode !== undefined ? data.declineCode : null,
      }),
      // PAYMENT_RECORDED
      (data = {}) => ({
        __name: 'PAYMENT_RECORDED',
        __actionName: 'PAYMENT_RECORDED',
        paymentId: data.paymentId !== undefined ? data.paymentId : null,
      }),
      // CANCEL_PAYMENT
      () => ({ __name: 'CANCEL_PAYMENT', __actionName: 'CANCEL_PAYMENT' }),
      // CANCEL_CONFIRMED
      () => ({ __name: 'CANCEL_CONFIRMED', __actionName: 'CANCEL_CONFIRMED' }),
      // EXIT_FLOW
      () => ({ __name: 'EXIT_FLOW', __actionName: 'EXIT_FLOW' }),
    ],

    acceptors: [
      // ── Pre-FSM rewrites ──────────────────────────────────────────────────
      // 1. CANCELLING + TAP_DECLINED → CANCEL_DECLINED (routes to CANCELLED)
      // 2. AWAITING_TAP + TAP_APPROVED with approvedAmount < amountCents
      //    → partial-payment rewrite to TAP_DECLINED (declineCode PARTIAL_PAYMENT)
      (model) => (proposal) => {
        const action = proposal.__actionName;

        if (action === 'TAP_DECLINED' && model.txState === 'CANCELLING') {
          proposal.__actionName = 'CANCEL_DECLINED';
          return;
        }

        if (
          action === 'TAP_APPROVED' &&
          model.txState === 'AWAITING_TAP' &&
          typeof proposal.approvedAmount === 'number' &&
          proposal.approvedAmount < (model.amountCents == null ? 0 : model.amountCents)
        ) {
          proposal.__actionName = 'TAP_DECLINED';
          proposal.declineCode = 'PARTIAL_PAYMENT';
        }
      },

      // ── FSM transition acceptor (deterministic, guarded) ─────────────────
      // Advances txState only from a valid source state; otherwise no-op.
      (model) => (proposal) => {
        const action = proposal.__actionName;

        switch (action) {
          case 'INITIATE_PAYMENT':
            if (model.txState === 'IDLE') model.txState = 'INITIATING';
            break;
          case 'TRANSFER_CREATED':
            if (model.txState === 'INITIATING') model.txState = 'AWAITING_TAP';
            break;
          case 'VERIFICATION_STARTED':
            if (model.txState === 'INITIATING') model.txState = 'AWAITING_VERIFICATION';
            break;
          case 'TAP_APPROVED':
            if (
              model.txState === 'AWAITING_TAP' ||
              model.txState === 'AWAITING_VERIFICATION' ||
              model.txState === 'CANCELLING'
            ) {
              model.txState = 'RECORDING';
            }
            break;
          case 'TAP_DECLINED':
            if (
              model.txState === 'INITIATING' ||
              model.txState === 'AWAITING_TAP' ||
              model.txState === 'AWAITING_VERIFICATION'
            ) {
              model.txState = 'DECLINED';
            }
            break;
          case 'CANCEL_DECLINED':
            if (model.txState === 'CANCELLING') model.txState = 'CANCELLED';
            break;
          case 'PAYMENT_RECORDED':
            if (model.txState === 'RECORDING') model.txState = 'COMPLETED';
            break;
          case 'CANCEL_PAYMENT':
            if (model.txState === 'INITIATING' || model.txState === 'AWAITING_TAP') {
              model.txState = 'CANCELLING';
            }
            break;
          case 'CANCEL_CONFIRMED':
            if (model.txState === 'CANCELLING') model.txState = 'CANCELLED';
            break;
          case 'EXIT_FLOW':
            if (
              model.txState === 'COMPLETED' ||
              model.txState === 'DECLINED' ||
              model.txState === 'CANCELLED'
            ) {
              model.txState = 'IDLE';
            }
            break;
          default:
            break;
        }
      },

      // ── Apply action data to model (guarded by post-transition txState) ──
      (model) => (proposal) => {
        const action = proposal.__actionName;

        if (action === 'INITIATE_PAYMENT' && model.txState === 'INITIATING') {
          model.orderId = proposal.orderId != null ? proposal.orderId : null;
          model.amountCents = typeof proposal.amountCents === 'number' ? proposal.amountCents : null;
          model.transferId = null;
          model.declineCode = null;
          model.approvedAmountCents = null;
          model.paymentId = null;
        }

        if (action === 'TRANSFER_CREATED' && model.txState === 'AWAITING_TAP') {
          model.transferId = proposal.transferId != null ? proposal.transferId : null;
        }

        if (action === 'TAP_APPROVED' && model.txState === 'RECORDING') {
          model.approvedAmountCents =
            typeof proposal.approvedAmount === 'number' ? proposal.approvedAmount : null;
        }

        if (
          (action === 'TAP_DECLINED' && model.txState === 'DECLINED') ||
          (action === 'CANCEL_DECLINED' && model.txState === 'CANCELLED')
        ) {
          model.declineCode = proposal.declineCode != null ? proposal.declineCode : null;
        }

        if (action === 'PAYMENT_RECORDED' && model.txState === 'COMPLETED') {
          model.paymentId = proposal.paymentId != null ? proposal.paymentId : null;
        }

        if (action === 'EXIT_FLOW' && model.txState === 'IDLE') {
          model.orderId = null;
          model.amountCents = null;
          model.transferId = null;
          model.declineCode = null;
          model.approvedAmountCents = null;
          model.paymentId = null;
        }
      },
    ],

    reactors: [],

    options: {
      ignoreOutdatedProposals: true,
    },
  },
});

const [
  initiatePaymentIntent,
  transferCreatedIntent,
  verificationStartedIntent,
  tapApprovedIntent,
  tapDeclinedIntent,
  paymentRecordedIntent,
  cancelPaymentIntent,
  cancelConfirmedIntent,
  exitFlowIntent,
] = intents;

const OBSERVABLE_KEYS = [
  'txState',
  'orderId',
  'amountCents',
  'transferId',
  'declineCode',
  'approvedAmountCents',
  'paymentId',
];

const sanitizeReplacer = (key, value) => {
  if (typeof key === 'string' && key.startsWith('__')) return undefined;
  if (typeof value === 'function') return undefined;
  return value;
};

const getState = () => {
  const raw = JSON.parse(JSON.stringify(instance({}).state(), sanitizeReplacer));
  const out = {};
  for (const k of OBSERVABLE_KEYS) {
    out[k] = raw[k] !== undefined ? raw[k] : null;
  }
  return out;
};

const setState = (snapshot) => {
  instance({ initialState: clone(snapshot) });
};

const init = () => {
  instance({}).state().clearError();
  setState(INITIAL_STATE);
};

const actions = {
  INITIATE_PAYMENT: (data = {}) => initiatePaymentIntent(data),
  TRANSFER_CREATED: (data = {}) => transferCreatedIntent(data),
  VERIFICATION_STARTED: (data = {}) => verificationStartedIntent(data),
  TAP_APPROVED: (data = {}) => tapApprovedIntent(data),
  TAP_DECLINED: (data = {}) => tapDeclinedIntent(data),
  PAYMENT_RECORDED: (data = {}) => paymentRecordedIntent(data),
  CANCEL_PAYMENT: (data = {}) => cancelPaymentIntent(data),
  CANCEL_CONFIRMED: (data = {}) => cancelConfirmedIntent(data),
  EXIT_FLOW: (data = {}) => exitFlowIntent(data),
};

const checkerIntents = [
  {
    name: 'INITIATE_PAYMENT',
    intent: actions.INITIATE_PAYMENT,
    values: [
      [{ orderId: 'O1', amountCents: 500 }],
      [{ orderId: 'O1', amountCents: 1000 }],
      [{ orderId: 'O1', amountCents: 1500 }],
    ],
  },
  {
    name: 'TRANSFER_CREATED',
    intent: actions.TRANSFER_CREATED,
    values: [[{ transferId: 'TR1' }]],
  },
  {
    name: 'VERIFICATION_STARTED',
    intent: actions.VERIFICATION_STARTED,
    values: [[{}]],
  },
  {
    name: 'TAP_APPROVED',
    intent: actions.TAP_APPROVED,
    values: [[{ approvedAmount: 1000 }], [{ approvedAmount: 500 }], [{ approvedAmount: 1500 }]],
  },
  {
    name: 'TAP_DECLINED',
    intent: actions.TAP_DECLINED,
    values: [
      [{ declineCode: 'INSUFFICIENT_FUNDS' }],
      [{ declineCode: 'CANCELLATION_VIA_API' }],
      [{ declineCode: 'CANCELLATION_VIA_DEVICE' }],
      [{ declineCode: 'IMMEDIATE_FAILURE' }],
    ],
  },
  {
    name: 'PAYMENT_RECORDED',
    intent: actions.PAYMENT_RECORDED,
    values: [[{ paymentId: 'P1' }], [{ paymentId: null }]],
  },
  {
    name: 'CANCEL_PAYMENT',
    intent: actions.CANCEL_PAYMENT,
    values: [[{}]],
  },
  {
    name: 'CANCEL_CONFIRMED',
    intent: actions.CANCEL_CONFIRMED,
    values: [[{}]],
  },
  {
    name: 'EXIT_FLOW',
    intent: actions.EXIT_FLOW,
    values: [[{}]],
  },
];

module.exports = { instance, init, actions, getState, setState, checkerIntents };