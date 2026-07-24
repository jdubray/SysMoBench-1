'use strict';

const { createInstance } = require('@cognitive-fab/sam-pattern');

const instance = createInstance({ instanceName: 'finixpos', hasAsyncActions: false });

// Observable state keys: txState, orderId, amountCents, transferId, declineCode, approvedAmountCents, paymentId
const INITIAL_STATE = {
  txState:             'IDLE',
  orderId:             null,
  amountCents:         null,
  transferId:          null,
  declineCode:         null,
  approvedAmountCents: null,
  paymentId:           null,
};

const clone = (value) => JSON.parse(JSON.stringify(value));

const { intents } = instance({
  initialState: clone(INITIAL_STATE),
  component: {
    actions: [
      // INITIATE_PAYMENT: starts a new transaction
      (data) => ({
        __name: 'INITIATE_PAYMENT',
        orderId: data.orderId,
        amountCents: data.amountCents,
      }),
      // TRANSFER_CREATED: Finix transfer created, awaiting tap
      (data) => ({
        __name: 'TRANSFER_CREATED',
        transferId: data.transferId,
      }),
      // VERIFICATION_STARTED: createTerminalSale failed, awaiting orphan sweep
      () => ({
        __name: 'VERIFICATION_STARTED',
      }),
      // TAP_APPROVED: customer tapped, card approved
      (data) => ({
        __name: 'TAP_APPROVED',
        approvedAmount: data.approvedAmount,
      }),
      // TAP_DECLINED: card declined or payment failed
      (data) => ({
        __name: 'TAP_DECLINED',
        declineCode: data.declineCode,
      }),
      // PAYMENT_RECORDED: payment row written to DB
      (data) => ({
        __name: 'PAYMENT_RECORDED',
        paymentId: data.paymentId,
      }),
      // CANCEL_PAYMENT: abort in-progress transaction
      () => ({
        __name: 'CANCEL_PAYMENT',
      }),
      // CANCEL_CONFIRMED: cancel succeeded, FSM advances to CANCELLED
      () => ({
        __name: 'CANCEL_CONFIRMED',
      }),
      // EXIT_FLOW: reset to IDLE after terminal state
      () => ({
        __name: 'EXIT_FLOW',
      }),
    ],
    acceptors: [
      // Pre-FSM rewrites
      // 1. CANCELLING + TAP_DECLINED → CANCEL_DECLINED (→ CANCELLED)
      (model) => (proposal) => {
        if (proposal.__name === 'TAP_DECLINED' && model.txState === 'CANCELLING') {
          proposal.__name = 'CANCEL_DECLINED';
        }
      },

      // 2. Partial-payment rejection: approved < requested → TAP_DECLINED
      (model) => (proposal) => {
        if (proposal.__name === 'TAP_APPROVED' && model.txState === 'AWAITING_TAP') {
          const approved = proposal.approvedAmount;
          if (typeof approved === 'number' && approved < (model.amountCents ?? 0)) {
            proposal.__name = 'TAP_DECLINED';
            proposal.declineCode = 'PARTIAL_PAYMENT';
          }
        }
      },

      // FSM state-machine acceptors
      (model) => (proposal) => {
        // INITIATE_PAYMENT: IDLE → INITIATING
        if (proposal.__name === 'INITIATE_PAYMENT' && model.txState === 'IDLE') {
          model.txState = 'INITIATING';
        }
        // TRANSFER_CREATED: INITIATING → AWAITING_TAP
        if (proposal.__name === 'TRANSFER_CREATED' && model.txState === 'INITIATING') {
          model.txState = 'AWAITING_TAP';
        }
        // VERIFICATION_STARTED: INITIATING → AWAITING_VERIFICATION
        if (proposal.__name === 'VERIFICATION_STARTED' && model.txState === 'INITIATING') {
          model.txState = 'AWAITING_VERIFICATION';
        }
        // TAP_APPROVED: AWAITING_TAP → RECORDING, AWAITING_VERIFICATION → RECORDING, CANCELLING → RECORDING
        if (proposal.__name === 'TAP_APPROVED' && (model.txState === 'AWAITING_TAP' || model.txState === 'AWAITING_VERIFICATION' || model.txState === 'CANCELLING')) {
          model.txState = 'RECORDING';
        }
        // TAP_DECLINED: AWAITING_TAP → DECLINED, CANCELLING → DECLINED
        if (proposal.__name === 'TAP_DECLINED' && (model.txState === 'AWAITING_TAP' || model.txState === 'CANCELLING')) {
          model.txState = 'DECLINED';
        }
        // CANCEL_DECLINED: CANCELLING → CANCELLED
        if (proposal.__name === 'CANCEL_DECLINED' && model.txState === 'CANCELLING') {
          model.txState = 'CANCELLED';
        }
        // PAYMENT_RECORDED: RECORDING → COMPLETED
        if (proposal.__name === 'PAYMENT_RECORDED' && model.txState === 'RECORDING') {
          model.txState = 'COMPLETED';
        }
        // CANCEL_CONFIRMED: CANCELLING → CANCELLED
        if (proposal.__name === 'CANCEL_CONFIRMED' && model.txState === 'CANCELLING') {
          model.txState = 'CANCELLED';
        }
        // EXIT_FLOW: COMPLETED → IDLE, DECLINED → IDLE, CANCELLED → IDLE
        if (proposal.__name === 'EXIT_FLOW' && (model.txState === 'COMPLETED' || model.txState === 'DECLINED' || model.txState === 'CANCELLED')) {
          model.txState = 'IDLE';
        }
      },

      // Apply action data to model
      (model) => (proposal) => {
        const action = proposal.__name;

        // INITIATE_PAYMENT: populate transaction fields
        if (action === 'INITIATE_PAYMENT' && model.txState === 'INITIATING') {
          model.orderId = proposal.orderId;
          model.amountCents = proposal.amountCents;
          model.transferId = null;
          model.declineCode = null;
          model.approvedAmountCents = null;
          model.paymentId = null;
        }

        // TRANSFER_CREATED: set transfer ID
        if (action === 'TRANSFER_CREATED' && model.txState === 'AWAITING_TAP') {
          model.transferId = proposal.transferId;
        }

        // TAP_APPROVED: record approval details
        if (action === 'TAP_APPROVED' && model.txState === 'RECORDING') {
          model.approvedAmountCents = proposal.approvedAmount;
          model.declineCode = null;
        }

        // TAP_DECLINED: record decline details
        if (action === 'TAP_DECLINED' && model.txState === 'DECLINED') {
          model.declineCode = proposal.declineCode;
        }

        // CANCEL_DECLINED: record decline on cancel path
        if (action === 'CANCEL_DECLINED' && model.txState === 'CANCELLED') {
          model.declineCode = proposal.declineCode;
        }

        // PAYMENT_RECORDED: set payment ID
        if (action === 'PAYMENT_RECORDED' && model.txState === 'COMPLETED') {
          model.paymentId = proposal.paymentId;
        }

        // EXIT_FLOW: clear transaction fields
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
      // State machine reactor (drives FSM transitions from action proposals)
      (model) => () => {
        // No-op: acceptors handle all transitions
      },
    ],
    naps: [],
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

// Sanitize replacer: drop SAM internals and functions
const sanitizeReplacer = (key, value) => {
  if (typeof key === 'string' && key.startsWith('__')) return undefined;
  if (typeof value === 'function') return undefined;
  return value;
};

const getState = () => {
  const state = instance({}).state();
  return JSON.parse(JSON.stringify(state, sanitizeReplacer));
};

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
  { name: 'VERIFICATION_STARTED', intent: actions.VERIFICATION_STARTED, values: [[{ }]] },
  { name: 'TAP_APPROVED', intent: actions.TAP_APPROVED, values: [[{ approvedAmount: 1000 }]] },
  { name: 'TAP_DECLINED', intent: actions.TAP_DECLINED, values: [[{ declineCode: 'INSUFFICIENT_FUNDS' }], [{ declineCode: 'CANCELLATION_VIA_API' }], [{ declineCode: 'CANCELLATION_VIA_DEVICE' }], [{ declineCode: 'IMMEDIATE_FAILURE' }]] },
  { name: 'PAYMENT_RECORDED', intent: actions.PAYMENT_RECORDED, values: [[{ paymentId: 'P1' }], [{ paymentId: null }]] },
  { name: 'CANCEL_PAYMENT', intent: actions.CANCEL_PAYMENT, values: [[{ }]] },
  { name: 'CANCEL_CONFIRMED', intent: actions.CANCEL_CONFIRMED, values: [[{ }]] },
  { name: 'EXIT_FLOW', intent: actions.EXIT_FLOW, values: [[{ }]] },
];

module.exports = { instance, init, actions, getState, setState, checkerIntents };