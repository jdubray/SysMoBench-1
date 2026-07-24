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
    // declineCode carries through from data (may be null)
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
  // the FSM silently discards it — state is unchanged.

  const allowed = ALLOWED[state.txState];
  if (!allowed || !allowed.has(effectiveAction)) {
    // Silently discard — return state unchanged (new object, same values)
    return Object.assign({}, state);
  }

  // ── Advance FSM ───────────────────────────────────────────────────────────

  const nextTxState = NEXT_STATE[effectiveAction];

  // ── Apply action data to model ────────────────────────────────────────────
  // Each branch is guarded by the expected post-transition txState, mirroring
  // the data-application acceptor in the source.

  // Start from a copy of the current state
  const s = Object.assign({}, state, { txState: nextTxState });

  if (effectiveAction === 'INITIATE_PAYMENT' && nextTxState === 'INITIATING') {
    s.orderId             = effectiveData.orderId   ?? null;
    s.amountCents         = effectiveData.amountCents ?? null;
    s.transferId          = null;
    s.declineCode         = null;
    s.approvedAmountCents = null;
    s.paymentId           = null;
  }

  if (effectiveAction === 'TRANSFER_CREATED' && nextTxState === 'AWAITING_TAP') {
    s.transferId = effectiveData.transferId ?? null;
  }

  // VERIFICATION_STARTED: no observable fields change beyond txState

  if (effectiveAction === 'TAP_APPROVED' && nextTxState === 'RECORDING') {
    s.approvedAmountCents = typeof effectiveData.approvedAmount === 'number'
      ? effectiveData.approvedAmount
      : null;
  }

  if (effectiveAction === 'TAP_DECLINED' && nextTxState === 'DECLINED') {
    s.declineCode = (effectiveData.declineCode !== undefined)
      ? effectiveData.declineCode
      : null;
  }

  if (effectiveAction === 'CANCEL_DECLINED' && nextTxState === 'CANCELLED') {
    // declineCode from the original TAP_DECLINED data (passed through effectiveData)
    s.declineCode = (effectiveData && effectiveData.declineCode !== undefined)
      ? effectiveData.declineCode
      : null;
  }

  if (effectiveAction === 'PAYMENT_RECORDED' && nextTxState === 'COMPLETED') {
    s.paymentId = (effectiveData.paymentId !== undefined)
      ? effectiveData.paymentId
      : null;
  }

  // CANCEL_PAYMENT: no observable fields change beyond txState
  // CANCEL_CONFIRMED: no observable fields change beyond txState

  if (effectiveAction === 'EXIT_FLOW' && nextTxState === 'IDLE') {
    s.orderId             = null;
    s.amountCents         = null;
    s.transferId          = null;
    s.declineCode         = null;
    s.approvedAmountCents = null;
    s.paymentId           = null;
  }

  return s;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

module.exports = { init, next };