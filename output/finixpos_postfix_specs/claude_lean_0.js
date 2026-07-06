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

// Allowed transitions per FSM state (public action names before rewrites)
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

function next(state, action, data) {
  const s = state;
  data = data || {};
  // Shallow copy — pure function
  const m = {
    txState: s.txState,
    orderId: s.orderId,
    amountCents: s.amountCents,
    transferId: s.transferId,
    declineCode: s.declineCode,
    approvedAmountCents: s.approvedAmountCents,
    paymentId: s.paymentId,
  };

  let act = action;

  // ── Pre-FSM acceptor rewrites ──────────────────────────────────────────
  // 1. Partial-payment guard: TAP_APPROVED with approved < requested in
  //    AWAITING_TAP / CANCELLING / AWAITING_VERIFICATION → rewrite to TAP_DECLINED
  //    with declineCode = 'PARTIAL_PAYMENT'.
  let rewrittenDeclineCode = null;
  let partialApprovedAmount = null;
  let partialTransferId = undefined;
  if (
    act === 'TAP_APPROVED' &&
    (s.txState === 'AWAITING_TAP' ||
     s.txState === 'CANCELLING' ||
     s.txState === 'AWAITING_VERIFICATION') &&
    typeof data.approvedAmount === 'number' &&
    data.approvedAmount < (s.amountCents == null ? 0 : s.amountCents)
  ) {
    act = 'TAP_DECLINED';
    rewrittenDeclineCode = 'PARTIAL_PAYMENT';
    partialApprovedAmount = data.approvedAmount;
    partialTransferId = (data.transferId != null) ? data.transferId : null;
  }

  // 2. CANCELLING + TAP_DECLINED → CANCEL_DECLINED (→ CANCELLED)
  if (act === 'TAP_DECLINED' && s.txState === 'CANCELLING') {
    act = 'CANCEL_DECLINED';
  }

  // ── FSM guard: reject actions not allowed from current state ────────────
  const allowed = ALLOWED[s.txState] || [];
  if (allowed.indexOf(act) === -1) {
    // Silently discarded — no state change.
    return m;
  }

  // ── Advance program counter + apply data ────────────────────────────────
  switch (act) {
    case 'INITIATE_PAYMENT':
      m.txState = 'INITIATING';
      m.orderId = data.orderId;
      m.amountCents = data.amountCents;
      m.transferId = null;
      m.approvedAmountCents = null;
      m.paymentId = null;
      m.declineCode = null;
      break;

    case 'TRANSFER_CREATED':
      m.txState = 'AWAITING_TAP';
      m.transferId = data.transferId;
      break;

    case 'VERIFICATION_STARTED':
      m.txState = 'AWAITING_VERIFICATION';
      break;

    case 'TAP_APPROVED':
      m.txState = 'RECORDING';
      m.approvedAmountCents = (typeof data.approvedAmount === 'number') ? data.approvedAmount : null;
      // Never clobber an id we already have.
      m.transferId = (m.transferId != null) ? m.transferId : ((data.transferId != null) ? data.transferId : null);
      break;

    case 'TAP_DECLINED':
      m.txState = 'DECLINED';
      if (rewrittenDeclineCode === 'PARTIAL_PAYMENT') {
        m.declineCode = 'PARTIAL_PAYMENT';
        if (partialApprovedAmount != null) {
          m.approvedAmountCents = partialApprovedAmount;
        }
        m.transferId = (m.transferId != null) ? m.transferId : ((partialTransferId != null) ? partialTransferId : null);
      } else {
        m.declineCode = (data.declineCode != null) ? data.declineCode : null;
      }
      break;

    case 'CANCEL_DECLINED':
      m.txState = 'CANCELLED';
      if (rewrittenDeclineCode === 'PARTIAL_PAYMENT') {
        m.declineCode = 'PARTIAL_PAYMENT';
        if (partialApprovedAmount != null) {
          m.approvedAmountCents = partialApprovedAmount;
        }
        m.transferId = (m.transferId != null) ? m.transferId : ((partialTransferId != null) ? partialTransferId : null);
      } else {
        m.declineCode = (data.declineCode != null) ? data.declineCode : null;
      }
      break;

    case 'PAYMENT_RECORDED':
      m.txState = 'COMPLETED';
      m.paymentId = (data.paymentId != null) ? data.paymentId : null;
      break;

    case 'CANCEL_PAYMENT':
      m.txState = 'CANCELLING';
      break;

    case 'CANCEL_CONFIRMED':
      m.txState = 'CANCELLED';
      break;

    case 'EXIT_FLOW':
      m.txState = 'IDLE';
      m.orderId = null;
      m.amountCents = null;
      m.transferId = null;
      m.declineCode = null;
      m.approvedAmountCents = null;
      m.paymentId = null;
      break;

    default:
      break;
  }

  return m;
}

module.exports = { init, next };