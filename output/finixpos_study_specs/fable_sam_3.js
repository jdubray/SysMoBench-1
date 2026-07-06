'use strict';

const { createInstance } = require('@cognitive-fab/sam-pattern');

const instance = createInstance({ instanceName: 'finixpos', hasAsyncActions: false });

// Observable model — exactly the seven keys the harness pins.
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
      // INITIATE_PAYMENT — starts a new card-present transaction
      (data = {}) => ({
        __name: 'INITIATE_PAYMENT',
        orderId: data.orderId,
        amountCents: data.amountCents,
      }),
      // TRANSFER_CREATED — internal: Finix accepted the sale, transfer pending tap
      (data = {}) => ({
        __name: 'TRANSFER_CREATED',
        transferId: data.transferId,
      }),
      // VERIFICATION_STARTED — createTerminalSale failed non-422; outcome unknown
      () => ({ __name: 'VERIFICATION_STARTED' }),
      // TAP_APPROVED — Finix reports SUCCEEDED
      (data = {}) => ({
        __name: 'TAP_APPROVED',
        approvedAmount: data.approvedAmount,
      }),
      // TAP_DECLINED — Finix reports FAILED/CANCELED (or immediate failure)
      (data = {}) => ({
        __name: 'TAP_DECLINED',
        declineCode: data.declineCode === undefined ? null : data.declineCode,
      }),
      // PAYMENT_RECORDED — payments row written (or deferred to /record-payment)
      (data = {}) => ({
        __name: 'PAYMENT_RECORDED',
        paymentId: data.paymentId === undefined ? null : data.paymentId,
      }),
      // CANCEL_PAYMENT — staff/timeout abort of in-progress transaction
      () => ({ __name: 'CANCEL_PAYMENT' }),
      // CANCEL_CONFIRMED — Finix device cancel acknowledged
      () => ({ __name: 'CANCEL_CONFIRMED' }),
      // EXIT_FLOW — reset machine to IDLE after a terminal state
      () => ({ __name: 'EXIT_FLOW' }),
    ],

    acceptors: [
      (model) => (proposal) => {
        let action = proposal.__name;
        let declineCode =
          proposal.declineCode === undefined ? null : proposal.declineCode;

        // ── Pre-FSM rewrite 1: CANCELLING + TAP_DECLINED → CANCEL_DECLINED ──
        // Same action name maps to CANCELLED (not DECLINED) when the decline
        // arrives while a cancel is in flight.
        if (action === 'TAP_DECLINED' && model.txState === 'CANCELLING') {
          action = 'CANCEL_DECLINED';
        }

        // ── Pre-FSM rewrite 2: partial-payment rejection ─────────────────────
        // SUCCEEDED but approved < requested (strict) while AWAITING_TAP is
        // rewritten to TAP_DECLINED with declineCode='PARTIAL_PAYMENT'.
        // Overpayments (tip-on-terminal) pass through as approvals.
        if (
          action === 'TAP_APPROVED' &&
          model.txState === 'AWAITING_TAP' &&
          typeof proposal.approvedAmount === 'number' &&
          proposal.approvedAmount < (model.amountCents === null ? 0 : model.amountCents)
        ) {
          action = 'TAP_DECLINED';
          declineCode = 'PARTIAL_PAYMENT';
        }

        // ── FSM transition + model update (guarded; invalid actions are no-ops) ─
        switch (action) {
          case 'INITIATE_PAYMENT':
            if (model.txState === 'IDLE') {
              model.txState = 'INITIATING';
              model.orderId = proposal.orderId;
              model.amountCents = proposal.amountCents;
              model.transferId = null;
              model.declineCode = null;
              model.approvedAmountCents = null;
              model.paymentId = null;
            }
            break;

          case 'TRANSFER_CREATED':
            if (model.txState === 'INITIATING') {
              model.txState = 'AWAITING_TAP';
              model.transferId = proposal.transferId;
            }
            break;

          case 'VERIFICATION_STARTED':
            if (model.txState === 'INITIATING') {
              model.txState = 'AWAITING_VERIFICATION';
            }
            break;

          case 'TAP_APPROVED':
            // Valid from AWAITING_TAP, AWAITING_VERIFICATION (orphan sweep
            // resolution) and CANCELLING (tap beat cancel). Silently discarded
            // in RECORDING/COMPLETED per the anti-glitch invariant.
            if (
              model.txState === 'AWAITING_TAP' ||
              model.txState === 'AWAITING_VERIFICATION' ||
              model.txState === 'CANCELLING'
            ) {
              model.txState = 'RECORDING';
              model.approvedAmountCents =
                typeof proposal.approvedAmount === 'number'
                  ? proposal.approvedAmount
                  : null;
            }
            break;

          case 'TAP_DECLINED':
            // Valid from INITIATING (immediate failure / 422 resolution),
            // AWAITING_TAP (poll saw FAILED/CANCELED, or partial rewrite),
            // and AWAITING_VERIFICATION (sweep found a failed transfer).
            if (
              model.txState === 'INITIATING' ||
              model.txState === 'AWAITING_TAP' ||
              model.txState === 'AWAITING_VERIFICATION'
            ) {
              model.txState = 'DECLINED';
              model.declineCode = declineCode;
            }
            break;

          case 'CANCEL_DECLINED':
            if (model.txState === 'CANCELLING') {
              model.txState = 'CANCELLED';
              model.declineCode = declineCode;
            }
            break;

          case 'PAYMENT_RECORDED':
            if (model.txState === 'RECORDING') {
              model.txState = 'COMPLETED';
              model.paymentId =
                proposal.paymentId === undefined ? null : proposal.paymentId;
            }
            break;

          case 'CANCEL_PAYMENT':
            if (
              model.txState === 'INITIATING' ||
              model.txState === 'AWAITING_TAP'
            ) {
              model.txState = 'CANCELLING';
            }
            break;

          case 'CANCEL_CONFIRMED':
            if (model.txState === 'CANCELLING') {
              model.txState = 'CANCELLED';
            }
            break;

          case 'EXIT_FLOW':
            if (
              model.txState === 'COMPLETED' ||
              model.txState === 'DECLINED' ||
              model.txState === 'CANCELLED'
            ) {
              model.txState = 'IDLE';
              model.orderId = null;
              model.amountCents = null;
              model.transferId = null;
              model.declineCode = null;
              model.approvedAmountCents = null;
              model.paymentId = null;
            }
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
    txState: raw.txState,
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