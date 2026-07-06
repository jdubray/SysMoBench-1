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
    // declineCode from the original TAP_DECLINED data is preserved
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
  // If the effective action is not allowed from the current state, the FSM
  // silently discards it (sam-fsm deterministic mode sets __error but does not
  // throw; subsequent acceptors are still called but the state-guard in the
  // data-apply acceptor prevents any model mutation). We mirror that by
  // returning the state unchanged.

  const allowed = ALLOWED[state.txState];
  if (!allowed || !allowed.has(effectiveAction)) {
    return Object.assign({}, state);
  }

  // ── Advance txState ───────────────────────────────────────────────────────

  const newTxState = NEXT_STATE[effectiveAction];

  // ── Apply action data to model ────────────────────────────────────────────
  // Each branch is guarded by the expected post-transition txState, exactly
  // as the data-apply acceptor in the source is guarded.

  const s = Object.assign({}, state, { txState: newTxState });

  if (effectiveAction === 'INITIATE_PAYMENT' && newTxState === 'INITIATING') {
    s.orderId             = effectiveData.orderId   ?? null;
    s.amountCents         = effectiveData.amountCents ?? null;
    s.transferId          = null;
    s.declineCode         = null;
    s.approvedAmountCents = null;
    s.paymentId           = null;
  }

  if (effectiveAction === 'TRANSFER_CREATED' && newTxState === 'AWAITING_TAP') {
    s.transferId = effectiveData.transferId ?? null;
  }

  // VERIFICATION_STARTED: no observable field changes beyond txState

  if (effectiveAction === 'TAP_APPROVED' && newTxState === 'RECORDING') {
    s.approvedAmountCents =
      typeof effectiveData.approvedAmount === 'number'
        ? effectiveData.approvedAmount
        : null;
  }

  if (
    (effectiveAction === 'TAP_DECLINED'    && newTxState === 'DECLINED') ||
    (effectiveAction === 'CANCEL_DECLINED' && newTxState === 'CANCELLED')
  ) {
    // For CANCEL_DECLINED the original data came from a TAP_DECLINED dispatch;
    // effectiveData still carries declineCode from that original data object.
    s.declineCode = (effectiveData.declineCode ?? null);
  }

  if (effectiveAction === 'PAYMENT_RECORDED' && newTxState === 'COMPLETED') {
    s.paymentId = (effectiveData.paymentId ?? null);
  }

  // CANCEL_PAYMENT, CANCEL_CONFIRMED: no observable field changes beyond txState

  if (effectiveAction === 'EXIT_FLOW' && newTxState === 'IDLE') {
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