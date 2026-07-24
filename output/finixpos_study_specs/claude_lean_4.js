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

// Allowed transitions per FSM state definition.
const ALLOWED = {
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

function next(state, action, data) {
  const s = {
    txState: state.txState,
    orderId: state.orderId,
    amountCents: state.amountCents,
    transferId: state.transferId,
    declineCode: state.declineCode,
    approvedAmountCents: state.approvedAmountCents,
    paymentId: state.paymentId,
  };
  data = data || {};

  // ── Pre-FSM acceptor rewrites ─────────────────────────────────────────
  let act = action;

  // 1. CANCELLING + TAP_DECLINED → CANCEL_DECLINED (→ CANCELLED)
  if (act === 'TAP_DECLINED' && s.txState === 'CANCELLING') {
    act = 'CANCEL_DECLINED';
  }

  // 2. Partial-payment rejection: AWAITING_TAP + TAP_APPROVED with approved < requested
  let partialDecline = false;
  if (
    act === 'TAP_APPROVED' &&
    s.txState === 'AWAITING_TAP' &&
    typeof data.approvedAmount === 'number' &&
    data.approvedAmount < (s.amountCents == null ? 0 : s.amountCents)
  ) {
    act = 'TAP_DECLINED';
    partialDecline = true;
  }

  // ── Enforce allowed transitions ───────────────────────────────────────
  const allowed = ALLOWED[s.txState] || [];
  if (allowed.indexOf(act) === -1) {
    // Action not allowed in this state — silently discarded, no change.
    return s;
  }

  // ── Advance FSM + apply model data ────────────────────────────────────
  switch (act) {
    case 'INITIATE_PAYMENT':
      s.txState = 'INITIATING';
      s.orderId = data.orderId;
      s.amountCents = data.amountCents;
      s.transferId = null;
      s.declineCode = null;
      s.approvedAmountCents = null;
      s.paymentId = null;
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