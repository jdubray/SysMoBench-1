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

// Allowed transitions per FSM state (which action names are accepted).
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

  // Pre-FSM acceptor rewrites of the action name.
  let effectiveAction = action;
  let declineCode = ('declineCode' in data) ? data.declineCode : null;

  // Rewrite 1: CANCELLING + TAP_DECLINED → CANCEL_DECLINED (→ CANCELLED)
  if (action === 'TAP_DECLINED' && s.txState === 'CANCELLING') {
    effectiveAction = 'CANCEL_DECLINED';
  }

  // Rewrite 2: partial-payment rejection.
  // TAP_APPROVED in AWAITING_TAP where approvedAmount < amountCents → TAP_DECLINED.
  if (
    action === 'TAP_APPROVED' &&
    s.txState === 'AWAITING_TAP' &&
    typeof data.approvedAmount === 'number' &&
    data.approvedAmount < (s.amountCents == null ? 0 : s.amountCents)
  ) {
    effectiveAction = 'TAP_DECLINED';
    declineCode = 'PARTIAL_PAYMENT';
  }

  // Enforce allowed transitions: if the effective action is not permitted from
  // the current state, silently discard (no state change).
  const allowed = ALLOWED[s.txState] || [];
  if (allowed.indexOf(effectiveAction) === -1) {
    return s;
  }

  switch (effectiveAction) {
    case 'INITIATE_PAYMENT':
      s.txState = 'INITIATING';
      s.orderId = data.orderId != null ? data.orderId : null;
      s.amountCents = typeof data.amountCents === 'number' ? data.amountCents : null;
      s.transferId = null;
      s.declineCode = null;
      s.approvedAmountCents = null;
      s.paymentId = null;
      return s;

    case 'TRANSFER_CREATED':
      s.txState = 'AWAITING_TAP';
      s.transferId = data.transferId != null ? data.transferId : null;
      return s;

    case 'VERIFICATION_STARTED':
      s.txState = 'AWAITING_VERIFICATION';
      return s;

    case 'TAP_APPROVED':
      s.txState = 'RECORDING';
      s.approvedAmountCents = typeof data.approvedAmount === 'number' ? data.approvedAmount : null;
      return s;

    case 'TAP_DECLINED':
      s.txState = 'DECLINED';
      s.declineCode = declineCode != null ? declineCode : null;
      return s;

    case 'CANCEL_DECLINED':
      s.txState = 'CANCELLED';
      s.declineCode = declineCode != null ? declineCode : null;
      return s;

    case 'PAYMENT_RECORDED':
      s.txState = 'COMPLETED';
      s.paymentId = data.paymentId != null ? data.paymentId : null;
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