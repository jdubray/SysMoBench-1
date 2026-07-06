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

// Allowed transitions per FSM state (action -> allowed only from these states)
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

function next(state, action, data) {
  const d = data || {};
  const s = {
    txState: state.txState,
    orderId: state.orderId,
    amountCents: state.amountCents,
    transferId: state.transferId,
    declineCode: state.declineCode,
    approvedAmountCents: state.approvedAmountCents,
    paymentId: state.paymentId,
  };

  let effAction = action;

  // Pre-FSM acceptor rewrites:
  // 1. CANCELLING + TAP_DECLINED -> CANCEL_DECLINED (-> CANCELLED)
  if (effAction === 'TAP_DECLINED' && s.txState === 'CANCELLING') {
    effAction = 'CANCEL_DECLINED';
  }

  // 2. Partial-payment rejection: AWAITING_TAP + TAP_APPROVED with approved < requested
  let partialDecline = false;
  if (
    effAction === 'TAP_APPROVED' &&
    s.txState === 'AWAITING_TAP' &&
    typeof d.approvedAmount === 'number' &&
    d.approvedAmount < (s.amountCents == null ? 0 : s.amountCents)
  ) {
    effAction = 'TAP_DECLINED';
    partialDecline = true;
  }

  // Enforce allowed transitions — if not allowed from current state, no-op.
  const allowed = TRANSITIONS[s.txState] || [];
  if (allowed.indexOf(effAction) === -1) {
    return s;
  }

  switch (effAction) {
    case 'INITIATE_PAYMENT':
      s.txState = 'INITIATING';
      s.orderId = d.orderId;
      s.amountCents = d.amountCents;
      s.transferId = null;
      s.approvedAmountCents = null;
      s.paymentId = null;
      s.declineCode = null;
      return s;

    case 'TRANSFER_CREATED':
      s.txState = 'AWAITING_TAP';
      s.transferId = d.transferId;
      return s;

    case 'VERIFICATION_STARTED':
      s.txState = 'AWAITING_VERIFICATION';
      return s;

    case 'TAP_APPROVED':
      s.txState = 'RECORDING';
      s.approvedAmountCents = typeof d.approvedAmount === 'number' ? d.approvedAmount : null;
      return s;

    case 'TAP_DECLINED':
      s.txState = 'DECLINED';
      s.declineCode = partialDecline ? 'PARTIAL_PAYMENT' : (d.declineCode == null ? null : d.declineCode);
      return s;

    case 'CANCEL_DECLINED':
      s.txState = 'CANCELLED';
      s.declineCode = d.declineCode == null ? null : d.declineCode;
      return s;

    case 'PAYMENT_RECORDED':
      s.txState = 'COMPLETED';
      s.paymentId = d.paymentId == null ? null : d.paymentId;
      return s;

    case 'CANCEL_PAYMENT':
      s.txState = 'CANCELLING';
      return s;

    case 'CANCEL_CONFIRMED':
      s.txState = 'CANCELLED';
      return s;

    case 'EXIT_FLOW':
      s.txState = 'IDLE';
      s.orderId = null;
      s.amountCents = null;
      s.transferId = null;
      s.declineCode = null;
      s.approvedAmountCents = null;
      s.paymentId = null;
      return s;

    default:
      return s;
  }
}

module.exports = { init, next };