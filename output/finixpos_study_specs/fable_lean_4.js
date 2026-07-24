'use strict';

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
  data = data || {};

  // Working copies of action name + proposal fields (pre-FSM acceptor rewrites)
  let actionName = action;
  let declineCode = data.declineCode !== undefined ? data.declineCode : null;

  // ── Pre-FSM acceptor #1: CANCELLING + TAP_DECLINED → CANCEL_DECLINED ──
  if (actionName === 'TAP_DECLINED' && state.txState === 'CANCELLING') {
    actionName = 'CANCEL_DECLINED';
  }

  // ── Pre-FSM acceptor #2: partial-payment rejection ──
  // Only from AWAITING_TAP; approved < requested (strict) → TAP_DECLINED
  if (
    actionName === 'TAP_APPROVED' &&
    state.txState === 'AWAITING_TAP' &&
    typeof data.approvedAmount === 'number' &&
    data.approvedAmount < (state.amountCents !== null && state.amountCents !== undefined
      ? state.amountCents
      : 0)
  ) {
    actionName = 'TAP_DECLINED';
    declineCode = 'PARTIAL_PAYMENT';
  }

  // ── FSM: enforceAllowedTransitions — silently discard disallowed actions ──
  const allowed = TRANSITIONS[state.txState] || {};
  const nextTxState = allowed[actionName];
  if (nextTxState === undefined) {
    // Rejected: no state change, no field updates.
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

  // ── Post-FSM acceptor: apply action data to the model ──
  const m = {
    txState: nextTxState,
    orderId: state.orderId,
    amountCents: state.amountCents,
    transferId: state.transferId,
    declineCode: state.declineCode,
    approvedAmountCents: state.approvedAmountCents,
    paymentId: state.paymentId,
  };

  if (actionName === 'INITIATE_PAYMENT' && m.txState === 'INITIATING') {
    m.orderId = data.orderId;
    m.amountCents = data.amountCents;
    m.transferId = null;
    m.approvedAmountCents = null;
    m.paymentId = null;
    m.declineCode = null;
  }

  if (actionName === 'TRANSFER_CREATED' && m.txState === 'AWAITING_TAP') {
    m.transferId = data.transferId;
  }

  if (actionName === 'TAP_APPROVED' && m.txState === 'RECORDING') {
    m.approvedAmountCents =
      typeof data.approvedAmount === 'number' ? data.approvedAmount : null;
  }

  if (
    (actionName === 'TAP_DECLINED' && m.txState === 'DECLINED') ||
    (actionName === 'CANCEL_DECLINED' && m.txState === 'CANCELLED')
  ) {
    m.declineCode = declineCode !== undefined && declineCode !== null ? declineCode : null;
  }

  if (actionName === 'PAYMENT_RECORDED' && m.txState === 'COMPLETED') {
    m.paymentId =
      data.paymentId !== undefined && data.paymentId !== null ? data.paymentId : null;
  }

  if (actionName === 'EXIT_FLOW' && m.txState === 'IDLE') {
    m.orderId = null;
    m.amountCents = null;
    m.transferId = null;
    m.declineCode = null;
    m.approvedAmountCents = null;
    m.paymentId = null;
  }

  return m;
}

module.exports = { init, next };