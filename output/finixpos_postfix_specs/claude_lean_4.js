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

// Allowed transitions per state (FSM enforceAllowedTransitions).
// The action name here is the pre-FSM (public) action; rewrites handled below.
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
  data = data || {};
  const m = {
    txState: state.txState,
    orderId: state.orderId,
    amountCents: state.amountCents,
    transferId: state.transferId,
    declineCode: state.declineCode,
    approvedAmountCents: state.approvedAmountCents,
    paymentId: state.paymentId,
  };

  let actionName = action;

  // ── Pre-FSM acceptor rewrites ──────────────────────────────────────────
  // 1. Partial-payment rewrite: TAP_APPROVED with approvedAmount < amountCents
  //    in AWAITING_TAP / CANCELLING / AWAITING_VERIFICATION → TAP_DECLINED
  //    with declineCode PARTIAL_PAYMENT (approvedAmount stashed).
  let partialApproved = null;
  if (
    actionName === 'TAP_APPROVED' &&
    (m.txState === 'AWAITING_TAP' ||
     m.txState === 'CANCELLING' ||
     m.txState === 'AWAITING_VERIFICATION') &&
    typeof data.approvedAmount === 'number' &&
    data.approvedAmount < (m.amountCents == null ? 0 : m.amountCents)
  ) {
    partialApproved = data.approvedAmount;
    actionName = 'TAP_DECLINED';
  }

  // 2. CANCELLING + TAP_DECLINED → CANCEL_DECLINED (→ CANCELLED)
  if (actionName === 'TAP_DECLINED' && m.txState === 'CANCELLING') {
    actionName = 'CANCEL_DECLINED';
  }

  // ── FSM transition check ───────────────────────────────────────────────
  const allowed = ALLOWED[m.txState] || [];
  if (allowed.indexOf(actionName) === -1) {
    // Rejected action — no state change.
    return m;
  }

  // ── Advance program counter + apply model fields ───────────────────────
  switch (actionName) {
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
      m.approvedAmountCents =
        typeof data.approvedAmount === 'number' ? data.approvedAmount : null;
      if (m.transferId == null) {
        m.transferId = data.transferId == null ? null : data.transferId;
      }
      break;

    case 'TAP_DECLINED':
      m.txState = 'DECLINED';
      if (partialApproved !== null) {
        m.declineCode = 'PARTIAL_PAYMENT';
        m.approvedAmountCents = partialApproved;
        if (m.transferId == null) {
          m.transferId = data.transferId == null ? null : data.transferId;
        }
      } else {
        m.declineCode = data.declineCode == null ? null : data.declineCode;
      }
      break;

    case 'CANCEL_DECLINED':
      m.txState = 'CANCELLED';
      if (partialApproved !== null) {
        m.declineCode = 'PARTIAL_PAYMENT';
        m.approvedAmountCents = partialApproved;
        if (m.transferId == null) {
          m.transferId = data.transferId == null ? null : data.transferId;
        }
      } else {
        m.declineCode = data.declineCode == null ? null : data.declineCode;
      }
      break;

    case 'PAYMENT_RECORDED':
      m.txState = 'COMPLETED';
      m.paymentId = data.paymentId == null ? null : data.paymentId;
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