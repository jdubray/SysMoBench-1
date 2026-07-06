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

// Allowed transitions per FSM state definition.
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
  data = data || {};
  const s = clone(state);
  const cur = s.txState;

  // Pre-FSM rewrite: TAP_DECLINED in CANCELLING → CANCEL_DECLINED (→ CANCELLED)
  let act = action;
  if (act === 'TAP_DECLINED' && cur === 'CANCELLING') {
    act = 'CANCEL_DECLINED';
  }

  // Pre-FSM rewrite: partial-payment rejection.
  // TAP_APPROVED in AWAITING_TAP with approvedAmount < amountCents → TAP_DECLINED PARTIAL_PAYMENT
  let partialDecline = false;
  if (
    act === 'TAP_APPROVED' &&
    cur === 'AWAITING_TAP' &&
    typeof data.approvedAmount === 'number' &&
    data.approvedAmount < (s.amountCents == null ? 0 : s.amountCents)
  ) {
    act = 'TAP_DECLINED';
    partialDecline = true;
  }

  // Enforce allowed transitions — silently discard disallowed actions.
  const allowed = TRANSITIONS[cur] || [];
  if (allowed.indexOf(act) === -1) {
    return s;
  }

  switch (act) {
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
      if (partialDecline) {
        s.declineCode = 'PARTIAL_PAYMENT';
      } else {
        s.declineCode = data.declineCode != null ? data.declineCode : null;
      }
      return s;

    case 'CANCEL_DECLINED':
      s.txState = 'CANCELLED';
      s.declineCode = data.declineCode != null ? data.declineCode : null;
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