'use strict';

const { createInstance } = require('@cognitive-fab/sam-pattern');

const instance = createInstance({ instanceName: 'finixpos', hasAsyncActions: false });

// Observable state keys only
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
      // INITIATE_PAYMENT: data: { orderId: string, amountCents: number }
      (data) => ({ __name: 'INITIATE_PAYMENT', ...data }),
      // TRANSFER_CREATED: data: { transferId: string }
      (data) => ({ __name: 'TRANSFER_CREATED', ...data }),
      // VERIFICATION_STARTED: data: {}
      (data) => ({ __name: 'VERIFICATION_STARTED', ...data }),
      // TAP_APPROVED: data: { approvedAmount: number }
      (data) => ({ __name: 'TAP_APPROVED', ...data }),
      // TAP_DECLINED: data: { declineCode: string|null }
      (data) => ({ __name: 'TAP_DECLINED', ...data }),
      // PAYMENT_RECORDED: data: { paymentId: string|null }
      (data) => ({ __name: 'PAYMENT_RECORDED', ...data }),
      // CANCEL_PAYMENT: data: {}
      (data) => ({ __name: 'CANCEL_PAYMENT', ...data }),
      // CANCEL_CONFIRMED: data: {}
      (data) => ({ __name: 'CANCEL_CONFIRMED', ...data }),
      // EXIT_FLOW: data: {}
      (data) => ({ __name: 'EXIT_FLOW', ...data }),
    ],
    acceptors: [
      // Pre-FSM: CANCELLING + TAP_DECLINED → CANCEL_DECLINED
      (model) => (proposal) => {
        if (proposal.__name === 'TAP_DECLINED' && model.txState === 'CANCELLING') {
          proposal.__name = 'CANCEL_DECLINED';
        }
      },

      // FSM acceptors (from terminalPaymentFSM)
      (model) => (proposal) => {
        // INITIATE_PAYMENT only from IDLE
        if (proposal.__name === 'INITIATE_PAYMENT' && model.txState === 'IDLE') {
          model.txState = 'INITIATING';
        }
      },
      (model) => (proposal) => {
        // TRANSFER_CREATED only from INITIATING
        if (proposal.__name === 'TRANSFER_CREATED' && model.txState === 'INITIATING') {
          model.txState = 'AWAITING_TAP';
        }
      },
      (model) => (proposal) => {
        // VERIFICATION_STARTED only from INITIATING
        if (proposal.__name === 'VERIFICATION_STARTED' && model.txState === 'INITIATING') {
          model.txState = 'AWAITING_VERIFICATION';
        }
      },
      (model) => (proposal) => {
        // TAP_APPROVED from AWAITING_TAP or AWAITING_VERIFICATION
        if (proposal.__name === 'TAP_APPROVED' && (model.txState === 'AWAITING_TAP' || model.txState === 'AWAITING_VERIFICATION')) {
          model.txState = 'RECORDING';
        }
      },
      (model) => (proposal) => {
        // TAP_DECLINED from AWAITING_TAP or AWAITING_VERIFICATION
        if (proposal.__name === 'TAP_DECLINED' && (model.txState === 'AWAITING_TAP' || model.txState === 'AWAITING_VERIFICATION')) {
          model.txState = 'DECLINED';
        }
      },
      (model) => (proposal) => {
        // CANCEL_DECLINED from CANCELLING
        if (proposal.__name === 'CANCEL_DECLINED' && model.txState === 'CANCELLING') {
          model.txState = 'CANCELLED';
        }
      },
      (model) => (proposal) => {
        // PAYMENT_RECORDED from RECORDING
        if (proposal.__name === 'PAYMENT_RECORDED' && model.txState === 'RECORDING') {
          model.txState = 'COMPLETED';
        }
      },
      (model) => (proposal) => {
        // CANCEL_PAYMENT from AWAITING_TAP or RECORDING
        if (proposal.__name === 'CANCEL_PAYMENT' && (model.txState === 'AWAITING_TAP' || model.txState === 'RECORDING')) {
          model.txState = 'CANCELLING';
        }
      },
      (model) => (proposal) => {
        // CANCEL_CONFIRMED from CANCELLING
        if (proposal.__name === 'CANCEL_CONFIRMED' && model.txState === 'CANCELLING') {
          model.txState = 'CANCELLED';
        }
      },
      (model) => (proposal) => {
        // EXIT_FLOW from COMPLETED, DECLINED, or CANCELLED
        if (proposal.__name === 'EXIT_FLOW' && (model.txState === 'COMPLETED' || model.txState === 'DECLINED' || model.txState === 'CANCELLED')) {
          model.txState = 'IDLE';
        }
      },

      // Apply action data to model (post-FSM)
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

        if (action === 'VERIFICATION_STARTED' && model.txState === 'AWAITING_VERIFICATION') {
          // No observable state change
        }

        if (action === 'TAP_APPROVED' && model.txState === 'RECORDING') {
          model.approvedAmountCents = proposal.approvedAmount;
        }

        if (action === 'TAP_DECLINED' && model.txState === 'DECLINED') {
          model.declineCode = proposal.declineCode;
        }

        if (action === 'CANCEL_DECLINED' && model.txState === 'CANCELLED') {
          // No observable state change
        }

        if (action === 'PAYMENT_RECORDED' && model.txState === 'COMPLETED') {
          model.paymentId = proposal.paymentId;
        }

        if (action === 'CANCEL_PAYMENT' && model.txState === 'CANCELLING') {
          // No observable state change
        }

        if (action === 'CANCEL_CONFIRMED' && model.txState === 'CANCELLED') {
          // No observable state change
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
    reactors: [
      // Auto-advance: TAP_APPROVED from AWAITING_TAP → RECORDING (already handled by acceptor)
      // No reactor needed for observable state — FSM acceptor handles the transition
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

// Sanitize replacer: drop __ prefixed keys and functions
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
  { name: 'INITIATE_PAYMENT', intent: actions.INITIATE_PAYMENT, values: [[{ orderId: 'O1', amountCents: 1000 }]] },
  { name: 'TRANSFER_CREATED', intent: actions.TRANSFER_CREATED, values: [[{ transferId: 'TR1' }]] },
  { name: 'VERIFICATION_STARTED', intent: actions.VERIFICATION_STARTED, values: [[{}]] },
  { name: 'TAP_APPROVED', intent: actions.TAP_APPROVED, values: [[{ approvedAmount: 1000 }]] },
  { name: 'TAP_DECLINED', intent: actions.TAP_DECLINED, values: [[{ declineCode: 'INSUFFICIENT_FUNDS' }], [{ declineCode: 'CANCELLATION_VIA_API' }], [{ declineCode: 'CANCELLATION_VIA_DEVICE' }], [{ declineCode: 'IMMEDIATE_FAILURE' }]] },
  { name: 'PAYMENT_RECORDED', intent: actions.PAYMENT_RECORDED, values: [[{ paymentId: 'P1' }], [{ paymentId: null }]] },
  { name: 'CANCEL_PAYMENT', intent: actions.CANCEL_PAYMENT, values: [[{}]] },
  { name: 'CANCEL_CONFIRMED', intent: actions.CANCEL_CONFIRMED, values: [[{}]] },
  { name: 'EXIT_FLOW', intent: actions.EXIT_FLOW, values: [[{}]] },
];

module.exports = { instance, init, actions, getState, setState, checkerIntents };