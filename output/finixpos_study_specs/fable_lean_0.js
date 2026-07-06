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

function copy(state) {
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

// FSM transition table: action -> next state, per allowed source states.
const ALLOWED = {
  IDLE:                  { INITIATE_PAYMENT: 'INITIATING' },
  INITIATING:            {
    TRANSFER_CREATED:     'AWAITING_TAP',
    VERIFICATION_STARTED: 'AWAITING_VERIFICATION',
    TAP_DECLINED:         'DECLINED',
    CANCEL_PAYMENT:       'CANCELLING',
  },
  AWAITING_TAP:          {
    TAP_APPROVED:   'RECORDING',
    TAP_DECLINED:   'DECLINED',
    CANCEL_PAYMENT: 'CANCELLING',
  },
  AWAITING_VERIFICATION: {
    TAP_APPROVED: 'RECORDING',
    TAP_DECLINED: 'DECLINED',
  },
  PROCESSING:            {},
  RECORDING:             { PAYMENT_RECORDED: 'COMPLETED' },
  COMPLETED:             { EXIT_FLOW: 'IDLE' },
  DECLINED:              { EXIT_FLOW: 'IDLE' },
  CANCELLING:            {
    CANCEL_CONFIRMED: 'CANCELLED',
    TAP_APPROVED:     'RECORDING',
    CANCEL_DECLINED:  'CANCELLED',
  },
  CANCELLED:             { EXIT_FLOW: 'IDLE' },
};

function next(state, action, data) {
  const s = copy(state);
  data = data || {};

  let effectiveAction = action;
  let declineCode = data.declineCode !== undefined ? data.declineCode : null;

  // ── Pre-FSM acceptor rewrites ───────────────────────────────────────────
  // 1. TAP_DECLINED while CANCELLING → CANCEL_DECLINED (→ CANCELLED)
  if (action === 'TAP_DECLINED' && state.txState === 'CANCELLING') {
    effectiveAction = 'CANCEL_DECLINED';
  }

  // 2. Partial payment: TAP_APPROVED in AWAITING_TAP with approved < requested
  //    → rewritten to TAP_DECLINED with declineCode='PARTIAL_PAYMENT'
  if (
    action === 'TAP_APPROVED' &&
    state.txState === 'AWAITING_TAP' &&
    typeof data.approvedAmount === 'number' &&
    data.approvedAmount < (state.amountCents != null ? state.amountCents : 0)
  ) {
    effectiveAction = 'TAP_DECLINED';
    declineCode = 'PARTIAL_PAYMENT';
  }

  // ── FSM: enforceAllowedTransitions — silently discard disallowed actions ─
  const table = ALLOWED[state.txState] || {};
  const nextState = table[effectiveAction];
  if (!nextState) {
    return s; // rejected: no state change, no model mutation
  }
  s.txState = nextState;

  // ── Apply action data to model (guarded by post-transition state) ────────
  if (effectiveAction === 'INITIATE_PAYMENT' && s.txState === 'INITIATING') {
    s.orderId = data.orderId;
    s.amountCents = data.amountCents;
    s.transferId = null;
    s.approvedAmountCents = null;
    s.paymentId = null;
    s.declineCode = null;
  }

  if (effectiveAction === 'TRANSFER_CREATED' && s.txState === 'AWAITING_TAP') {
    s.transferId = data.transferId;
  }

  if (effectiveAction === 'TAP_APPROVED' && s.txState === 'RECORDING') {
    s.approvedAmountCents =
      typeof data.approvedAmount === 'number' ? data.approvedAmount : null;
  }

  if (
    (effectiveAction === 'TAP_DECLINED' && s.txState === 'DECLINED') ||
    (effectiveAction === 'CANCEL_DECLINED' && s.txState === 'CANCELLED')
  ) {
    s.declineCode = declineCode !== undefined && declineCode !== null ? declineCode : null;
  }

  if (effectiveAction === 'PAYMENT_RECORDED' && s.txState === 'COMPLETED') {
    s.paymentId = data.paymentId != null ? data.paymentId : null;
  }

  if (effectiveAction === 'EXIT_FLOW' && s.txState === 'IDLE') {
    s.orderId = null;
    s.amountCents = null;
    s.transferId = null;
    s.approvedAmountCents = null;
    s.paymentId = null;
    s.declineCode = null;
  }

  return s;
}

module.exports = { init, next };