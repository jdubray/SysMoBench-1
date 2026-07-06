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

// FSM transition table: action -> target state, per allowed source states.
const ALLOWED = {
  INITIATE_PAYMENT:     { from: ['IDLE'],                                                  to: 'INITIATING' },
  TRANSFER_CREATED:     { from: ['INITIATING'],                                            to: 'AWAITING_TAP' },
  VERIFICATION_STARTED: { from: ['INITIATING'],                                            to: 'AWAITING_VERIFICATION' },
  TAP_APPROVED:         { from: ['AWAITING_TAP', 'AWAITING_VERIFICATION', 'CANCELLING'],   to: 'RECORDING' },
  TAP_DECLINED:         { from: ['INITIATING', 'AWAITING_TAP', 'AWAITING_VERIFICATION'],   to: 'DECLINED' },
  CANCEL_DECLINED:      { from: ['CANCELLING'],                                            to: 'CANCELLED' },
  PAYMENT_RECORDED:     { from: ['RECORDING'],                                             to: 'COMPLETED' },
  CANCEL_PAYMENT:       { from: ['INITIATING', 'AWAITING_TAP', 'AWAITING_VERIFICATION'],   to: 'CANCELLING' },
  CANCEL_CONFIRMED:     { from: ['CANCELLING'],                                            to: 'CANCELLED' },
  EXIT_FLOW:            { from: ['COMPLETED', 'DECLINED', 'CANCELLED'],                    to: 'IDLE' },
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
  const d = data || {};

  // Proposal — mimics the mutable proposal object flowing through acceptors.
  let actionName = action;
  const proposal = {
    orderId: d.orderId,
    amountCents: d.amountCents,
    transferId: d.transferId !== undefined ? d.transferId : undefined,
    approvedAmount: d.approvedAmount,
    declineCode: d.declineCode !== undefined ? d.declineCode : undefined,
    paymentId: d.paymentId !== undefined ? d.paymentId : undefined,
  };

  // ── Pre-FSM acceptor #1: partial-payment rejection ────────────────────────
  if (
    actionName === 'TAP_APPROVED' &&
    (s.txState === 'AWAITING_TAP' ||
     s.txState === 'CANCELLING' ||
     s.txState === 'AWAITING_VERIFICATION') &&
    typeof proposal.approvedAmount === 'number' &&
    proposal.approvedAmount < (s.amountCents !== null && s.amountCents !== undefined ? s.amountCents : 0)
  ) {
    actionName = 'TAP_DECLINED';
    proposal.declineCode = 'PARTIAL_PAYMENT';
  }

  // ── Pre-FSM acceptor #2: CANCELLING + TAP_DECLINED → CANCEL_DECLINED ─────
  if (actionName === 'TAP_DECLINED' && s.txState === 'CANCELLING') {
    actionName = 'CANCEL_DECLINED';
  }

  // ── FSM acceptor: enforce allowed transitions ─────────────────────────────
  const rule = ALLOWED[actionName];
  if (!rule || rule.from.indexOf(s.txState) === -1) {
    // Silently rejected — no state change, no model mutation.
    return s;
  }
  s.txState = rule.to;

  // ── Model acceptor: apply action data, guarded by post-transition state ──
  if (actionName === 'INITIATE_PAYMENT' && s.txState === 'INITIATING') {
    s.orderId = proposal.orderId;
    s.amountCents = proposal.amountCents;
    s.transferId = null;
    s.approvedAmountCents = null;
    s.paymentId = null;
    s.declineCode = null;
  }

  if (actionName === 'TRANSFER_CREATED' && s.txState === 'AWAITING_TAP') {
    s.transferId = proposal.transferId;
  }

  if (actionName === 'TAP_APPROVED' && s.txState === 'RECORDING') {
    s.approvedAmountCents =
      typeof proposal.approvedAmount === 'number' ? proposal.approvedAmount : null;
    // Never clobber an id we already have.
    s.transferId =
      s.transferId !== null && s.transferId !== undefined
        ? s.transferId
        : (proposal.transferId !== undefined && proposal.transferId !== null
            ? proposal.transferId
            : null);
  }

  if ((actionName === 'TAP_DECLINED' && s.txState === 'DECLINED') ||
      (actionName === 'CANCEL_DECLINED' && s.txState === 'CANCELLED')) {
    s.declineCode =
      proposal.declineCode !== undefined && proposal.declineCode !== null
        ? proposal.declineCode
        : null;
    if (proposal.declineCode === 'PARTIAL_PAYMENT') {
      if (typeof proposal.approvedAmount === 'number') {
        s.approvedAmountCents = proposal.approvedAmount;
      }
      s.transferId =
        s.transferId !== null && s.transferId !== undefined
          ? s.transferId
          : (proposal.transferId !== undefined && proposal.transferId !== null
              ? proposal.transferId
              : null);
    }
  }

  if (actionName === 'PAYMENT_RECORDED' && s.txState === 'COMPLETED') {
    s.paymentId =
      proposal.paymentId !== undefined && proposal.paymentId !== null
        ? proposal.paymentId
        : null;
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