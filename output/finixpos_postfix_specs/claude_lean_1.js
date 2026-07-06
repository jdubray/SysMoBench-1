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

// Allowed transitions per source FSM `states` definition.
const ALLOWED = {
  IDLE:                  ['INITIATE_PAYMENT'],
  INITIATING:            ['TRANSFER_CREATED', 'VERIFICATION_STARTED', 'TAP_DECLINED', 'CANCEL_PAYMENT'],
  AWAITING_TAP:          ['TAP_APPROVED', 'TAP_DECLINED', 'CANCEL_PAYMENT'],
  AWAITING_VERIFICATION: ['TAP_APPROVED', 'TAP_DECLINED', 'CANCEL_PAYMENT'],
  PROCESSING:            [],
  RECORDING:             ['PAYMENT_RECORDED'],
  COMPLETED:             ['EXIT_FLOW'],
  DECLINED:              ['EXIT_FLOW'],
  CANCELLING:            ['CANCEL_CONFIRMED', 'TAP_APPROVED', 'CANCEL_DECLINED'],
  CANCELLED:             ['EXIT_FLOW'],
};

// Next-state per action name (post FSM).
const ACTION_TARGET = {
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

  // ── Pre-FSM acceptor rewrites ──────────────────────────────────────────
  let actionName = action;

  // 1. Partial-payment guard: TAP_APPROVED with approvedAmount < amountCents
  //    in AWAITING_TAP / CANCELLING / AWAITING_VERIFICATION → TAP_DECLINED
  //    (declineCode = PARTIAL_PAYMENT). Overpayments (tip) are legitimate.
  let rewrittenDeclineCode = null;
  let partialApprovedAmount = null;
  let partialTransferId = undefined;
  if (
    actionName === 'TAP_APPROVED' &&
    (s.txState === 'AWAITING_TAP' ||
     s.txState === 'CANCELLING' ||
     s.txState === 'AWAITING_VERIFICATION') &&
    typeof data.approvedAmount === 'number' &&
    data.approvedAmount < (s.amountCents == null ? 0 : s.amountCents)
  ) {
    actionName = 'TAP_DECLINED';
    rewrittenDeclineCode = 'PARTIAL_PAYMENT';
    partialApprovedAmount = data.approvedAmount;
    partialTransferId = (data.transferId != null) ? data.transferId : null;
  }

  // 2. CANCELLING + TAP_DECLINED → CANCEL_DECLINED (→ CANCELLED)
  if (actionName === 'TAP_DECLINED' && s.txState === 'CANCELLING') {
    actionName = 'CANCEL_DECLINED';
  }

  // ── FSM enforcement ────────────────────────────────────────────────────
  const allowed = ALLOWED[s.txState] || [];
  if (allowed.indexOf(actionName) === -1) {
    // Rejected — no state change (anti-glitch invariant).
    return s;
  }

  const target = ACTION_TARGET[actionName];
  s.txState = target;

  // ── Apply action data to model (post-transition) ───────────────────────
  if (actionName === 'INITIATE_PAYMENT') {
    s.orderId = data.orderId;
    s.amountCents = data.amountCents;
    s.transferId = null;
    s.approvedAmountCents = null;
    s.paymentId = null;
    s.declineCode = null;
  } else if (actionName === 'TRANSFER_CREATED') {
    s.transferId = data.transferId;
  } else if (actionName === 'TAP_APPROVED') {
    s.approvedAmountCents = (typeof data.approvedAmount === 'number') ? data.approvedAmount : null;
    // Never clobber an existing transfer id.
    if (s.transferId == null) {
      s.transferId = (data.transferId != null) ? data.transferId : null;
    }
  } else if (actionName === 'TAP_DECLINED' || actionName === 'CANCEL_DECLINED') {
    s.declineCode = (rewrittenDeclineCode != null)
      ? rewrittenDeclineCode
      : ((data.declineCode != null) ? data.declineCode : null);
    if (s.declineCode === 'PARTIAL_PAYMENT') {
      if (typeof partialApprovedAmount === 'number') {
        s.approvedAmountCents = partialApprovedAmount;
      }
      if (s.transferId == null) {
        s.transferId = (partialTransferId != null) ? partialTransferId : null;
      }
    }
  } else if (actionName === 'PAYMENT_RECORDED') {
    s.paymentId = (data.paymentId != null) ? data.paymentId : null;
  } else if (actionName === 'EXIT_FLOW') {
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