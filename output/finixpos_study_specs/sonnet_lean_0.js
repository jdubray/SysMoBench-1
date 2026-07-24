"use strict";

// ---------------------------------------------------------------------------
// FSM transition table
// Derived directly from the terminalPaymentFSM definition in the source.
// ---------------------------------------------------------------------------

// allowed[txState] = Set of action names that can fire from that state
const ALLOWED = {
  IDLE:                  new Set(['INITIATE_PAYMENT']),
  INITIATING:            new Set(['TRANSFER_CREATED', 'VERIFICATION_STARTED', 'TAP_DECLINED', 'CANCEL_PAYMENT']),
  AWAITING_TAP:          new Set(['TAP_APPROVED', 'TAP_DECLINED', 'CANCEL_PAYMENT']),
  AWAITING_VERIFICATION: new Set(['TAP_APPROVED', 'TAP_DECLINED']),
  PROCESSING:            new Set(),
  RECORDING:             new Set(['PAYMENT_RECORDED']),
  COMPLETED:             new Set(['EXIT_FLOW']),
  DECLINED:              new Set(['EXIT_FLOW']),
  CANCELLING:            new Set(['CANCEL_CONFIRMED', 'TAP_APPROVED', 'CANCEL_DECLINED']),
  CANCELLED:             new Set(['EXIT_FLOW']),
};

// nextState[action] = the txState the FSM moves to when that action fires
const NEXT_STATE = {
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

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

function init() {
  return {
    txState:             'IDLE',
    orderId:             null,
    amountCents:         null,
    transferId:          null,
    declineCode:         null,
    approvedAmountCents: null,
    paymentId:           null,
  };
}

// ---------------------------------------------------------------------------
// next
// ---------------------------------------------------------------------------

function next(state, action, data) {
  // ── Pre-FSM rewrites (mirrors the pre-FSM acceptor in the source) ─────────
  //
  // 1. TAP_DECLINED while CANCELLING → rewrite to CANCEL_DECLINED (→ CANCELLED)
  // 2. TAP_APPROVED while AWAITING_TAP with approvedAmount < amountCents
  //    → rewrite to TAP_DECLINED with declineCode='PARTIAL_PAYMENT'
  //
  // These rewrites happen before the FSM guard so the correct next-state is
  // selected and the correct data is applied.

  let effectiveAction = action;
  let effectiveData   = data;

  if (action === 'TAP_DECLINED' && state.txState === 'CANCELLING') {
    effectiveAction = 'CANCEL_DECLINED';
    // CANCEL_DECLINED carries no data fields in the observable state
    effectiveData = {};
  }

  if (
    action === 'TAP_APPROVED' &&
    state.txState === 'AWAITING_TAP' &&
    typeof data.approvedAmount === 'number' &&
    data.approvedAmount < (state.amountCents ?? 0)
  ) {
    effectiveAction = 'TAP_DECLINED';
    effectiveData   = { declineCode: 'PARTIAL_PAYMENT' };
  }

  // ── FSM guard (enforceAllowedTransitions) ─────────────────────────────────
  // If the (possibly rewritten) action is not allowed from the current state,
  // the FSM silently discards it — state is returned unchanged.

  const allowed = ALLOWED[state.txState];
  if (!allowed || !allowed.has(effectiveAction)) {
    // Silently discard — no state change (matches enforceAllowedTransitions behaviour)
    return {
      txState:             state.txState,
      orderId:             state.orderId,
      amountCents:         state.amountCents,
      transferId:          state.transferId,
      declineCode:         state.declineCode,
      approvedAmountCents: state.approvedAmountCents,
      paymentId:           state.paymentId,
    };
  }

  // ── Advance txState ───────────────────────────────────────────────────────

  const newTxState = NEXT_STATE[effectiveAction];

  // ── Apply action data to observable fields ────────────────────────────────
  // Each branch is guarded by the expected post-transition txState, mirroring
  // the data-application acceptor in the source.

  // Start from the current observable fields; we'll overwrite selectively.
  let orderId             = state.orderId;
  let amountCents         = state.amountCents;
  let transferId          = state.transferId;
  let declineCode         = state.declineCode;
  let approvedAmountCents = state.approvedAmountCents;
  let paymentId           = state.paymentId;

  if (effectiveAction === 'INITIATE_PAYMENT' && newTxState === 'INITIATING') {
    orderId             = effectiveData.orderId;
    amountCents         = effectiveData.amountCents;
    transferId          = null;
    declineCode         = null;
    approvedAmountCents = null;
    paymentId           = null;
  }

  if (effectiveAction === 'TRANSFER_CREATED' && newTxState === 'AWAITING_TAP') {
    transferId = effectiveData.transferId;
  }

  // VERIFICATION_STARTED: no observable field changes beyond txState

  if (effectiveAction === 'TAP_APPROVED' && newTxState === 'RECORDING') {
    approvedAmountCents = typeof effectiveData.approvedAmount === 'number'
      ? effectiveData.approvedAmount
      : null;
  }

  if (effectiveAction === 'TAP_DECLINED' && newTxState === 'DECLINED') {
    declineCode = (effectiveData.declineCode !== undefined ? effectiveData.declineCode : null);
  }

  if (effectiveAction === 'CANCEL_DECLINED' && newTxState === 'CANCELLED') {
    // CANCEL_DECLINED carries no observable data fields
  }

  if (effectiveAction === 'PAYMENT_RECORDED' && newTxState === 'COMPLETED') {
    paymentId = (effectiveData.paymentId !== undefined ? effectiveData.paymentId : null);
  }

  // CANCEL_PAYMENT, CANCEL_CONFIRMED: no observable field changes beyond txState

  if (effectiveAction === 'EXIT_FLOW' && newTxState === 'IDLE') {
    orderId             = null;
    amountCents         = null;
    transferId          = null;
    declineCode         = null;
    approvedAmountCents = null;
    paymentId           = null;
  }

  return {
    txState:             newTxState,
    orderId,
    amountCents,
    transferId,
    declineCode,
    approvedAmountCents,
    paymentId,
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

module.exports = { init, next };