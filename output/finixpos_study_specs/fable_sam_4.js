'use strict';

const { createInstance } = require('@cognitive-fab/sam-pattern');

const instance = createInstance({ instanceName: 'finixpos', hasAsyncActions: false });

// ---------------------------------------------------------------------------
// Observable model (exactly the seven pinned keys)
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// FSM transition table (from terminalPaymentFSM, enforceAllowedTransitions).
// CANCEL_DECLINED is the internal action inserted by the pre-FSM rewrite when
// TAP_DECLINED arrives while CANCELLING — it is not a public action.
// PROCESSING is reserved (no transitions in or out) and never entered.
// ---------------------------------------------------------------------------
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
  PROCESSING: {},
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
    TAP_APPROVED: 'RECORDING',
    CANCEL_DECLINED: 'CANCELLED',
  },
  CANCELLED: {
    EXIT_FLOW: 'IDLE',
  },
};

// ---------------------------------------------------------------------------
// SAM component
// ---------------------------------------------------------------------------
const componentActions = [
  ['INITIATE_PAYMENT', (data = {}) => ({
    __name: 'INITIATE_PAYMENT',
    __actionName: 'INITIATE_PAYMENT',
    orderId: data.orderId,
    amountCents: data.amountCents,
  })],
  ['TRANSFER_CREATED', (data = {}) => ({
    __name: 'TRANSFER_CREATED',
    __actionName: 'TRANSFER_CREATED',
    transferId: data.transferId,
  })],
  ['VERIFICATION_STARTED', () => ({
    __name: 'VERIFICATION_STARTED',
    __actionName: 'VERIFICATION_STARTED',
  })],
  ['TAP_APPROVED', (data = {}) => ({
    __name: 'TAP_APPROVED',
    __actionName: 'TAP_APPROVED',
    approvedAmount: data.approvedAmount,
  })],
  ['TAP_DECLINED', (data = {}) => ({
    __name: 'TAP_DECLINED',
    __actionName: 'TAP_DECLINED',
    declineCode: data.declineCode !== undefined ? data.declineCode : null,
  })],
  ['PAYMENT_RECORDED', (data = {}) => ({
    __name: 'PAYMENT_RECORDED',
    __actionName: 'PAYMENT_RECORDED',
    paymentId: data.paymentId !== undefined ? data.paymentId : null,
  })],
  ['CANCEL_PAYMENT', () => ({
    __name: 'CANCEL_PAYMENT',
    __actionName: 'CANCEL_PAYMENT',
  })],
  ['CANCEL_CONFIRMED', () => ({
    __name: 'CANCEL_CONFIRMED',
    __actionName: 'CANCEL_CONFIRMED',
  })],
  ['EXIT_FLOW', () => ({
    __name: 'EXIT_FLOW',
    __actionName: 'EXIT_FLOW',
  })],
];

const { intents } = instance({
  initialState: clone(INITIAL_STATE),
  component: {
    actions: componentActions.map(([, fn]) => fn),

    acceptors: [
      // ── Pre-FSM rewrites (mirrors the production pre-FSM acceptor) ────────
      // 1. CANCELLING + TAP_DECLINED → CANCEL_DECLINED (tap-declined during a
      //    cancel resolves to CANCELLED, not DECLINED).
      // 2. Partial-payment guard: TAP_APPROVED in AWAITING_TAP with
      //    approvedAmount strictly below the requested amountCents is rewritten
      //    to TAP_DECLINED with declineCode='PARTIAL_PAYMENT'. Overpayments
      //    (tip-on-terminal) pass through as approvals. The guard applies ONLY
      //    in AWAITING_TAP — TAP_APPROVED from CANCELLING or
      //    AWAITING_VERIFICATION is honoured as-is.
      (model) => (proposal) => {
        if (proposal.__actionName === 'TAP_DECLINED' && model.txState === 'CANCELLING') {
          proposal.__actionName = 'CANCEL_DECLINED';
          return;
        }
        if (
          proposal.__actionName === 'TAP_APPROVED' &&
          model.txState === 'AWAITING_TAP' &&
          typeof proposal.approvedAmount === 'number' &&
          proposal.approvedAmount < (model.amountCents !== null && model.amountCents !== undefined ? model.amountCents : 0)
        ) {
          proposal.__actionName = 'TAP_DECLINED';
          proposal.declineCode = 'PARTIAL_PAYMENT';
        }
      },

      // ── FSM transition + guarded model mutation ────────────────────────────
      // enforceAllowedTransitions semantics: an action not allowed from the
      // current txState is silently discarded (no state change, no field
      // writes). This is the anti-glitch invariant — e.g. TAP_APPROVED or
      // TAP_DECLINED arriving in RECORDING/COMPLETED is a no-op.
      (model) => (proposal) => {
        const actionName = proposal.__actionName;
        const allowed = TRANSITIONS[model.txState];
        if (!allowed) return;
        const nextState = allowed[actionName];
        if (!nextState) return; // rejected transition — silent no-op

        model.txState = nextState;

        switch (actionName) {
          case 'INITIATE_PAYMENT':
            // Fresh transaction — clear all prior transaction residue.
            model.orderId = proposal.orderId !== undefined ? proposal.orderId : null;
            model.amountCents = proposal.amountCents !== undefined ? proposal.amountCents : null;
            model.transferId = null;
            model.declineCode = null;
            model.approvedAmountCents = null;
            model.paymentId = null;
            break;

          case 'TRANSFER_CREATED':
            model.transferId = proposal.transferId !== undefined ? proposal.transferId : null;
            break;

          case 'VERIFICATION_STARTED':
            // Moves to AWAITING_VERIFICATION; no field changes.
            break;

          case 'TAP_APPROVED':
            model.approvedAmountCents =
              typeof proposal.approvedAmount === 'number' ? proposal.approvedAmount : null;
            break;

          case 'TAP_DECLINED':
          case 'CANCEL_DECLINED':
            model.declineCode = proposal.declineCode !== undefined ? proposal.declineCode : null;
            break;

          case 'PAYMENT_RECORDED':
            model.paymentId = proposal.paymentId !== undefined ? proposal.paymentId : null;
            break;

          case 'CANCEL_PAYMENT':
          case 'CANCEL_CONFIRMED':
            // Pure transitions; field values carry over.
            break;

          case 'EXIT_FLOW':
            // Reset to a clean IDLE model.
            model.orderId = null;
            model.amountCents = null;
            model.transferId = null;
            model.declineCode = null;
            model.approvedAmountCents = null;
            model.paymentId = null;
            break;

          default:
            break;
        }
      },
    ],
  },
});

// ---------------------------------------------------------------------------
// Wire intents by action name
// ---------------------------------------------------------------------------
const intentMap = {};
componentActions.forEach(([name], i) => { intentMap[name] = intents[i]; });

const actions = {
  INITIATE_PAYMENT: (data = {}) => intentMap.INITIATE_PAYMENT(data),
  TRANSFER_CREATED: (data = {}) => intentMap.TRANSFER_CREATED(data),
  VERIFICATION_STARTED: (data = {}) => intentMap.VERIFICATION_STARTED(data),
  TAP_APPROVED: (data = {}) => intentMap.TAP_APPROVED(data),
  TAP_DECLINED: (data = {}) => intentMap.TAP_DECLINED(data),
  PAYMENT_RECORDED: (data = {}) => intentMap.PAYMENT_RECORDED(data),
  CANCEL_PAYMENT: (data = {}) => intentMap.CANCEL_PAYMENT(data),
  CANCEL_CONFIRMED: (data = {}) => intentMap.CANCEL_CONFIRMED(data),
  EXIT_FLOW: (data = {}) => intentMap.EXIT_FLOW(data),
};

// ---------------------------------------------------------------------------
// Harness contract
// ---------------------------------------------------------------------------
const sanitizeReplacer = (key, value) => {
  if (typeof key === 'string' && key.indexOf('__') === 0) return undefined;
  if (typeof value === 'function') return undefined;
  return value;
};

const getState = () => {
  const raw = JSON.parse(JSON.stringify(instance({}).state(), sanitizeReplacer));
  return {
    txState: raw.txState,
    orderId: raw.orderId !== undefined ? raw.orderId : null,
    amountCents: raw.amountCents !== undefined ? raw.amountCents : null,
    transferId: raw.transferId !== undefined ? raw.transferId : null,
    declineCode: raw.declineCode !== undefined ? raw.declineCode : null,
    approvedAmountCents: raw.approvedAmountCents !== undefined ? raw.approvedAmountCents : null,
    paymentId: raw.paymentId !== undefined ? raw.paymentId : null,
  };
};

const setState = (snapshot) => { instance({ initialState: clone(snapshot) }); };

const init = () => {
  instance({}).state().clearError();
  setState(INITIAL_STATE);
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
    values: [
      [{ transferId: 'TR1' }],
    ],
  },
  {
    name: 'VERIFICATION_STARTED',
    intent: actions.VERIFICATION_STARTED,
    values: [
      [{}],
    ],
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
    values: [
      [{ paymentId: 'P1' }],
      [{ paymentId: null }],
    ],
  },
  {
    name: 'CANCEL_PAYMENT',
    intent: actions.CANCEL_PAYMENT,
    values: [
      [{}],
    ],
  },
  {
    name: 'CANCEL_CONFIRMED',
    intent: actions.CANCEL_CONFIRMED,
    values: [
      [{}],
    ],
  },
  {
    name: 'EXIT_FLOW',
    intent: actions.EXIT_FLOW,
    values: [
      [{}],
    ],
  },
];

module.exports = { instance, init, actions, getState, setState, checkerIntents };