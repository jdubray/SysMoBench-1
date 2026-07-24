'use strict';

/**
 * Pure transition function for the PAX A920 / Finix terminal payment workflow.
 *
 * Observable state keys:
 *   txState, orderId, amountCents, transferId, declineCode,
 *   approvedAmountCents, paymentId
 */

function init() {
  return {
    txState: 'IDLE',
    orderId: null,
    amountCents: null,
    transferId: null,
    declineCode: null,
    approvedAmountCents: null,
    paymentId: null,
  };
}

// FSM allowed transitions (state -> action -> next state), mirroring
// terminalPaymentFSM with enforceAllowedTransitions = true.
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

function next(state, action, data) {
  data = data || {};

  // Effective action name and effective proposal decline code, after the
  // pre-FSM acceptor rewrites in the real implementation.
  let effAction = action;
  let declineCode =
    Object.prototype.hasOwnProperty.call(data, 'declineCode')
      ? (data.declineCode != null ? data.declineCode : null)
      : null;

  // Rewrite 1: TAP_DECLINED while CANCELLING → CANCEL_DECLINED (→ CANCELLED)
  if (action === 'TAP_DECLINED' && state.txState === 'CANCELLING') {
    effAction = 'CANCEL_DECLINED';
  }

  // Rewrite 2: partial-payment rejection — TAP_APPROVED in AWAITING_TAP with
  // approvedAmount strictly below the requested amount becomes TAP_DECLINED
  // with declineCode = 'PARTIAL_PAYMENT'.
  if (
    action === 'TAP_APPROVED' &&
    state.txState === 'AWAITING_TAP' &&
    typeof data.approvedAmount === 'number' &&
    data.approvedAmount < (state.amountCents != null ? state.amountCents : 0)
  ) {
    effAction = 'TAP_DECLINED';
    declineCode = 'PARTIAL_PAYMENT';
  }

  // FSM guard: silently discard actions not allowed from the current state
  // (enforceAllowedTransitions — no state change, no field updates).
  const allowed = TRANSITIONS[state.txState] || {};
  const nextTxState = allowed[effAction];
  if (nextTxState === undefined) {
    return {
      txState: state.txState,
      orderId: state.orderId,
      amountCents: state.amountCents,
      transferId: state.transferId,
      declineCode: state.declineCode,
      approvedAmountCents: state.approvedAmountCents,
      paymentId: state.paymentId,
    };
  }

  const s = {
    txState: nextTxState,
    orderId: state.orderId,
    amountCents: state.amountCents,
    transferId: state.transferId,
    declineCode: state.declineCode,
    approvedAmountCents: state.approvedAmountCents,
    paymentId: state.paymentId,
  };

  // Apply action data to the model (guarded by post-transition state, as in
  // the source's post-FSM acceptor).
  switch (effAction) {
    case 'INITIATE_PAYMENT':
      // IDLE → INITIATING: set identity fields, reset transaction fields.
      s.orderId = data.orderId;
      s.amountCents = data.amountCents;
      s.transferId = null;
      s.declineCode = null;
      s.approvedAmountCents = null;
      s.paymentId = null;
      break;

    case 'TRANSFER_CREATED':
      // INITIATING → AWAITING_TAP
      s.transferId = data.transferId;
      break;

    case 'VERIFICATION_STARTED':
      // INITIATING → AWAITING_VERIFICATION: no observable field changes.
      break;

    case 'TAP_APPROVED':
      // → RECORDING
      s.approvedAmountCents =
        typeof data.approvedAmount === 'number' ? data.approvedAmount : null;
      break;

    case 'TAP_DECLINED':
      // → DECLINED
      s.declineCode = declineCode != null ? declineCode : null;
      break;

    case 'CANCEL_DECLINED':
      // CANCELLING → CANCELLED (rewritten TAP_DECLINED carries declineCode)
      s.declineCode = declineCode != null ? declineCode : null;
      break;

    case 'PAYMENT_RECORDED':
      // RECORDING → COMPLETED
      s.paymentId = data.paymentId != null ? data.paymentId : null;
      break;

    case 'CANCEL_PAYMENT':
      // → CANCELLING: no field changes.
      break;

    case 'CANCEL_CONFIRMED':
      // CANCELLING → CANCELLED: no field changes (no decline code set).
      break;

    case 'EXIT_FLOW':
      // → IDLE: clear all transaction fields.
      s.orderId = null;
      s.amountCents = null;
      s.transferId = null;
      s.declineCode = null;
      s.approvedAmountCents = null;
      s.paymentId = null;
      break;

    default:
      break;
  }

  return s;
}

module.exports = { init, next };