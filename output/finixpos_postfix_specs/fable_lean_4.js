'use strict';

/**
 * Pure transition function modeling the observable single-step behavior of
 * the terminal payment workflow (SAM + FSM + pre-FSM acceptor rewrites +
 * post-FSM model acceptor), projected onto the seven observable keys.
 */

// FSM transition table: state -> { actionName -> nextState }
const TRANSITIONS = {
  IDLE: {
    INITIATE_PAYMENT: 'INITIATING',
  },
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
  RECORDING: {
    PAYMENT_RECORDED: 'COMPLETED',
  },
  COMPLETED: {
    EXIT_FLOW: 'IDLE',
  },
  DECLINED: {
    EXIT_FLOW: 'IDLE',
  },
  CANCELLING: {
    CANCEL_CONFIRMED: 'CANCELLED',
    TAP_APPROVED: 'RECORDING',
    CANCEL_DECLINED: 'CANCELLED',
  },
  CANCELLED: {
    EXIT_FLOW: 'IDLE',
  },
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

  // Build the "proposal" (mirrors component action output + dispatched data).
  const proposal = {
    __actionName: action,
    orderId: d.orderId,
    amountCents: d.amountCents,
    transferId: d.transferId !== undefined ? d.transferId : null,
    approvedAmount: d.approvedAmount,
    declineCode: d.declineCode !== undefined ? d.declineCode : null,
    paymentId: d.paymentId !== undefined ? d.paymentId : null,
  };

  // ── Pre-FSM acceptor rewrites ────────────────────────────────────────────
  // 1. Partial-payment guard: TAP_APPROVED with approvedAmount < amountCents
  //    arriving in AWAITING_TAP / CANCELLING / AWAITING_VERIFICATION is
  //    rewritten to TAP_DECLINED with declineCode='PARTIAL_PAYMENT'.
  if (
    proposal.__actionName === 'TAP_APPROVED' &&
    (state.txState === 'AWAITING_TAP' ||
      state.txState === 'CANCELLING' ||
      state.txState === 'AWAITING_VERIFICATION') &&
    typeof proposal.approvedAmount === 'number' &&
    proposal.approvedAmount < (state.amountCents !== null && state.amountCents !== undefined ? state.amountCents : 0)
  ) {
    proposal.__actionName = 'TAP_DECLINED';
    proposal.declineCode = 'PARTIAL_PAYMENT';
    // approvedAmount and transferId remain on the proposal for the model acceptor.
  }

  // 2. CANCELLING + TAP_DECLINED → CANCEL_DECLINED (→ CANCELLED)
  if (proposal.__actionName === 'TAP_DECLINED' && state.txState === 'CANCELLING') {
    proposal.__actionName = 'CANCEL_DECLINED';
  }

  // ── FSM acceptor: compute next txState (silently reject if not allowed) ──
  const effectiveAction = proposal.__actionName;
  const allowed = TRANSITIONS[state.txState] || {};
  const nextTxState = allowed[effectiveAction];

  // New state starts as a copy of the current one.
  const out = {
    txState: state.txState,
    orderId: state.orderId,
    amountCents: state.amountCents,
    transferId: state.transferId,
    declineCode: state.declineCode,
    approvedAmountCents: state.approvedAmountCents,
    paymentId: state.paymentId,
  };

  if (nextTxState === undefined) {
    // Rejected action: no state change, no field changes (guards below
    // require the expected post-transition txState, which never matches).
    return out;
  }

  out.txState = nextTxState;

  // ── Post-FSM model acceptor (guarded by post-transition txState) ─────────

  if (effectiveAction === 'INITIATE_PAYMENT' && out.txState === 'INITIATING') {
    out.orderId = proposal.orderId;
    out.amountCents = proposal.amountCents;
    out.transferId = null;
    out.approvedAmountCents = null;
    out.paymentId = null;
    out.declineCode = null;
  }

  if (effectiveAction === 'TRANSFER_CREATED' && out.txState === 'AWAITING_TAP') {
    out.transferId = proposal.transferId;
  }

  if (effectiveAction === 'TAP_APPROVED' && out.txState === 'RECORDING') {
    out.approvedAmountCents =
      typeof proposal.approvedAmount === 'number' ? proposal.approvedAmount : null;
    // Never clobber an id we already have.
    out.transferId =
      state.transferId !== null && state.transferId !== undefined
        ? state.transferId
        : (proposal.transferId !== undefined && proposal.transferId !== null
            ? proposal.transferId
            : null);
  }

  if (
    (effectiveAction === 'TAP_DECLINED' && out.txState === 'DECLINED') ||
    (effectiveAction === 'CANCEL_DECLINED' && out.txState === 'CANCELLED')
  ) {
    out.declineCode =
      proposal.declineCode !== undefined && proposal.declineCode !== null
        ? proposal.declineCode
        : null;
    if (proposal.declineCode === 'PARTIAL_PAYMENT') {
      if (typeof proposal.approvedAmount === 'number') {
        out.approvedAmountCents = proposal.approvedAmount;
      }
      out.transferId =
        state.transferId !== null && state.transferId !== undefined
          ? state.transferId
          : (proposal.transferId !== undefined && proposal.transferId !== null
              ? proposal.transferId
              : null);
    }
  }

  if (effectiveAction === 'PAYMENT_RECORDED' && out.txState === 'COMPLETED') {
    out.paymentId =
      proposal.paymentId !== undefined && proposal.paymentId !== null
        ? proposal.paymentId
        : null;
  }

  if (effectiveAction === 'EXIT_FLOW' && out.txState === 'IDLE') {
    out.orderId = null;
    out.amountCents = null;
    out.transferId = null;
    out.declineCode = null;
    out.approvedAmountCents = null;
    out.paymentId = null;
  }

  return out;
}

module.exports = { init, next };