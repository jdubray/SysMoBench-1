'use strict';

const ALLOWED = {
  IDLE:                  { INITIATE_PAYMENT: 'INITIATING' },
  INITIATING:            { TRANSFER_CREATED: 'AWAITING_TAP',
                           VERIFICATION_STARTED: 'AWAITING_VERIFICATION',
                           TAP_DECLINED: 'DECLINED',
                           CANCEL_PAYMENT: 'CANCELLING' },
  AWAITING_TAP:          { TAP_APPROVED: 'RECORDING',
                           TAP_DECLINED: 'DECLINED',
                           CANCEL_PAYMENT: 'CANCELLING' },
  AWAITING_VERIFICATION: { TAP_APPROVED: 'RECORDING',
                           TAP_DECLINED: 'DECLINED',
                           CANCEL_PAYMENT: 'CANCELLING' },
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

  // Build the proposal (mirrors the SAM component action payloads)
  let actionName = action;
  let proposal = {};
  switch (action) {
    case 'INITIATE_PAYMENT':
      proposal = { orderId: d.orderId, amountCents: d.amountCents };
      break;
    case 'TRANSFER_CREATED':
      proposal = { transferId: d.transferId };
      break;
    case 'TAP_APPROVED':
      proposal = {
        approvedAmount: d.approvedAmount,
        transferId: d.transferId !== undefined ? d.transferId : null,
      };
      break;
    case 'TAP_DECLINED':
      proposal = { declineCode: d.declineCode !== undefined ? d.declineCode : null };
      break;
    case 'PAYMENT_RECORDED':
      proposal = { paymentId: d.paymentId !== undefined ? d.paymentId : null };
      break;
    default:
      proposal = {};
  }

  // ── Pre-FSM rewrite 1: partial-payment guard ─────────────────────────────
  if (
    actionName === 'TAP_APPROVED' &&
    (s.txState === 'AWAITING_TAP' ||
     s.txState === 'CANCELLING' ||
     s.txState === 'AWAITING_VERIFICATION') &&
    typeof proposal.approvedAmount === 'number' &&
    proposal.approvedAmount < (s.amountCents != null ? s.amountCents : 0)
  ) {
    actionName = 'TAP_DECLINED';
    proposal.declineCode = 'PARTIAL_PAYMENT';
    // proposal.approvedAmount and proposal.transferId are preserved
  }

  // ── Pre-FSM rewrite 2: CANCELLING + TAP_DECLINED → CANCEL_DECLINED ──────
  if (actionName === 'TAP_DECLINED' && s.txState === 'CANCELLING') {
    actionName = 'CANCEL_DECLINED';
  }

  // ── FSM: reject if not allowed from current state ────────────────────────
  const allowed = ALLOWED[s.txState] || {};
  const nextState = allowed[actionName];
  if (!nextState) return s; // silently discarded — no state change

  s.txState = nextState;

  // ── Apply action data to model (guarded by post-transition state) ────────
  if (actionName === 'INITIATE_PAYMENT' && s.txState === 'INITIATING') {
    s.orderId = proposal.orderId;
    s.amountCents = proposal.amountCents;
    s.transferId = null;
    s.declineCode = null;
    s.approvedAmountCents = null;
    s.paymentId = null;
  }

  if (actionName === 'TRANSFER_CREATED' && s.txState === 'AWAITING_TAP') {
    s.transferId = proposal.transferId;
  }

  if (actionName === 'TAP_APPROVED' && s.txState === 'RECORDING') {
    s.approvedAmountCents =
      typeof proposal.approvedAmount === 'number' ? proposal.approvedAmount : null;
    // Never clobber an id we already have
    s.transferId =
      s.transferId != null
        ? s.transferId
        : (proposal.transferId != null ? proposal.transferId : null);
  }

  if ((actionName === 'TAP_DECLINED' && s.txState === 'DECLINED') ||
      (actionName === 'CANCEL_DECLINED' && s.txState === 'CANCELLED')) {
    s.declineCode = proposal.declineCode != null ? proposal.declineCode : null;
    if (proposal.declineCode === 'PARTIAL_PAYMENT') {
      if (typeof proposal.approvedAmount === 'number') {
        s.approvedAmountCents = proposal.approvedAmount;
      }
      s.transferId =
        s.transferId != null
          ? s.transferId
          : (proposal.transferId != null ? proposal.transferId : null);
    }
  }

  if (actionName === 'PAYMENT_RECORDED' && s.txState === 'COMPLETED') {
    s.paymentId = proposal.paymentId != null ? proposal.paymentId : null;
  }

  if (actionName === 'EXIT_FLOW' && s.txState === 'IDLE') {
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