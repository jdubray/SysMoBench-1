'use strict';

// ============================================================================
// SAM specification: baanbaan Merchant/v2 — POS <-> PAX A920 <-> Finix
// Terminal payment workflow, observable single-step behavior.
//
// Observable model (exactly seven keys):
//   txState, orderId, amountCents, transferId,
//   declineCode, approvedAmountCents, paymentId
//
// FSM (mirrors terminalPaymentFSM with enforceAllowedTransitions=true —
// actions arriving in a state where the workflow does not act are no-ops):
//
//   IDLE                  --INITIATE_PAYMENT-->     INITIATING
//   INITIATING            --TRANSFER_CREATED-->     AWAITING_TAP
//   INITIATING            --VERIFICATION_STARTED--> AWAITING_VERIFICATION
//   INITIATING            --TAP_DECLINED-->         DECLINED
//   INITIATING            --CANCEL_PAYMENT-->       CANCELLING
//   AWAITING_TAP          --TAP_APPROVED-->         RECORDING
//   AWAITING_TAP          --TAP_DECLINED-->         DECLINED
//   AWAITING_TAP          --CANCEL_PAYMENT-->       CANCELLING
//   AWAITING_VERIFICATION --TAP_APPROVED-->         RECORDING
//   AWAITING_VERIFICATION --TAP_DECLINED-->         DECLINED
//   RECORDING             --PAYMENT_RECORDED-->     COMPLETED
//   CANCELLING            --CANCEL_CONFIRMED-->     CANCELLED
//   CANCELLING            --TAP_APPROVED-->         RECORDING   (tap beat cancel)
//   CANCELLING            --TAP_DECLINED-->         CANCELLED   (pre-FSM rewrite
//                                                    to internal CANCEL_DECLINED)
//   COMPLETED/DECLINED/CANCELLED --EXIT_FLOW-->     IDLE
//
// Pre-FSM acceptor rewrites (from the production source):
//   1. CANCELLING + TAP_DECLINED         => CANCEL_DECLINED  (-> CANCELLED)
//   2. AWAITING_TAP + TAP_APPROVED with approvedAmount < amountCents (strict)
//      => TAP_DECLINED with declineCode = 'PARTIAL_PAYMENT' (-> DECLINED).
//      Overpayment (tip-on-terminal) stays approved. Guard applies ONLY in
//      AWAITING_TAP, matching the source acceptor's txState check.
//
// Anti-glitch invariant: TAP_APPROVED / TAP_DECLINED (or any other action)
// arriving in RECORDING or COMPLETED — or any state that does not allow the
// transition — is silently discarded: no state change, no field writes.
// ============================================================================

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
        declineCode: data.declineCode !== undefined ? data.declineCode : null,
      }),
      // PAYMENT_RECORDED
      (data = {}) => ({
        __name: 'PAYMENT_RECORDED',
        paymentId: data.paymentId !== undefined ? data.paymentId : null,
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

        // Effective action + effective payload after pre-FSM rewrites
        let action = proposal.__name;
        let declineCode =
          proposal.declineCode !== undefined ? proposal.declineCode : null;

        // Rewrite 1: TAP_DECLINED while CANCELLING => internal CANCEL_DECLINED
        if (action === 'TAP_DECLINED' && model.txState === 'CANCELLING') {
          action = 'CANCEL_DECLINED';
        }

        // Rewrite 2: partial authorization in AWAITING_TAP => TAP_DECLINED
        // (strict less-than: overpayment = on-device tip, stays approved)
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

        switch (action) {
          case 'INITIATE_PAYMENT':
            if (model.txState === 'IDLE') {
              model.txState = 'INITIATING';
              model.orderId =
                proposal.orderId !== undefined ? proposal.orderId : null;
              model.amountCents =
                proposal.amountCents !== undefined ? proposal.amountCents : null;
              // Fresh transaction: clear all per-transaction fields
              model.transferId = null;
              model.declineCode = null;
              model.approvedAmountCents = null;
              model.paymentId = null;
            }
            break;

          case 'TRANSFER_CREATED':
            if (model.txState === 'INITIATING') {
              model.txState = 'AWAITING_TAP';
              model.transferId =
                proposal.transferId !== undefined ? proposal.transferId : null;
            }
            break;

          case 'VERIFICATION_STARTED':
            if (model.txState === 'INITIATING') {
              model.txState = 'AWAITING_VERIFICATION';
            }
            break;

          case 'TAP_APPROVED':
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
            if (
              model.txState === 'INITIATING' ||
              model.txState === 'AWAITING_TAP' ||
              model.txState === 'AWAITING_VERIFICATION'
            ) {
              model.txState = 'DECLINED';
              model.declineCode = declineCode !== undefined ? declineCode : null;
            }
            break;

          case 'CANCEL_DECLINED':
            // Internal action — only reachable via the CANCELLING rewrite
            if (model.txState === 'CANCELLING') {
              model.txState = 'CANCELLED';
              model.declineCode = declineCode !== undefined ? declineCode : null;
            }
            break;

          case 'PAYMENT_RECORDED':
            if (model.txState === 'RECORDING') {
              model.txState = 'COMPLETED';
              model.paymentId =
                proposal.paymentId !== undefined ? proposal.paymentId : null;
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

const sanitizeReplacer = (key, value) => {
  if (typeof key === 'string' && key.startsWith('__')) return undefined;
  if (typeof value === 'function') return undefined;
  return value;
};

const getState = () => {
  const raw = JSON.parse(JSON.stringify(instance({}).state(), sanitizeReplacer));
  return {
    txState: raw.txState !== undefined ? raw.txState : null,
    orderId: raw.orderId !== undefined ? raw.orderId : null,
    amountCents: raw.amountCents !== undefined ? raw.amountCents : null,
    transferId: raw.transferId !== undefined ? raw.transferId : null,
    declineCode: raw.declineCode !== undefined ? raw.declineCode : null,
    approvedAmountCents:
      raw.approvedAmountCents !== undefined ? raw.approvedAmountCents : null,
    paymentId: raw.paymentId !== undefined ? raw.paymentId : null,
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