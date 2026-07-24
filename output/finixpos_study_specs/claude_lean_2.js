'use strict';

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

// Allowed transitions per FSM state (post pre-FSM rewrites handled separately).
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

function clone(state) {
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

function next(state, action, data) {
  data = data || {};
  const s = clone(state);
  let effectiveAction = action;

  // ── Pre-FSM acceptor rewrites ────────────────────────────────────────────
  // 1. CANCELLING + TAP_DECLINED → CANCEL_DECLINED (→ CANCELLED)
  if (action === 'TAP_DECLINED' && state.txState === 'CANCELLING') {
    effectiveAction = 'CANCEL_DECLINED';
  }

  // 2. Partial-payment rejection: AWAITING_TAP + TAP_APPROVED with
  //    approvedAmount < amountCents → TAP_DECLINED (declineCode PARTIAL_PAYMENT)
  let partialDecline = false;
  if (
    action === 'TAP_APPROVED' &&
    state.txState === 'AWAITING_TAP' &&
    typeof data.approvedAmount === 'number' &&
    data.approvedAmount < (state.amountCents == null ? 0 : state.amountCents)
  ) {
    effectiveAction = 'TAP_DECLINED';
    partialDecline = true;
  }

  // ── FSM enforceAllowedTransitions ────────────────────────────────────────
  const allowed = TRANSITIONS[state.txState] || [];
  if (allowed.indexOf(effectiveAction) === -1) {
    // Action not allowed in this state — silently discarded, no change.
    return s;
  }

  // ── Apply transition + model data ────────────────────────────────────────
  switch (effectiveAction) {
    case 'INITIATE_PAYMENT':
      s.txState = 'INITIATING';
      s.orderId = data.orderId;
      s.amountCents = data.amountCents;
      s.transferId = null;
      s.approvedAmountCents = null;
      s.paymentId = null;
      s.declineCode = null;
      break;

    case 'TRANSFER_CREATED':
      s.txState = 'AWAITING_TAP';
      s.transferId = data.transferId;
      break;

    case 'VERIFICATION_STARTED':
      s.txState = 'AWAITING_VERIFICATION';
      break;

    case 'TAP_APPROVED':
      s.txState = 'RECORDING';
      s.approvedAmountCents = typeof data.approvedAmount === 'number' ? data.approvedAmount : null;
      break;

    case 'TAP_DECLINED':
      s.txState = 'DECLINED';
      s.declineCode = partialDecline ? 'PARTIAL_PAYMENT' : (data.declineCode == null ? null : data.declineCode);
      break;

    case 'CANCEL_DECLINED':
      s.txState = 'CANCELLED';
      s.declineCode = data.declineCode == null ? null : data.declineCode;
      break;

    case 'PAYMENT_RECORDED':
      s.txState = 'COMPLETED';
      s.paymentId = data.paymentId == null ? null : data.paymentId;
      break;

    case 'CANCEL_PAYMENT':
      s.txState = 'CANCELLING';
      break;

    case 'CANCEL_CONFIRMED':
      s.txState = 'CANCELLED';
      break;

    case 'EXIT_FLOW':
      s.txState = 'IDLE';
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