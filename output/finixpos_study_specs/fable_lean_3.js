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

  // ── Pre-FSM acceptor rewrites (mirrors the production acceptor order) ──
  let act = action;
  let declineCode = d.declineCode !== undefined ? d.declineCode : null;

  // 1. TAP_DECLINED while CANCELLING → internal CANCEL_DECLINED (→ CANCELLED)
  if (act === 'TAP_DECLINED' && s.txState === 'CANCELLING') {
    act = 'CANCEL_DECLINED';
  }

  // 2. Partial-payment rejection: only from AWAITING_TAP, strict less-than
  if (
    act === 'TAP_APPROVED' &&
    s.txState === 'AWAITING_TAP' &&
    typeof d.approvedAmount === 'number' &&
    d.approvedAmount < (s.amountCents !== null && s.amountCents !== undefined ? s.amountCents : 0)
  ) {
    act = 'TAP_DECLINED';
    declineCode = 'PARTIAL_PAYMENT';
  }

  // ── FSM: allowed transitions per state ──
  const allowed = {
    IDLE:                  { INITIATE_PAYMENT: 'INITIATING' },
    INITIATING:            { TRANSFER_CREATED: 'AWAITING_TAP', VERIFICATION_STARTED: 'AWAITING_VERIFICATION', TAP_DECLINED: 'DECLINED', CANCEL_PAYMENT: 'CANCELLING' },
    AWAITING_TAP:          { TAP_APPROVED: 'RECORDING', TAP_DECLINED: 'DECLINED', CANCEL_PAYMENT: 'CANCELLING' },
    AWAITING_VERIFICATION: { TAP_APPROVED: 'RECORDING', TAP_DECLINED: 'DECLINED' },
    PROCESSING:            {},
    RECORDING:             { PAYMENT_RECORDED: 'COMPLETED' },
    COMPLETED:             { EXIT_FLOW: 'IDLE' },
    DECLINED:              { EXIT_FLOW: 'IDLE' },
    CANCELLING:            { CANCEL_CONFIRMED: 'CANCELLED', TAP_APPROVED: 'RECORDING', CANCEL_DECLINED: 'CANCELLED' },
    CANCELLED:             { EXIT_FLOW: 'IDLE' },
  };

  const table = allowed[s.txState] || {};
  const nextState = table[act];
  if (!nextState) {
    // Silently rejected — no state change, no field writes
    return s;
  }

  s.txState = nextState;

  // ── Apply action data (guarded by expected post-transition state) ──
  if (act === 'INITIATE_PAYMENT' && s.txState === 'INITIATING') {
    s.orderId = d.orderId !== undefined ? d.orderId : null;
    s.amountCents = d.amountCents !== undefined ? d.amountCents : null;
    s.transferId = null;
    s.declineCode = null;
    s.approvedAmountCents = null;
    s.paymentId = null;
  }

  if (act === 'TRANSFER_CREATED' && s.txState === 'AWAITING_TAP') {
    s.transferId = d.transferId;
  }

  if (act === 'TAP_APPROVED' && s.txState === 'RECORDING') {
    s.approvedAmountCents = typeof d.approvedAmount === 'number' ? d.approvedAmount : null;
  }

  if ((act === 'TAP_DECLINED' && s.txState === 'DECLINED') ||
      (act === 'CANCEL_DECLINED' && s.txState === 'CANCELLED')) {
    s.declineCode = declineCode !== undefined && declineCode !== null ? declineCode : null;
  }

  if (act === 'PAYMENT_RECORDED' && s.txState === 'COMPLETED') {
    s.paymentId = d.paymentId !== undefined && d.paymentId !== null ? d.paymentId : null;
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