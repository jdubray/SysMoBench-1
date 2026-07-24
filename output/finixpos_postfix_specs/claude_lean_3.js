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

// Allowed transitions per FSM state (source action names).
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

// Next txState for an accepted action.
const NEXT_STATE = {
  INITIATE_PAYMENT:     'INITIATING',
  TRANSFER_CREATED:     'AWAITING_TAP',
  VERIFICATION_STARTED: 'AWAITING_VERIFICATION',
  TAP_APPROVED:         'RECORDING',
  TAP_DECLINED:         'DECLINED',
  CANCEL_DECLINED:      'CANCELLED',
  PAYMENT_RECORDED:     'COMPLETED',
  CANCEL_PAYMENT:       'CANCELLING',
  CANCEL_CONFIRMED:     'CANCELLED',
  EXIT_FLOW:            'IDLE',
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

  let act = action;

  // ── Pre-FSM acceptor rewrites ──────────────────────────────────────────
  // 1. Partial-payment guard: TAP_APPROVED with approvedAmount < amountCents
  //    in AWAITING_TAP / CANCELLING / AWAITING_VERIFICATION → TAP_DECLINED
  //    with declineCode = PARTIAL_PAYMENT. Runs before the cancel rewrite.
  let partial = false;
  let partialApproved = null;
  let partialTransferId = null;
  if (
    act === 'TAP_APPROVED' &&
    (s.txState === 'AWAITING_TAP' ||
     s.txState === 'CANCELLING' ||
     s.txState === 'AWAITING_VERIFICATION') &&
    typeof data.approvedAmount === 'number' &&
    data.approvedAmount < (s.amountCents == null ? 0 : s.amountCents)
  ) {
    partial = true;
    partialApproved = data.approvedAmount;
    partialTransferId =
      data.transferId !== undefined && data.transferId !== null ? data.transferId : null;
    act = 'TAP_DECLINED';
  }

  // 2. CANCELLING + TAP_DECLINED → CANCEL_DECLINED (→ CANCELLED)
  if (act === 'TAP_DECLINED' && s.txState === 'CANCELLING') {
    act = 'CANCEL_DECLINED';
  }

  // ── FSM guard: reject actions not allowed from the current state ────────
  const allowed = ALLOWED[s.txState] || [];
  if (allowed.indexOf(act) === -1) {
    // Silently discarded — no state change.
    return s;
  }

  const dest = NEXT_STATE[act];
  s.txState = dest;

  // ── Apply action data to model (guarded by post-transition state) ───────
  if (act === 'INITIATE_PAYMENT' && s.txState === 'INITIATING') {
    s.orderId = data.orderId;
    s.amountCents = data.amountCents;
    s.transferId = null;
    s.approvedAmountCents = null;
    s.paymentId = null;
    s.declineCode = null;
  }

  if (act === 'TRANSFER_CREATED' && s.txState === 'AWAITING_TAP') {
    s.transferId = data.transferId;
  }

  if (act === 'TAP_APPROVED' && s.txState === 'RECORDING') {
    s.approvedAmountCents =
      typeof data.approvedAmount === 'number' ? data.approvedAmount : null;
    const t = data.transferId !== undefined && data.transferId !== null ? data.transferId : null;
    s.transferId = s.transferId == null ? t : s.transferId;
  }

  if ((act === 'TAP_DECLINED' && s.txState === 'DECLINED') ||
      (act === 'CANCEL_DECLINED' && s.txState === 'CANCELLED')) {
    if (partial) {
      s.declineCode = 'PARTIAL_PAYMENT';
      if (typeof partialApproved === 'number') {
        s.approvedAmountCents = partialApproved;
      }
      s.transferId = s.transferId == null ? partialTransferId : s.transferId;
    } else {
      s.declineCode = data.declineCode !== undefined ? (data.declineCode == null ? null : data.declineCode) : null;
    }
  }

  if (act === 'PAYMENT_RECORDED' && s.txState === 'COMPLETED') {
    s.paymentId = data.paymentId !== undefined && data.paymentId !== null ? data.paymentId : null;
  }

  if (act === 'EXIT_FLOW' && s.txState === 'IDLE') {
    s.orderId = null;
    s.amountCents = null;
    s.transferId = null;
    s.declineCode = null;
    s.approvedAmountCents = null;
    s.paymentId = null;
  }

  return s;
}

module.exports = { init, next };