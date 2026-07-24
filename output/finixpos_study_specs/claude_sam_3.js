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

// FSM transition table — allowed actions per state (mirrors terminalPaymentFSM).
const TRANSITIONS = {
  IDLE:                  ['INITIATE_PAYMENT'],
  INITIATING:            ['TRANSFER_CREATED', 'VERIFICATION_STARTED', 'TAP_DECLINED', 'CANCEL_PAYMENT'],
  AWAITING_TAP:          ['TAP_APPROVED', 'TAP_DECLINED', 'CANCEL_PAYMENT'],
  AWAITING_VERIFICATION: ['TAP_APPROVED', 'TAP_DECLINED'],
  RECORDING:             ['PAYMENT_RECORDED'],
  COMPLETED:             ['EXIT_FLOW'],
  DECLINED:              ['EXIT_FLOW'],
  CANCELLING:            ['CANCEL_CONFIRMED', 'TAP_APPROVED', 'CANCEL_DECLINED'],
  CANCELLED:             ['EXIT_FLOW'],
};

// Next-state mapping (deterministic). CANCEL_DECLINED is internal.
const NEXT_STATE = {
  INITIATE_PAYMENT:     'INITIATING',
  TRANSFER_CREATED:     'AWAITING_TAP',
  VERIFICATION_STARTED: 'AWAITING_VERIFICATION',
  TAP_APPROVED:         'RECORDING',
  TAP_DECLINED:         'DECLINED',
  CANCEL_DECLINED:      'CANCELLED',
  PAYMENT_RECORDED:     'COMPLETED',
  CANCEL_PAYMENT:       'CANCELLING',
  CANCEL_CONFIRMED:     'CANCELLED',
  EXIT_FLOW:            'IDLE',
};

const { intents } = instance({
  initialState: clone(INITIAL_STATE),
  component: {
    actions: [
      (data = {}) => ({
        __name: 'INITIATE_PAYMENT',
        orderId: data.orderId,
        amountCents: data.amountCents,
      }),
      (data = {}) => ({ __name: 'TRANSFER_CREATED', transferId: data.transferId }),
      () => ({ __name: 'VERIFICATION_STARTED' }),
      (data = {}) => ({ __name: 'TAP_APPROVED', approvedAmount: data.approvedAmount }),
      (data = {}) => ({ __name: 'TAP_DECLINED', declineCode: data.declineCode ?? null }),
      (data = {}) => ({ __name: 'PAYMENT_RECORDED', paymentId: data.paymentId ?? null }),
      () => ({ __name: 'CANCEL_PAYMENT' }),
      () => ({ __name: 'CANCEL_CONFIRMED' }),
      () => ({ __name: 'EXIT_FLOW' }),
    ],
    acceptors: [
      // ── Pre-FSM rewrites (mirror the source's pre-FSM acceptor) ────────────
      (model) => (proposal) => {
        const action = proposal.__name;

        // 1. CANCELLING + TAP_DECLINED → CANCEL_DECLINED (→ CANCELLED)
        if (action === 'TAP_DECLINED' && model.txState === 'CANCELLING') {
          proposal.__name = 'CANCEL_DECLINED';
          return;
        }

        // 2. Partial-payment rejection: SUCCEEDED but approved < requested
        //    → rewrite TAP_APPROVED to TAP_DECLINED (PARTIAL_PAYMENT).
        //    Overpayments (tip) are legitimate — use strict less-than.
        if (
          action === 'TAP_APPROVED' &&
          model.txState === 'AWAITING_TAP' &&
          typeof proposal.approvedAmount === 'number' &&
          proposal.approvedAmount < (model.amountCents ?? 0)
        ) {
          proposal.__name = 'TAP_DECLINED';
          proposal.declineCode = 'PARTIAL_PAYMENT';
        }
      },

      // ── FSM transition + model application ─────────────────────────────────
      // Only advance if the (possibly rewritten) action is allowed in the
      // current state. Disallowed actions are silent no-ops (anti-glitch).
      (model) => (proposal) => {
        const action = proposal.__name;
        const allowed = TRANSITIONS[model.txState] || [];
        if (!allowed.includes(action)) return; // no-op

        const next = NEXT_STATE[action];
        model.txState = next;

        switch (action) {
          case 'INITIATE_PAYMENT':
            model.orderId = proposal.orderId ?? null;
            model.amountCents = proposal.amountCents ?? null;
            model.transferId = null;
            model.approvedAmountCents = null;
            model.paymentId = null;
            model.declineCode = null;
            break;

          case 'TRANSFER_CREATED':
            model.transferId = proposal.transferId ?? null;
            break;

          case 'TAP_APPROVED':
            model.approvedAmountCents =
              typeof proposal.approvedAmount === 'number' ? proposal.approvedAmount : null;
            break;

          case 'TAP_DECLINED':
          case 'CANCEL_DECLINED':
            model.declineCode = proposal.declineCode ?? null;
            break;

          case 'PAYMENT_RECORDED':
            model.paymentId = proposal.paymentId ?? null;
            break;

          case 'EXIT_FLOW':
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
  const full = JSON.parse(JSON.stringify(instance({}).state(), sanitizeReplacer));
  const snapshot = {};
  for (const k of OBSERVABLE_KEYS) snapshot[k] = full[k] ?? null;
  return snapshot;
};

const setState = (snapshot) => { instance({ initialState: clone(snapshot) }); };

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
  { name: 'INITIATE_PAYMENT', intent: actions.INITIATE_PAYMENT, values: [
    [{ orderId: 'O1', amountCents: 500 }],
    [{ orderId: 'O1', amountCents: 1000 }],
    [{ orderId: 'O1', amountCents: 1500 }],
  ] },
  { name: 'TRANSFER_CREATED', intent: actions.TRANSFER_CREATED, values: [
    [{ transferId: 'TR1' }],
  ] },
  { name: 'VERIFICATION_STARTED', intent: actions.VERIFICATION_STARTED, values: [[{}]] },
  { name: 'TAP_APPROVED', intent: actions.TAP_APPROVED, values: [
    [{ approvedAmount: 500 }],
    [{ approvedAmount: 1000 }],
    [{ approvedAmount: 1500 }],
  ] },
  { name: 'TAP_DECLINED', intent: actions.TAP_DECLINED, values: [
    [{ declineCode: 'INSUFFICIENT_FUNDS' }],
    [{ declineCode: 'CANCELLATION_VIA_API' }],
    [{ declineCode: 'CANCELLATION_VIA_DEVICE' }],
    [{ declineCode: 'IMMEDIATE_FAILURE' }],
  ] },
  { name: 'PAYMENT_RECORDED', intent: actions.PAYMENT_RECORDED, values: [
    [{ paymentId: 'P1' }],
    [{ paymentId: null }],
  ] },
  { name: 'CANCEL_PAYMENT', intent: actions.CANCEL_PAYMENT, values: [[{}]] },
  { name: 'CANCEL_CONFIRMED', intent: actions.CANCEL_CONFIRMED, values: [[{}]] },
  { name: 'EXIT_FLOW', intent: actions.EXIT_FLOW, values: [[{}]] },
];

module.exports = { instance, init, actions, getState, setState, checkerIntents };