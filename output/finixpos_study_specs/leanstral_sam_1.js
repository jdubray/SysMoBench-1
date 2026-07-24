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
      (data) => ({ __name: 'INITIATE_PAYMENT', orderId: data.orderId, amountCents: data.amountCents }),
      (data) => ({ __name: 'TRANSFER_CREATED', transferId: data.transferId }),
      () => ({ __name: 'VERIFICATION_STARTED' }),
      (data) => ({ __name: 'TAP_APPROVED', approvedAmount: data.approvedAmount }),
      (data) => ({ __name: 'TAP_DECLINED', declineCode: data.declineCode }),
      (data) => ({ __name: 'PAYMENT_RECORDED', paymentId: data.paymentId }),
      () => ({ __name: 'CANCEL_PAYMENT' }),
      () => ({ __name: 'CANCEL_CONFIRMED' }),
      () => ({ __name: 'EXIT_FLOW' }),
    ],
    acceptors: [
      // Pre-FSM rewrites
      (model) => (proposal) => {
        if (proposal.__name === 'TAP_DECLINED' && model.txState === 'CANCELLING') {
          proposal.__name = 'CANCEL_DECLINED';
        }
      },
      (model) => (proposal) => {
        if (proposal.__name === 'TAP_APPROVED' && model.txState === 'AWAITING_TAP' && typeof proposal.approvedAmount === 'number' && proposal.approvedAmount < (model.amountCents ?? 0)) {
          proposal.__name = 'TAP_DECLINED';
          proposal.declineCode = 'PARTIAL_PAYMENT';
        }
      },

      // FSM acceptors
      (model) => (proposal) => {
        if (proposal.__name === 'INITIATE_PAYMENT' && model.txState === 'IDLE') {
          model.txState = 'INITIATING';
        }
      },
      (model) => (proposal) => {
        if (proposal.__name === 'TRANSFER_CREATED' && model.txState === 'INITIATING') {
          model.txState = 'AWAITING_TAP';
        }
      },
      (model) => (proposal) => {
        if (proposal.__name === 'VERIFICATION_STARTED' && model.txState === 'INITIATING') {
          model.txState = 'AWAITING_VERIFICATION';
        }
      },
      (model) => (proposal) => {
        if (proposal.__name === 'TAP_APPROVED' && model.txState === 'AWAITING_TAP') {
          model.txState = 'RECORDING';
        }
      },
      (model) => (proposal) => {
        if (proposal.__name === 'TAP_DECLINED' && model.txState === 'AWAITING_TAP') {
          model.txState = 'DECLINED';
        }
      },
      (model) => (proposal) => {
        if (proposal.__name === 'CANCEL_PAYMENT' && model.txState === 'AWAITING_TAP') {
          model.txState = 'CANCELLING';
        }
      },
      (model) => (proposal) => {
        if (proposal.__name === 'CANCEL_CONFIRMED' && model.txState === 'CANCELLING') {
          model.txState = 'CANCELLED';
        }
      },
      (model) => (proposal) => {
        if (proposal.__name === 'CANCEL_DECLINED' && model.txState === 'CANCELLING') {
          model.txState = 'CANCELLED';
        }
      },
      (model) => (proposal) => {
        if (proposal.__name === 'TAP_APPROVED' && model.txState === 'CANCELLING') {
          model.txState = 'RECORDING';
        }
      },
      (model) => (proposal) => {
        if (proposal.__name === 'PAYMENT_RECORDED' && model.txState === 'RECORDING') {
          model.txState = 'COMPLETED';
        }
      },
      (model) => (proposal) => {
        if (proposal.__name === 'EXIT_FLOW' && model.txState === 'COMPLETED') {
          model.txState = 'IDLE';
        }
      },
      (model) => (proposal) => {
        if (proposal.__name === 'EXIT_FLOW' && model.txState === 'DECLINED') {
          model.txState = 'IDLE';
        }
      },
      (model) => (proposal) => {
        if (proposal.__name === 'EXIT_FLOW' && model.txState === 'CANCELLED') {
          model.txState = 'IDLE';
        }
      },

      // Apply action data to model
      (model) => (proposal) => {
        if (proposal.__name === 'INITIATE_PAYMENT' && model.txState === 'INITIATING') {
          model.orderId = proposal.orderId;
          model.amountCents = proposal.amountCents;
          model.transferId = null;
          model.declineCode = null;
          model.approvedAmountCents = null;
          model.paymentId = null;
        }
      },
      (model) => (proposal) => {
        if (proposal.__name === 'TRANSFER_CREATED' && model.txState === 'AWAITING_TAP') {
          model.transferId = proposal.transferId;
        }
      },
      (model) => (proposal) => {
        if (proposal.__name === 'TAP_APPROVED' && model.txState === 'RECORDING') {
          model.approvedAmountCents = proposal.approvedAmount;
        }
      },
      (model) => (proposal) => {
        if ((proposal.__name === 'TAP_DECLINED' && model.txState === 'DECLINED') ||
            (proposal.__name === 'CANCEL_DECLINED' && model.txState === 'CANCELLED')) {
          model.declineCode = proposal.declineCode;
        }
      },
      (model) => (proposal) => {
        if (proposal.__name === 'PAYMENT_RECORDED' && model.txState === 'COMPLETED') {
          model.paymentId = proposal.paymentId;
        }
      },
      (model) => (proposal) => {
        if (proposal.__name === 'EXIT_FLOW' && model.txState === 'IDLE') {
          model.orderId = null;
          model.amountCents = null;
          model.transferId = null;
          model.declineCode = null;
          model.approvedAmountCents = null;
          model.paymentId = null;
        }
      },
    ],
    reactors: [
      (model) => () => {
        if (model.txState === 'AWAITING_TAP' && model.transferId) {
          // poll NAP would start here in full implementation
        }
      },
      (model) => () => {
        if (model.txState === 'CANCELLING') {
          // cancel NAP would fire here in full implementation
        }
      },
      (model) => () => {
        if (model.txState === 'RECORDING') {
          // record NAP would fire here in full implementation
        }
      },
    ],
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

const getState = () => JSON.parse(JSON.stringify(instance({}).state(), sanitizeReplacer));

const setState = (snapshot) => { instance({ initialState: clone(snapshot) }); };

const init = () => {
  instance({}).state().clearError();
  setState(INITIAL_STATE);
};

const actions = {
  INITIATE_PAYMENT: (data) => initiatePaymentIntent(data),
  TRANSFER_CREATED: (data) => transferCreatedIntent(data),
  VERIFICATION_STARTED: (data) => verificationStartedIntent(data),
  TAP_APPROVED: (data) => tapApprovedIntent(data),
  TAP_DECLINED: (data) => tapDeclinedIntent(data),
  PAYMENT_RECORDED: (data) => paymentRecordedIntent(data),
  CANCEL_PAYMENT: (data) => cancelPaymentIntent(data),
  CANCEL_CONFIRMED: (data) => cancelConfirmedIntent(data),
  EXIT_FLOW: (data) => exitFlowIntent(data),
};

const checkerIntents = [
  { name: 'INITIATE_PAYMENT', intent: actions.INITIATE_PAYMENT, values: [[{ orderId: 'O1', amountCents: 500 }]] },
  { name: 'INITIATE_PAYMENT', intent: actions.INITIATE_PAYMENT, values: [[{ orderId: 'O1', amountCents: 1000 }]] },
  { name: 'INITIATE_PAYMENT', intent: actions.INITIATE_PAYMENT, values: [[{ orderId: 'O1', amountCents: 1500 }]] },
  { name: 'TRANSFER_CREATED', intent: actions.TRANSFER_CREATED, values: [[{ transferId: 'TR1' }]] },
  { name: 'VERIFICATION_STARTED', intent: actions.VERIFICATION_STARTED, values: [[{ }]] },
  { name: 'TAP_APPROVED', intent: actions.TAP_APPROVED, values: [[{ approvedAmount: 500 }]] },
  { name: 'TAP_APPROVED', intent: actions.TAP_APPROVED, values: [[{ approvedAmount: 1000 }]] },
  { name: 'TAP_DECLINED', intent: actions.TAP_DECLINED, values: [[{ declineCode: 'INSUFFICIENT_FUNDS' }]] },
  { name: 'TAP_DECLINED', intent: actions.TAP_DECLINED, values: [[{ declineCode: 'CANCELLATION_VIA_API' }]] },
  { name: 'TAP_DECLINED', intent: actions.TAP_DECLINED, values: [[{ declineCode: 'CANCELLATION_VIA_DEVICE' }]] },
  { name: 'TAP_DECLINED', intent: actions.TAP_DECLINED, values: [[{ declineCode: 'IMMEDIATE_FAILURE' }]] },
  { name: 'PAYMENT_RECORDED', intent: actions.PAYMENT_RECORDED, values: [[{ paymentId: 'P1' }]] },
  { name: 'PAYMENT_RECORDED', intent: actions.PAYMENT_RECORDED, values: [[{ paymentId: null }]] },
  { name: 'CANCEL_PAYMENT', intent: actions.CANCEL_PAYMENT, values: [[{ }]] },
  { name: 'CANCEL_CONFIRMED', intent: actions.CANCEL_CONFIRMED, values: [[{ }]] },
  { name: 'EXIT_FLOW', intent: actions.EXIT_FLOW, values: [[{ }]] },
];

module.exports = { instance, init, actions, getState, setState, checkerIntents };