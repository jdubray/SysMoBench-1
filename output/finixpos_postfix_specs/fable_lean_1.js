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

  // ── Pre-FSM acceptor rewrites (mirrors the acceptor chain) ────────────────
  let effAction = action;
  let declineCode = d.declineCode !== undefined ? d.declineCode : null;
  let partialApproved = null; // approvedAmount carried through a partial rewrite
  let partialTransferId = null;

  if (
    action === 'TAP_APPROVED' &&
    (s.txState === 'AWAITING_TAP' ||
      s.txState === 'CANCELLING' ||
      s.txState === 'AWAITING_VERIFICATION') &&
    typeof d.approvedAmount === 'number' &&
    d.approvedAmount < (s.amountCents !== null && s.amountCents !== undefined ? s.amountCents : 0)
  ) {
    // Partial authorization → rewritten to TAP_DECLINED('PARTIAL_PAYMENT')
    effAction = 'TAP_DECLINED';
    declineCode = 'PARTIAL_PAYMENT';
    partialApproved = d.approvedAmount;
    partialTransferId = d.transferId !== undefined ? d.transferId : null;
  }

  if (effAction === 'TAP_DECLINED' && s.txState === 'CANCELLING') {
    effAction = 'CANCEL_DECLINED';
  }

  // Direct TAP_DECLINED with PARTIAL_PAYMENT code also triggers the stash logic
  if (
    action === 'TAP_DECLINED' &&
    declineCode === 'PARTIAL_PAYMENT'
  ) {
    if (typeof d.approvedAmount === 'number') partialApproved = d.approvedAmount;
    if (d.transferId !== undefined) partialTransferId = d.transferId;
  }

  // ── FSM: allowed transitions per state ────────────────────────────────────
  const transitions = {
    IDLE: { INITIATE_PAYMENT: 'INITIATING' },
    INITIATING: {
      TRANSFER_CREATED: 'AWAITING_TAP',
      VERIFICATION_STARTED: 'AWAITING_VERIFICATION',
      TAP_DECLINED: 'DECLINED',
      CANCEL_PAYMENT: 'CANCELLING',
    },
    AWAITING_TAP: {
      TAP_APPROVED: 'RECORDING',
      TAP_DECLINED: 'DECLINED',
      CANCEL_PAYMENT: 'CANCELLING',
    },
    AWAITING_VERIFICATION: {
      TAP_APPROVED: 'RECORDING',
      TAP_DECLINED: 'DECLINED',
      CANCEL_PAYMENT: 'CANCELLING',
    },
    RECORDING: { PAYMENT_RECORDED: 'COMPLETED' },
    COMPLETED: { EXIT_FLOW: 'IDLE' },
    DECLINED: { EXIT_FLOW: 'IDLE' },
    CANCELLING: {
      CANCEL_CONFIRMED: 'CANCELLED',
      TAP_APPROVED: 'RECORDING',
      CANCEL_DECLINED: 'CANCELLED',
    },
    CANCELLED: { EXIT_FLOW: 'IDLE' },
  };

  const stateTable = transitions[s.txState] || {};
  const nextTxState = stateTable[effAction];

  if (nextTxState === undefined) {
    // Silently rejected — no state change, no model corruption.
    return s;
  }

  s.txState = nextTxState;

  // ── Apply action data to model (guarded by post-transition state) ─────────
  if (effAction === 'INITIATE_PAYMENT' && s.txState === 'INITIATING') {
    s.orderId = d.orderId;
    s.amountCents = d.amountCents;
    s.transferId = null;
    s.approvedAmountCents = null;
    s.paymentId = null;
    s.declineCode = null;
  }

  if (effAction === 'TRANSFER_CREATED' && s.txState === 'AWAITING_TAP') {
    s.transferId = d.transferId;
  }

  if (effAction === 'TAP_APPROVED' && s.txState === 'RECORDING') {
    s.approvedAmountCents =
      typeof d.approvedAmount === 'number' ? d.approvedAmount : null;
    // Never clobber an existing transfer id
    s.transferId =
      s.transferId !== null && s.transferId !== undefined
        ? s.transferId
        : d.transferId !== undefined && d.transferId !== null
          ? d.transferId
          : null;
  }

  if (
    (effAction === 'TAP_DECLINED' && s.txState === 'DECLINED') ||
    (effAction === 'CANCEL_DECLINED' && s.txState === 'CANCELLED')
  ) {
    s.declineCode = declineCode !== undefined && declineCode !== null ? declineCode : null;
    if (s.declineCode === 'PARTIAL_PAYMENT') {
      if (typeof partialApproved === 'number') {
        s.approvedAmountCents = partialApproved;
      }
      s.transferId =
        s.transferId !== null && s.transferId !== undefined
          ? s.transferId
          : partialTransferId !== null && partialTransferId !== undefined
            ? partialTransferId
            : null;
    }
  }

  if (effAction === 'PAYMENT_RECORDED' && s.txState === 'COMPLETED') {
    s.paymentId = d.paymentId !== undefined && d.paymentId !== null ? d.paymentId : null;
  }

  if (effAction === 'EXIT_FLOW' && s.txState === 'IDLE') {
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