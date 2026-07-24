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

// FSM transition table — mirrors terminalPaymentFSM.states[*].transitions.
// Each state maps allowed action names to the resulting next txState.
// Anti-glitch invariant: actions not listed for a state are silently discarded.
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

// Determine the effective action name after the pre-FSM rewrites:
//   1. CANCELLING + TAP_DECLINED  → CANCEL_DECLINED (→ CANCELLED)
//   2. AWAITING_TAP + TAP_APPROVED with approvedAmount < amountCents
//      → TAP_DECLINED with declineCode = 'PARTIAL_PAYMENT' (partial-payment guard)
const resolveAction = (model, proposal) => {
  let action = proposal.__actionName;
  const rewritten = {};

  if (action === 'TAP_DECLINED' && model.txState === 'CANCELLING') {
    action = 'CANCEL_DECLINED';
    return { action, rewritten };
  }

  if (
    action === 'TAP_APPROVED' &&
    model.txState === 'AWAITING_TAP' &&
    typeof proposal.approvedAmount === 'number' &&
    proposal.approvedAmount < (model.amountCents == null ? 0 : model.amountCents)
  ) {
    action = 'TAP_DECLINED';
    rewritten.declineCode = 'PARTIAL_PAYMENT';
  }

  return { action, rewritten };
};

const { intents } = instance({
  initialState: clone(INITIAL_STATE),
  component: {
    actions: [
      (data = {}) => ({
        __name: 'INITIATE_PAYMENT',
        __actionName: 'INITIATE_PAYMENT',
        orderId: data.orderId,
        amountCents: data.amountCents,
      }),
      (data = {}) => ({
        __name: 'TRANSFER_CREATED',
        __actionName: 'TRANSFER_CREATED',
        transferId: data.transferId,
      }),
      () => ({
        __name: 'VERIFICATION_STARTED',
        __actionName: 'VERIFICATION_STARTED',
      }),
      (data = {}) => ({
        __name: 'TAP_APPROVED',
        __actionName: 'TAP_APPROVED',
        approvedAmount: data.approvedAmount,
      }),
      (data = {}) => ({
        __name: 'TAP_DECLINED',
        __actionName: 'TAP_DECLINED',
        declineCode: data.declineCode == null ? null : data.declineCode,
      }),
      (data = {}) => ({
        __name: 'PAYMENT_RECORDED',
        __actionName: 'PAYMENT_RECORDED',
        paymentId: data.paymentId == null ? null : data.paymentId,
      }),
      () => ({
        __name: 'CANCEL_PAYMENT',
        __actionName: 'CANCEL_PAYMENT',
      }),
      () => ({
        __name: 'CANCEL_CONFIRMED',
        __actionName: 'CANCEL_CONFIRMED',
      }),
      () => ({
        __name: 'EXIT_FLOW',
        __actionName: 'EXIT_FLOW',
      }),
    ],
    acceptors: [
      // ── FSM program-counter advance ────────────────────────────────────
      // Resolve any pre-FSM rewrites, then advance txState iff the (possibly
      // rewritten) action is a legal transition from the current state.
      // Illegal actions are silently discarded (no state change).
      (model) => (proposal) => {
        const { action } = resolveAction(model, proposal);
        const allowed = TRANSITIONS[model.txState] || {};
        const next = allowed[action];
        if (next) {
          model.txState = next;
        }
      },

      // ── Apply action data to model (post-transition) ───────────────────
      // Each branch is guarded by the expected post-transition txState so a
      // silently-rejected action cannot corrupt the model.
      (model) => (proposal) => {
        const { action, rewritten } = resolveAction(model, proposal);

        if (action === 'INITIATE_PAYMENT' && model.txState === 'INITIATING') {
          model.orderId = proposal.orderId == null ? null : proposal.orderId;
          model.amountCents = proposal.amountCents == null ? null : proposal.amountCents;
          model.transferId = null;
          model.approvedAmountCents = null;
          model.paymentId = null;
          model.declineCode = null;
        }

        if (action === 'TRANSFER_CREATED' && model.txState === 'AWAITING_TAP') {
          model.transferId = proposal.transferId == null ? null : proposal.transferId;
        }

        if (action === 'TAP_APPROVED' && model.txState === 'RECORDING') {
          model.approvedAmountCents =
            typeof proposal.approvedAmount === 'number' ? proposal.approvedAmount : null;
        }

        if (action === 'TAP_DECLINED' && model.txState === 'DECLINED') {
          if (Object.prototype.hasOwnProperty.call(rewritten, 'declineCode')) {
            model.declineCode = rewritten.declineCode;
          } else {
            model.declineCode = proposal.declineCode == null ? null : proposal.declineCode;
          }
        }

        if (action === 'CANCEL_DECLINED' && model.txState === 'CANCELLED') {
          model.declineCode = proposal.declineCode == null ? null : proposal.declineCode;
        }

        if (action === 'PAYMENT_RECORDED' && model.txState === 'COMPLETED') {
          model.paymentId = proposal.paymentId == null ? null : proposal.paymentId;
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
    out[k] = raw[k] === undefined ? null : raw[k];
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
      [{ orderId: 'O2', amountCents: 1500 }],
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