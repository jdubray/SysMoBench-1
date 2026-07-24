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
      (data) => ({ __name: 'INITIATE_PAYMENT', ...data }),
      (data) => ({ __name: 'TRANSFER_CREATED', ...data }),
      (data) => ({ __name: 'VERIFICATION_STARTED', ...data }),
      (data) => ({ __name: 'TAP_APPROVED', ...data }),
      (data) => ({ __name: 'TAP_DECLINED', ...data }),
      (data) => ({ __name: 'PAYMENT_RECORDED', ...data }),
      (data) => ({ __name: 'CANCEL_PAYMENT', ...data }),
      (data) => ({ __name: 'CANCEL_CONFIRMED', ...data }),
      (data) => ({ __name: 'EXIT_FLOW', ...data }),
    ],
    acceptors: [
      // Pre-FSM rewrites
      (model) => (proposal) => {
        if (proposal.__name === 'TAP_DECLINED' && model.txState === 'CANCELLING') {
          proposal.__name = 'CANCEL_DECLINED';
        }
      },
      (model) => (proposal) => {
        if (
          proposal.__name === 'TAP_APPROVED' &&
          model.txState === 'AWAITING_TAP' &&
          typeof proposal.approvedAmount === 'number' &&
          proposal.approvedAmount < (model.amountCents ?? 0)
        ) {
          proposal.__name = 'TAP_DECLINED';
          proposal.declineCode = 'PARTIAL_PAYMENT';
          proposal.declineMessage =
            `Card authorized $${(proposal.approvedAmount / 100).toFixed(2)} but order total is ` +
            `$${(model.amountCents / 100).toFixed(2)} — partial payments not accepted`;
        }
      },

      // FSM state-machine acceptors
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
          model.approvedAmountCents = typeof proposal.approvedAmount === 'number' ? proposal.approvedAmount : null;
        }
        if ((action === 'TAP_DECLINED' && model.txState === 'DECLINED') ||
            (action === 'CANCEL_DECLINED' && model.txState === 'CANCELLED')) {
          model.declineCode = proposal.declineCode;
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
      },

      // FSM state machine
      (model) => (proposal) => {
        const action = proposal.__name;
        const transitions = {
          IDLE: { INITIATE_PAYMENT: 'INITIATING' },
          INITIATING: { TRANSFER_CREATED: 'AWAITING_TAP', VERIFICATION_STARTED: 'AWAITING_VERIFICATION', TAP_DECLINED: 'DECLINED', CANCEL_PAYMENT: 'CANCELLING' },
          AWAITING_TAP: { TAP_APPROVED: 'RECORDING', TAP_DECLINED: 'DECLINED', CANCEL_PAYMENT: 'CANCELLING' },
          AWAITING_VERIFICATION: { TAP_APPROVED: 'RECORDING', TAP_DECLINED: 'DECLINED' },
          PROCESSING: {},
          RECORDING: { PAYMENT_RECORDED: 'COMPLETED' },
          COMPLETED: { EXIT_FLOW: 'IDLE' },
          DECLINED: { EXIT_FLOW: 'IDLE' },
          CANCELLING: { CANCEL_CONFIRMED: 'CANCELLED', TAP_APPROVED: 'RECORDING', CANCEL_DECLINED: 'CANCELLED' },
          CANCELLED: { EXIT_FLOW: 'IDLE' },
        };
        const stateTransitions = transitions[model.txState];
        if (stateTransitions && stateTransitions[action]) {
          model.txState = stateTransitions[action];
        }
      },
    ],
    reactors: [
      // Dehydrate on every state change
      (model) => () => {
        // no-op: observable state is maintained in the model
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

const setState = (snapshot) => {
  instance({ initialState: clone(snapshot) });
};

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
  { name: 'TRANSFER_CREATED', intent: actions.TRANSFER_CREATED, values: [[{ transferId: 'TR1' }]] },
  { name: 'VERIFICATION_STARTED', intent: actions.VERIFICATION_STARTED, values: [[{ }]] },
  { name: 'TAP_APPROVED', intent: actions.TAP_APPROVED, values: [[{ approvedAmount: 500 }]] },
  { name: 'TAP_DECLINED', intent: actions.TAP_DECLINED, values: [[{ declineCode: 'INSUFFICIENT_FUNDS' }], [{ declineCode: 'CANCELLATION_VIA_API' }], [{ declineCode: 'CANCELLATION_VIA_DEVICE' }], [{ declineCode: 'IMMEDIATE_FAILURE' }]] },
  { name: 'PAYMENT_RECORDED', intent: actions.PAYMENT_RECORDED, values: [[{ paymentId: 'P1' }], [{ paymentId: null }]] },
  { name: 'CANCEL_PAYMENT', intent: actions.CANCEL_PAYMENT, values: [[{ }]] },
  { name: 'CANCEL_CONFIRMED', intent: actions.CANCEL_CONFIRMED, values: [[{ }]] },
  { name: 'EXIT_FLOW', intent: actions.EXIT_FLOW, values: [[{ }]] },
];

module.exports = { instance, init, actions, getState, setState, checkerIntents };