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
  paymentId: null
};

const clone = (value) => JSON.parse(JSON.stringify(value));

const { intents } = instance({
  initialState: clone(INITIAL_STATE),
  component: {
    actions: [
      (data) => ({ __name: 'INITIATE_PAYMENT', orderId: data.orderId, amountCents: data.amountCents }),
      (data) => ({ __name: 'TRANSFER_CREATED', transferId: data.transferId }),
      () => ({ __name: 'VERIFICATION_STARTED' }),
      (data) => ({
        __name: 'TAP_APPROVED',
        approvedAmount: data.approvedAmount,
        cardBrand: null,
        cardLastFour: null,
        approvalCode: null,
        entryMode: null,
        tipAmountCents: 0
      }),
      (data) => ({ __name: 'TAP_DECLINED', declineCode: data.declineCode, declineMessage: null }),
      () => ({ __name: 'CANCEL_DECLINED' }),
      (data) => ({ __name: 'PAYMENT_RECORDED', paymentId: data.paymentId }),
      () => ({ __name: 'CANCEL_PAYMENT' }),
      () => ({ __name: 'CANCEL_CONFIRMED' }),
      () => ({ __name: 'EXIT_FLOW' })
    ],
    acceptors: [
      // Pre-FSM rewrites
      (model) => (proposal) => {
        const action = proposal.__name;

        // CANCELLING + TAP_DECLINED → rewrite to CANCEL_DECLINED
        if (action === 'TAP_DECLINED' && model.txState === 'CANCELLING') {
          proposal.__name = 'CANCEL_DECLINED';
          return;
        }

        // Partial payment rejection
        if (action === 'TAP_APPROVED' &&
            model.txState === 'AWAITING_TAP' &&
            typeof proposal.approvedAmount === 'number' &&
            proposal.approvedAmount < (model.amountCents || 0)) {
          proposal.__name = 'TAP_DECLINED';
          proposal.declineCode = 'PARTIAL_PAYMENT';
        }
      },

      // FSM state transitions
      (model) => (proposal) => {
        const action = proposal.__name;

        if (action === 'INITIATE_PAYMENT' && model.txState === 'IDLE') {
          model.txState = 'INITIATING';
          return;
        }

        if (action === 'TRANSFER_CREATED' && model.txState === 'INITIATING') {
          model.txState = 'AWAITING_TAP';
          return;
        }

        if (action === 'VERIFICATION_STARTED' && model.txState === 'INITIATING') {
          model.txState = 'AWAITING_VERIFICATION';
          return;
        }

        if (action === 'TAP_APPROVED' && (model.txState === 'AWAITING_TAP' || model.txState === 'AWAITING_VERIFICATION')) {
          model.txState = 'RECORDING';
          return;
        }

        if (action === 'TAP_DECLINED' && (model.txState === 'INITIATING' || model.txState === 'AWAITING_TAP' || model.txState === 'AWAITING_VERIFICATION')) {
          model.txState = 'DECLINED';
          return;
        }

        if (action === 'CANCEL_DECLINED' && model.txState === 'CANCELLING') {
          model.txState = 'CANCELLED';
          return;
        }

        if (action === 'PAYMENT_RECORDED' && model.txState === 'RECORDING') {
          model.txState = 'COMPLETED';
          return;
        }

        if (action === 'CANCEL_PAYMENT' && (model.txState === 'INITIATING' || model.txState === 'AWAITING_TAP')) {
          model.txState = 'CANCELLING';
          return;
        }

        if (action === 'CANCEL_CONFIRMED' && model.txState === 'CANCELLING') {
          model.txState = 'CANCELLED';
          return;
        }

        if (action === 'TAP_APPROVED' && model.txState === 'CANCELLING') {
          model.txState = 'RECORDING';
          return;
        }

        if (action === 'EXIT_FLOW' && (model.txState === 'COMPLETED' || model.txState === 'DECLINED' || model.txState === 'CANCELLED')) {
          model.txState = 'IDLE';
          return;
        }
      },

      // Apply action data to model
      (model) => (proposal) => {
        const action = proposal.__name;

        if (action === 'INITIATE_PAYMENT' && model.txState === 'INITIATING') {
          model.orderId = proposal.orderId;
          model.amountCents = proposal.amountCents;
          model.transferId = null;
          model.declineCode = null;
          model.approvedAmountCents = null;
          model.paymentId = null;
        }

        if (action === 'TRANSFER_CREATED' && model.txState === 'AWAITING_TAP') {
          model.transferId = proposal.transferId;
        }

        if (action === 'TAP_APPROVED' && model.txState === 'RECORDING') {
          model.approvedAmountCents = proposal.approvedAmount;
        }

        if ((action === 'TAP_DECLINED' && model.txState === 'DECLINED') ||
            (action === 'CANCEL_DECLINED' && model.txState === 'CANCELLED')) {
          model.declineCode = proposal.declineCode || null;
        }

        if (action === 'PAYMENT_RECORDED' && model.txState === 'COMPLETED') {
          model.paymentId = proposal.paymentId;
        }

        if (action === 'EXIT_FLOW' && model.txState === 'IDLE') {
          model.orderId = null;
          model.amountCents = null;
          model.transferId = null;
          model.declineCode = null;
          model.approvedAmountCents = null;
          model.paymentId = null;
        }
      }
    ],
    reactors: [
      (model) => () => {
        // Anti-glitch: silently discard TAP_APPROVED/TAP_DECLINED in RECORDING/COMPLETED
        if ((model.txState === 'RECORDING' || model.txState === 'COMPLETED') &&
            (instance({}).state().getProposal()?.__name === 'TAP_APPROVED' ||
             instance({}).state().getProposal()?.__name === 'TAP_DECLINED')) {
          instance({}).state().clearProposal();
        }
      }
    ]
  }
});

const [
  initiatePaymentIntent,
  transferCreatedIntent,
  verificationStartedIntent,
  tapApprovedIntent,
  tapDeclinedIntent,
  cancelDeclinedIntent,
  paymentRecordedIntent,
  cancelPaymentIntent,
  cancelConfirmedIntent,
  exitFlowIntent
] = intents;

const sanitizeReplacer = (key, value) => {
  if (typeof key === 'string' && key.startsWith('__')) return undefined;
  if (typeof value === 'function') return undefined;
  return value;
};

const getState = () => {
  const state = instance({}).state();
  return {
    txState: state.txState,
    orderId: state.orderId,
    amountCents: state.amountCents,
    transferId: state.transferId,
    declineCode: state.declineCode,
    approvedAmountCents: state.approvedAmountCents,
    paymentId: state.paymentId
  };
};

const setState = (snapshot) => {
  const fullState = {
    ...clone(INITIAL_STATE),
    ...snapshot,
    txState: snapshot.txState
  };
  instance({ initialState: fullState });
};

const init = () => {
  instance({}).state().clearError();
  setState(INITIAL_STATE);
};

const actions = {
  INITIATE_PAYMENT: (data) => initiatePaymentIntent({ orderId: data.orderId, amountCents: data.amountCents }),
  TRANSFER_CREATED: (data) => transferCreatedIntent({ transferId: data.transferId }),
  VERIFICATION_STARTED: () => verificationStartedIntent({}),
  TAP_APPROVED: (data) => tapApprovedIntent({ approvedAmount: data.approvedAmount }),
  TAP_DECLINED: (data) => tapDeclinedIntent({ declineCode: data.declineCode }),
  CANCEL_DECLINED: () => cancelDeclinedIntent({}),
  PAYMENT_RECORDED: (data) => paymentRecordedIntent({ paymentId: data.paymentId }),
  CANCEL_PAYMENT: () => cancelPaymentIntent({}),
  CANCEL_CONFIRMED: () => cancelConfirmedIntent({}),
  EXIT_FLOW: () => exitFlowIntent({})
};

const checkerIntents = [
  { name: 'INITIATE_PAYMENT', intent: actions.INITIATE_PAYMENT, values: [
    [{ orderId: 'O1', amountCents: 500 }],
    [{ orderId: 'O2', amountCents: 1000 }]
  ]},
  { name: 'TRANSFER_CREATED', intent: actions.TRANSFER_CREATED, values: [
    [{ transferId: 'TR1' }],
    [{ transferId: 'TR2' }]
  ]},
  { name: 'VERIFICATION_STARTED', intent: actions.VERIFICATION_STARTED, values: [
    [{}]
  ]},
  { name: 'TAP_APPROVED', intent: actions.TAP_APPROVED, values: [
    [{ approvedAmount: 500 }],
    [{ approvedAmount: 1000 }],
    [{ approvedAmount: 1500 }]
  ]},
  { name: 'TAP_DECLINED', intent: actions.TAP_DECLINED, values: [
    [{ declineCode: 'INSUFFICIENT_FUNDS' }],
    [{ declineCode: 'CANCELLATION_VIA_API' }],
    [{ declineCode: 'CANCELLATION_VIA_DEVICE' }],
    [{ declineCode: 'IMMEDIATE_FAILURE' }],
    [{ declineCode: null }]
  ]},
  { name: 'PAYMENT_RECORDED', intent: actions.PAYMENT_RECORDED, values: [
    [{ paymentId: 'P1' }],
    [{ paymentId: null }]
  ]},
  { name: 'CANCEL_PAYMENT', intent: actions.CANCEL_PAYMENT, values: [
    [{}]
  ]},
  { name: 'CANCEL_CONFIRMED', intent: actions.CANCEL_CONFIRMED, values: [
    [{}]
  ]},
  { name: 'EXIT_FLOW', intent: actions.EXIT_FLOW, values: [
    [{}]
  ]}
];

module.exports = { instance, init, actions, getState, setState, checkerIntents };