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
  const d = data || {};

  // Build the "proposal" — a mutable copy of the action payload.
  const proposal = {
    actionName: action,
    orderId: d.orderId,
    amountCents: d.amountCents,
    transferId: d.transferId !== undefined ? d.transferId : undefined,
    approvedAmount: d.approvedAmount,
    declineCode: d.declineCode !== undefined ? d.declineCode : undefined,
    paymentId: d.paymentId !== undefined ? d.paymentId : undefined,
  };

  // ── Pre-FSM acceptor rewrites ──────────────────────────────────────────
  // 1. Partial-payment guard: SUCCEEDED tap with approvedAmount < requested
  //    arriving in AWAITING_TAP / CANCELLING / AWAITING_VERIFICATION is
  //    rewritten to TAP_DECLINED with declineCode='PARTIAL_PAYMENT'.
  //    approvedAmount and transferId are kept on the rewritten proposal.
  if (
    proposal.actionName === 'TAP_APPROVED' &&
    (state.txState === 'AWAITING_TAP' ||
     state.txState === 'CANCELLING' ||
     state.txState === 'AWAITING_VERIFICATION') &&
    typeof proposal.approvedAmount === 'number' &&
    proposal.approvedAmount < (state.amountCents !== null && state.amountCents !== undefined
      ? state.amountCents : 0)
  ) {
    proposal.actionName = 'TAP_DECLINED';
    proposal.declineCode = 'PARTIAL_PAYMENT';
  }

  // 2. CANCELLING + TAP_DECLINED → CANCEL_DECLINED (→ CANCELLED)
  if (proposal.actionName === 'TAP_DECLINED' && state.txState === 'CANCELLING') {
    proposal.actionName = 'CANCEL_DECLINED';
  }

  // ── FSM transition check (enforceAllowedTransitions) ──────────────────
  const stateTable = ALLOWED[state.txState] || {};
  const nextTx = stateTable[proposal.actionName];
  if (!nextTx) {
    // Silently discarded — no model change.
    return { ...state };
  }

  const model = { ...state, txState: nextTx };
  const a = proposal.actionName;

  // ── Apply action data to model (guarded by post-transition txState) ───
  if (a === 'INITIATE_PAYMENT' && model.txState === 'INITIATING') {
    model.orderId = proposal.orderId;
    model.amountCents = proposal.amountCents;
    model.transferId = null;
    model.approvedAmountCents = null;
    model.paymentId = null;
    model.declineCode = null;
  }

  if (a === 'TRANSFER_CREATED' && model.txState === 'AWAITING_TAP') {
    model.transferId = proposal.transferId;
  }

  if (a === 'TAP_APPROVED' && model.txState === 'RECORDING') {
    model.approvedAmountCents =
      typeof proposal.approvedAmount === 'number' ? proposal.approvedAmount : null;
    // Never clobber a transfer id we already have; recovery paths carry it here.
    model.transferId =
      model.transferId !== null && model.transferId !== undefined
        ? model.transferId
        : (proposal.transferId !== undefined && proposal.transferId !== null
            ? proposal.transferId
            : null);
  }

  if ((a === 'TAP_DECLINED' && model.txState === 'DECLINED') ||
      (a === 'CANCEL_DECLINED' && model.txState === 'CANCELLED')) {
    model.declineCode =
      proposal.declineCode !== undefined && proposal.declineCode !== null
        ? proposal.declineCode
        : null;
    // Partial rejection: the card WAS charged — stash amount / transfer id.
    if (proposal.declineCode === 'PARTIAL_PAYMENT') {
      if (typeof proposal.approvedAmount === 'number') {
        model.approvedAmountCents = proposal.approvedAmount;
      }
      model.transferId =
        model.transferId !== null && model.transferId !== undefined
          ? model.transferId
          : (proposal.transferId !== undefined && proposal.transferId !== null
              ? proposal.transferId
              : null);
    }
  }

  if (a === 'PAYMENT_RECORDED' && model.txState === 'COMPLETED') {
    model.paymentId =
      proposal.paymentId !== undefined && proposal.paymentId !== null
        ? proposal.paymentId
        : null;
  }

  if (a === 'EXIT_FLOW' && model.txState === 'IDLE') {
    model.orderId = null;
    model.amountCents = null;
    model.transferId = null;
    model.declineCode = null;
    model.approvedAmountCents = null;
    model.paymentId = null;
  }

  return model;
}

module.exports = { init, next };