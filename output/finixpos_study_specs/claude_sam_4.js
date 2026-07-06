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

// Allowed transitions per source FSM (deterministic, enforceAllowedTransitions):
//   IDLE                  → INITIATE_PAYMENT
//   INITIATING            → TRANSFER_CREATED | VERIFICATION_STARTED | TAP_DECLINED | CANCEL_PAYMENT
//   AWAITING_TAP          → TAP_APPROVED | TAP_DECLINED | CANCEL_PAYMENT
//   AWAITING_VERIFICATION → TAP_APPROVED | TAP_DECLINED
//   RECORDING             → PAYMENT_RECORDED
//   COMPLETED             → EXIT_FLOW
//   DECLINED              → EXIT_FLOW
//   CANCELLING            → CANCEL_CONFIRMED | TAP_APPROVED | CANCEL_DECLINED(=TAP_DECLINED rewrite)
//   CANCELLED             → EXIT_FLOW

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
      () => ({
        __name: 'VERIFICATION_STARTED',
        __actionName: 'VERIFICATION_STARTED',
      }),
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
        declineCode: data.declineCode === undefined ? null : data.declineCode,
      }),
      // PAYMENT_RECORDED
      (data = {}) => ({
        __name: 'PAYMENT_RECORDED',
        __actionName: 'PAYMENT_RECORDED',
        paymentId: data.paymentId === undefined ? null : data.paymentId,
      }),
      // CANCEL_PAYMENT
      () => ({
        __name: 'CANCEL_PAYMENT',
        __actionName: 'CANCEL_PAYMENT',
      }),
      // CANCEL_CONFIRMED
      () => ({
        __name: 'CANCEL_CONFIRMED',
        __actionName: 'CANCEL_CONFIRMED',
      }),
      // EXIT_FLOW
      () => ({
        __name: 'EXIT_FLOW',
        __actionName: 'EXIT_FLOW',
      }),
    ],

    acceptors: [
      // ── Pre-FSM rewrites (mirror source pre-FSM acceptor) ─────────────────
      (model) => (proposal) => {
        const action = proposal.__actionName;

        // 1. CANCELLING + TAP_DECLINED → CANCEL_DECLINED (→ CANCELLED)
        if (action === 'TAP_DECLINED' && model.txState === 'CANCELLING') {
          proposal.__actionName = 'CANCEL_DECLINED';
          return;
        }

        // 2. Partial-payment rejection: AWAITING_TAP + TAP_APPROVED where
        //    approvedAmount < amountCents → rewrite to TAP_DECLINED (PARTIAL_PAYMENT)
        if (
          action === 'TAP_APPROVED' &&
          model.txState === 'AWAITING_TAP' &&
          typeof proposal.approvedAmount === 'number' &&
          proposal.approvedAmount < (model.amountCents === null ? 0 : model.amountCents)
        ) {
          proposal.__actionName = 'TAP_DECLINED';
          proposal.declineCode = 'PARTIAL_PAYMENT';
        }
      },

      // ── FSM state-machine advance (deterministic, enforced transitions) ───
      (model) => (proposal) => {
        const action = proposal.__actionName;
        const s = model.txState;

        switch (action) {
          case 'INITIATE_PAYMENT':
            if (s === 'IDLE') model.txState = 'INITIATING';
            break;
          case 'TRANSFER_CREATED':
            if (s === 'INITIATING') model.txState = 'AWAITING_TAP';
            break;
          case 'VERIFICATION_STARTED':
            if (s === 'INITIATING') model.txState = 'AWAITING_VERIFICATION';
            break;
          case 'TAP_APPROVED':
            if (s === 'AWAITING_TAP' || s === 'AWAITING_VERIFICATION' || s === 'CANCELLING') {
              model.txState = 'RECORDING';
            }
            break;
          case 'TAP_DECLINED':
            if (s === 'INITIATING' || s === 'AWAITING_TAP' || s === 'AWAITING_VERIFICATION') {
              model.txState = 'DECLINED';
            }
            break;
          case 'CANCEL_DECLINED':
            if (s === 'CANCELLING') model.txState = 'CANCELLED';
            break;
          case 'PAYMENT_RECORDED':
            if (s === 'RECORDING') model.txState = 'COMPLETED';
            break;
          case 'CANCEL_PAYMENT':
            if (s === 'INITIATING' || s === 'AWAITING_TAP') model.txState = 'CANCELLING';
            break;
          case 'CANCEL_CONFIRMED':
            if (s === 'CANCELLING') model.txState = 'CANCELLED';
            break;
          case 'EXIT_FLOW':
            if (s === 'COMPLETED' || s === 'DECLINED' || s === 'CANCELLED') {
              model.txState = 'IDLE';
            }
            break;
          default:
            break;
        }
      },

      // ── Apply action data — guarded by expected post-transition txState ───
      (model) => (proposal) => {
        const action = proposal.__actionName;

        if (action === 'INITIATE_PAYMENT' && model.txState === 'INITIATING') {
          model.orderId = proposal.orderId === undefined ? null : proposal.orderId;
          model.amountCents = proposal.amountCents === undefined ? null : proposal.amountCents;
          model.transferId = null;
          model.approvedAmountCents = null;
          model.paymentId = null;
          model.declineCode = null;
        }

        if (action === 'TRANSFER_CREATED' && model.txState === 'AWAITING_TAP') {
          model.transferId = proposal.transferId === undefined ? null : proposal.transferId;
        }

        if (action === 'TAP_APPROVED' && model.txState === 'RECORDING') {
          model.approvedAmountCents =
            typeof proposal.approvedAmount === 'number' ? proposal.approvedAmount : null;
        }

        if (
          (action === 'TAP_DECLINED' && model.txState === 'DECLINED') ||
          (action === 'CANCEL_DECLINED' && model.txState === 'CANCELLED')
        ) {
          model.declineCode = proposal.declineCode === undefined ? null : proposal.declineCode;
        }

        if (action === 'PAYMENT_RECORDED' && model.txState === 'COMPLETED') {
          model.paymentId = proposal.paymentId === undefined ? null : proposal.paymentId;
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

const sanitizeReplacer = (key, value) => {
  if (typeof key === 'string' && key.startsWith('__')) return undefined;
  if (typeof value === 'function') return undefined;
  return value;
};

const getState = () => {
  const raw = JSON.parse(JSON.stringify(instance({}).state(), sanitizeReplacer));
  return {
    txState: raw.txState,
    orderId: raw.orderId === undefined ? null : raw.orderId,
    amountCents: raw.amountCents === undefined ? null : raw.amountCents,
    transferId: raw.transferId === undefined ? null : raw.transferId,
    declineCode: raw.declineCode === undefined ? null : raw.declineCode,
    approvedAmountCents: raw.approvedAmountCents === undefined ? null : raw.approvedAmountCents,
    paymentId: raw.paymentId === undefined ? null : raw.paymentId,
  };
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
    values: [
      [{ approvedAmount: 500 }],
      [{ approvedAmount: 1000 }],
      [{ approvedAmount: 1500 }],
    ],
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