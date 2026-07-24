'use strict';

// Allowed transitions per state (after pre-FSM rewrites), mirroring the
// sam-fsm definition with enforceAllowedTransitions=true.
const TRANSITIONS = {
  IDLE:                  { INITIATE_PAYMENT: 'INITIATING' },
  INITIATING:            { TRANSFER_CREATED: 'AWAITING_TAP',
                           VERIFICATION_STARTED: 'AWAITING_VERIFICATION',
                           TAP_DECLINED: 'DECLINED',
                           CANCEL_PAYMENT: 'CANCELLING' },
  AWAITING_TAP:          { TAP_APPROVED: 'RECORDING',
                           TAP_DECLINED: 'DECLINED',
                           CANCEL_PAYMENT: 'CANCELLING' },
  AWAITING_VERIFICATION: { TAP_APPROVED: 'RECORDING',
                           TAP_DECLINED: 'DECLINED' },
  PROCESSING:            {},
  RECORDING:             { PAYMENT_RECORDED: 'COMPLETED' },
  COMPLETED:             { EXIT_FLOW: 'IDLE' },
  DECLINED:              { EXIT_FLOW: 'IDLE' },
  CANCELLING:            { CANCEL_CONFIRMED: 'CANCELLED',
                           TAP_APPROVED: 'RECORDING',
                           CANCEL_DECLINED: 'CANCELLED' },
  CANCELLED:             { EXIT_FLOW: 'IDLE' },
};

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
  const d = data || {};

  let effectiveAction = action;
  let declineCode = d.declineCode !== undefined ? d.declineCode : null;

  // ── Pre-FSM acceptor rewrites ─────────────────────────────────────────────
  // 1. TAP_DECLINED while CANCELLING → CANCEL_DECLINED (→ CANCELLED)
  if (action === 'TAP_DECLINED' && s.txState === 'CANCELLING') {
    effectiveAction = 'CANCEL_DECLINED';
  }
  // 2. Partial payment: TAP_APPROVED in AWAITING_TAP with approved < requested
  //    → rewritten to TAP_DECLINED with declineCode='PARTIAL_PAYMENT'
  if (
    action === 'TAP_APPROVED' &&
    s.txState === 'AWAITING_TAP' &&
    typeof d.approvedAmount === 'number' &&
    d.approvedAmount < (s.amountCents !== null && s.amountCents !== undefined ? s.amountCents : 0)
  ) {
    effectiveAction = 'TAP_DECLINED';
    declineCode = 'PARTIAL_PAYMENT';
  }

  // ── FSM guard (enforceAllowedTransitions) ─────────────────────────────────
  const allowed = TRANSITIONS[s.txState] || {};
  const nextState = allowed[effectiveAction];
  if (!nextState) {
    // Silently discarded — no state change, no field writes.
    return s;
  }
  s.txState = nextState;

  // ── Apply action data (guarded by post-transition state) ─────────────────
  if (effectiveAction === 'INITIATE_PAYMENT' && s.txState === 'INITIATING') {
    s.orderId = d.orderId;
    s.amountCents = d.amountCents;
    s.transferId = null;
    s.approvedAmountCents = null;
    s.paymentId = null;
    s.declineCode = null;
  }

  if (effectiveAction === 'TRANSFER_CREATED' && s.txState === 'AWAITING_TAP') {
    s.transferId = d.transferId;
  }

  if (effectiveAction === 'TAP_APPROVED' && s.txState === 'RECORDING') {
    s.approvedAmountCents = typeof d.approvedAmount === 'number' ? d.approvedAmount : null;
  }

  if ((effectiveAction === 'TAP_DECLINED' && s.txState === 'DECLINED') ||
      (effectiveAction === 'CANCEL_DECLINED' && s.txState === 'CANCELLED')) {
    s.declineCode = declineCode !== undefined && declineCode !== null ? declineCode : null;
  }

  if (effectiveAction === 'PAYMENT_RECORDED' && s.txState === 'COMPLETED') {
    s.paymentId = d.paymentId !== undefined && d.paymentId !== null ? d.paymentId : null;
  }

  if (effectiveAction === 'EXIT_FLOW' && s.txState === 'IDLE') {
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