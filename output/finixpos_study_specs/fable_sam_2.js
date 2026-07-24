'use strict';

const { createInstance } = require('@cognitive-fab/sam-pattern');

const instance = createInstance({ instanceName: 'finixpos', hasAsyncActions: false });

// ── Observable initial state (exactly the seven pinned keys) ────────────────
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

// ── FSM transition table (mirrors terminalPaymentFSM, enforceAllowedTransitions) ──
// CANCEL_DECLINED is the internal action inserted by the pre-FSM acceptor when
// TAP_DECLINED arrives while CANCELLING (same action name → two next states).
const TRANSITIONS = {
  IDLE: {
    INITIATE_PAYMENT: 'INITIATING',
  },
  INITIATING: {
    TRANSFER_CREATED: 'AWAITING_TAP',
    VERIFICATION_STARTED: 'AWAITING_VERIFICATION',
    TAP_DECLINED: 'DECLINED',
    CANCEL_PAYMENT: 'CANCELLING',
  },
  AWAITING_TAP: {
    TAP_APPROVED: 'RECORDING',
    TAP_DECLINED: 'DECLINED',
    CANCEL_PAYMENT: 'CANCELLING',
  },
  AWAITING_VERIFICATION: {
    TAP_APPROVED: 'RECORDING',
    TAP_DECLINED: 'DECLINED',
  },
  PROCESSING: {},          // reserved — no transitions, never entered
  RECORDING: {
    PAYMENT_RECORDED: 'COMPLETED',
  },
  COMPLETED: {
    EXIT_FLOW: 'IDLE',
  },
  DECLINED: {
    EXIT_FLOW: 'IDLE',
  },
  CANCELLING: {
    CANCEL_CONFIRMED: 'CANCELLED',
    TAP_APPROVED: 'RECORDING',   // tap beat cancel — charge is honoured
    CANCEL_DECLINED: 'CANCELLED',
  },
  CANCELLED: {
    EXIT_FLOW: 'IDLE',
  },
};

const { intents } = instance({
  initialState: clone(INITIAL_STATE),
  component: {
    actions: [
      // INITIATE_PAYMENT
      (data = {}) => ({
        __name: 'INITIATE_PAYMENT',
        orderId: data.orderId,
        amountCents: data.amountCents,
      }),
      // TRANSFER_CREATED
      (data = {}) => ({
        __name: 'TRANSFER_CREATED',
        transferId: data.transferId,
      }),
      // VERIFICATION_STARTED
      () => ({ __name: 'VERIFICATION_STARTED' }),
      // TAP_APPROVED
      (data = {}) => ({
        __name: 'TAP_APPROVED',
        approvedAmount: data.approvedAmount,
      }),
      // TAP_DECLINED
      (data = {}) => ({
        __name: 'TAP_DECLINED',
        declineCode: data.declineCode === undefined ? null : data.declineCode,
      }),
      // PAYMENT_RECORDED
      (data = {}) => ({
        __name: 'PAYMENT_RECORDED',
        paymentId: data.paymentId === undefined ? null : data.paymentId,
      }),
      // CANCEL_PAYMENT
      () => ({ __name: 'CANCEL_PAYMENT' }),
      // CANCEL_CONFIRMED
      () => ({ __name: 'CANCEL_CONFIRMED' }),
      // EXIT_FLOW
      () => ({ __name: 'EXIT_FLOW' }),
    ],
    acceptors: [
      (model) => (proposal) => {
        if (!proposal || typeof proposal.__name !== 'string') return;

        let action = proposal.__name;
        let declineCode =
          proposal.declineCode === undefined ? null : proposal.declineCode;

        // ── Pre-FSM rewrite 1: CANCELLING + TAP_DECLINED → CANCEL_DECLINED ──
        // Same action name maps to CANCELLED (not DECLINED) when the source
        // state is CANCELLING; declineCode from the proposal is carried through.
        if (action === 'TAP_DECLINED' && model.txState === 'CANCELLING') {
          action = 'CANCEL_DECLINED';
        }

        // ── Pre-FSM rewrite 2: partial-payment guard ─────────────────────────
        // SUCCEEDED but approved < requested (strict) while AWAITING_TAP →
        // rewritten to TAP_DECLINED with declineCode='PARTIAL_PAYMENT'.
        // Overpayment (tip-on-terminal) passes through as TAP_APPROVED.
        if (
          action === 'TAP_APPROVED' &&
          model.txState === 'AWAITING_TAP' &&
          typeof proposal.approvedAmount === 'number' &&
          proposal.approvedAmount <
            (model.amountCents === null || model.amountCents === undefined
              ? 0
              : model.amountCents)
        ) {
          action = 'TAP_DECLINED';
          declineCode = 'PARTIAL_PAYMENT';
        }

        // ── enforceAllowedTransitions: silently discard disallowed actions ──
        // (e.g. TAP_APPROVED/TAP_DECLINED arriving in RECORDING or COMPLETED,
        // a second INITIATE_PAYMENT while AWAITING_TAP, EXIT_FLOW mid-flight)
        const row = TRANSITIONS[model.txState] || {};
        const nextState = row[action];
        if (!nextState) return;

        model.txState = nextState;

        // ── Apply action data to model (post-transition, guarded by table) ──
        switch (action) {
          case 'INITIATE_PAYMENT':
            model.orderId = proposal.orderId === undefined ? null : proposal.orderId;
            model.amountCents =
              proposal.amountCents === undefined ? null : proposal.amountCents;
            model.transferId = null;
            model.approvedAmountCents = null;
            model.paymentId = null;
            model.declineCode = null;
            break;
          case 'TRANSFER_CREATED':
            model.transferId =
              proposal.transferId === undefined ? null : proposal.transferId;
            break;
          case 'VERIFICATION_STARTED':
            // txState advanced; no observable field changes
            break;
          case 'TAP_APPROVED':
            model.approvedAmountCents =
              typeof proposal.approvedAmount === 'number'
                ? proposal.approvedAmount
                : null;
            break;
          case 'TAP_DECLINED':
          case 'CANCEL_DECLINED':
            model.declineCode = declineCode === undefined ? null : declineCode;
            break;
          case 'PAYMENT_RECORDED':
            model.paymentId =
              proposal.paymentId === undefined ? null : proposal.paymentId;
            break;
          case 'CANCEL_PAYMENT':
          case 'CANCEL_CONFIRMED':
            // txState advanced; no observable field changes
            break;
          case 'EXIT_FLOW':
            model.orderId = null;
            model.amountCents = null;
            model.transferId = null;
            model.approvedAmountCents = null;
            model.paymentId = null;
            model.declineCode = null;
            break;
          default:
            break;
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

const getState = () => {
  const raw = JSON.parse(JSON.stringify(instance({}).state(), sanitizeReplacer));
  return {
    txState: raw.txState === undefined ? null : raw.txState,
    orderId: raw.orderId === undefined ? null : raw.orderId,
    amountCents: raw.amountCents === undefined ? null : raw.amountCents,
    transferId: raw.transferId === undefined ? null : raw.transferId,
    declineCode: raw.declineCode === undefined ? null : raw.declineCode,
    approvedAmountCents:
      raw.approvedAmountCents === undefined ? null : raw.approvedAmountCents,
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
      [{ declineCode: null }],
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