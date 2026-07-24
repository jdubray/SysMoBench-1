'use strict';

const { createInstance } = require('@cognitive-fab/sam-pattern');

const instance = createInstance({ instanceName: 'finixpos', hasAsyncActions: false });

// ---------------------------------------------------------------------------
// Observable model — exactly the seven pinned keys
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
// FSM transition table (mirrors terminalPaymentFSM with
// deterministic + enforceAllowedTransitions semantics: disallowed actions
// are silently discarded — no state change, no model mutation)
// ---------------------------------------------------------------------------
const TARGET_STATE = {
  INITIATE_PAYMENT: 'INITIATING',
  TRANSFER_CREATED: 'AWAITING_TAP',
  VERIFICATION_STARTED: 'AWAITING_VERIFICATION',
  TAP_APPROVED: 'RECORDING',
  TAP_DECLINED: 'DECLINED',
  CANCEL_DECLINED: 'CANCELLED',
  PAYMENT_RECORDED: 'COMPLETED',
  CANCEL_PAYMENT: 'CANCELLING',
  CANCEL_CONFIRMED: 'CANCELLED',
  EXIT_FLOW: 'IDLE',
};

const ALLOWED = {
  IDLE:                  ['INITIATE_PAYMENT'],
  INITIATING:            ['TRANSFER_CREATED', 'VERIFICATION_STARTED', 'TAP_DECLINED', 'CANCEL_PAYMENT'],
  AWAITING_TAP:          ['TAP_APPROVED', 'TAP_DECLINED', 'CANCEL_PAYMENT'],
  AWAITING_VERIFICATION: ['TAP_APPROVED', 'TAP_DECLINED'],
  PROCESSING:            [],
  RECORDING:             ['PAYMENT_RECORDED'],
  COMPLETED:             ['EXIT_FLOW'],
  DECLINED:              ['EXIT_FLOW'],
  CANCELLING:            ['CANCEL_CONFIRMED', 'TAP_APPROVED', 'CANCEL_DECLINED'],
  CANCELLED:             ['EXIT_FLOW'],
};

// ---------------------------------------------------------------------------
// Component actions — pure proposal computation
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

// ---------------------------------------------------------------------------
// SAM wiring
// ---------------------------------------------------------------------------
const { intents } = instance({
  initialState: clone(INITIAL_STATE),
  component: {
    actions: componentActions.map(([, fn]) => fn),

    acceptors: [
      // ── Pre-FSM rewrites ─────────────────────────────────────────────────
      // 1. CANCELLING + TAP_DECLINED → CANCEL_DECLINED (→ CANCELLED)
      // 2. Partial-payment guard: TAP_APPROVED in AWAITING_TAP with
      //    approvedAmount strictly below amountCents → TAP_DECLINED with
      //    declineCode='PARTIAL_PAYMENT'. Overpayments (tip-on-terminal) pass.
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
          proposal.approvedAmount < (model.amountCents !== null && model.amountCents !== undefined ? model.amountCents : 0)
        ) {
          proposal.__actionName = 'TAP_DECLINED';
          proposal.declineCode = 'PARTIAL_PAYMENT';
        }
      },

      // ── FSM acceptor: advance txState only on allowed transitions ────────
      // Disallowed actions are silently discarded (enforceAllowedTransitions):
      // txState stays put, so the guarded apply-acceptor below is a no-op too.
      (model) => (proposal) => {
        const action = proposal.__actionName;
        const target = TARGET_STATE[action];
        if (!target) return;
        const allowed = ALLOWED[model.txState] || [];
        if (allowed.indexOf(action) >= 0) {
          model.txState = target;
        }
      },

      // ── Apply action data — guarded by expected post-transition txState ──
      (model) => (proposal) => {
        const action = proposal.__actionName;

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
          model.approvedAmountCents =
            typeof proposal.approvedAmount === 'number' ? proposal.approvedAmount : null;
        }

        if ((action === 'TAP_DECLINED' && model.txState === 'DECLINED') ||
            (action === 'CANCEL_DECLINED' && model.txState === 'CANCELLED')) {
          model.declineCode =
            proposal.declineCode !== undefined && proposal.declineCode !== null
              ? proposal.declineCode
              : null;
        }

        if (action === 'PAYMENT_RECORDED' && model.txState === 'COMPLETED') {
          model.paymentId =
            proposal.paymentId !== undefined && proposal.paymentId !== null
              ? proposal.paymentId
              : null;
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
  },
});

// ---------------------------------------------------------------------------
// Public module contract
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
    values: [
      [{ paymentId: 'P1' }],
      [{ paymentId: null }],
    ],
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