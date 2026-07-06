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

// Allowed transitions per FSM state (public action names, post pre-FSM rewrites).
const ALLOWED = {
  IDLE:                  ['INITIATE_PAYMENT'],
  INITIATING:            ['TRANSFER_CREATED', 'VERIFICATION_STARTED', 'TAP_DECLINED', 'CANCEL_PAYMENT'],
  AWAITING_TAP:          ['TAP_APPROVED', 'TAP_DECLINED', 'CANCEL_PAYMENT'],
  AWAITING_VERIFICATION: ['TAP_APPROVED', 'TAP_DECLINED', 'CANCEL_PAYMENT'],
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
  const cur = s.txState;

  // ── Pre-FSM acceptor rewrites ──────────────────────────────────────────────
  let act = action;
  let declineCode = ('declineCode' in data) ? data.declineCode : undefined;
  let approvedAmount = ('approvedAmount' in data) ? data.approvedAmount : undefined;
  let partial = false;

  // 1. Partial-payment rejection: TAP_APPROVED with approvedAmount < amountCents
  //    in AWAITING_TAP / CANCELLING / AWAITING_VERIFICATION → rewrite to TAP_DECLINED.
  if (
    act === 'TAP_APPROVED' &&
    (cur === 'AWAITING_TAP' || cur === 'CANCELLING' || cur === 'AWAITING_VERIFICATION') &&
    typeof approvedAmount === 'number' &&
    approvedAmount < (s.amountCents == null ? 0 : s.amountCents)
  ) {
    act = 'TAP_DECLINED';
    declineCode = 'PARTIAL_PAYMENT';
    partial = true;
  }

  // 2. CANCELLING + TAP_DECLINED → CANCEL_DECLINED (→ CANCELLED)
  if (act === 'TAP_DECLINED' && cur === 'CANCELLING') {
    act = 'CANCEL_DECLINED';
  }

  // ── FSM guard: reject actions not allowed from the current state ────────────
  const allowed = ALLOWED[cur] || [];
  if (allowed.indexOf(act) === -1) {
    return s; // silently discarded, no state change
  }

  // ── Apply transition + model updates ───────────────────────────────────────
  switch (act) {
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
      s.approvedAmountCents =
        typeof data.approvedAmount === 'number' ? data.approvedAmount : null;
      s.transferId = s.transferId != null
        ? s.transferId
        : (('transferId' in data && data.transferId != null) ? data.transferId : null);
      break;

    case 'TAP_DECLINED':
      s.txState = 'DECLINED';
      s.declineCode = declineCode == null ? null : declineCode;
      if (partial) {
        if (typeof approvedAmount === 'number') {
          s.approvedAmountCents = approvedAmount;
        }
        s.transferId = s.transferId != null
          ? s.transferId
          : (('transferId' in data && data.transferId != null) ? data.transferId : null);
      }
      break;

    case 'CANCEL_DECLINED':
      s.txState = 'CANCELLED';
      s.declineCode = declineCode == null ? null : declineCode;
      if (partial) {
        if (typeof approvedAmount === 'number') {
          s.approvedAmountCents = approvedAmount;
        }
        s.transferId = s.transferId != null
          ? s.transferId
          : (('transferId' in data && data.transferId != null) ? data.transferId : null);
      }
      break;

    case 'PAYMENT_RECORDED':
      s.txState = 'COMPLETED';
      s.paymentId = ('paymentId' in data && data.paymentId != null) ? data.paymentId : null;
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
      return s;
  }

  return s;
}

module.exports = { init, next };