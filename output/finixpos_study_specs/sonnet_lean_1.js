"use strict";

// ---------------------------------------------------------------------------
// FSM transition table
// ---------------------------------------------------------------------------
// Maps txState -> action -> nextTxState (undefined = not allowed / silently ignored)

const TRANSITIONS = {
  IDLE: {
    INITIATE_PAYMENT: 'INITIATING',
  },
  INITIATING: {
    TRANSFER_CREATED:     'AWAITING_TAP',
    VERIFICATION_STARTED: 'AWAITING_VERIFICATION',
    TAP_DECLINED:         'DECLINED',
    CANCEL_PAYMENT:       'CANCELLING',
  },
  AWAITING_TAP: {
    TAP_APPROVED:   'RECORDING',
    TAP_DECLINED:   'DECLINED',
    CANCEL_PAYMENT: 'CANCELLING',
  },
  AWAITING_VERIFICATION: {
    TAP_APPROVED: 'RECORDING',
    TAP_DECLINED: 'DECLINED',
  },
  PROCESSING: {},
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
    TAP_APPROVED:     'RECORDING',
    // TAP_DECLINED in CANCELLING is rewritten to CANCEL_DECLINED -> CANCELLED
    // We handle this via the pre-FSM rewrite below
    CANCEL_DECLINED:  'CANCELLED',
  },
  CANCELLED: {
    EXIT_FLOW: 'IDLE',
  },
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
  // Work on a shallow copy of the incoming state
  let s = Object.assign({}, state);

  // ── Pre-FSM rewrites ──────────────────────────────────────────────────────

  // 1. TAP_DECLINED while CANCELLING → treat as CANCEL_DECLINED (→ CANCELLED)
  let effectiveAction = action;
  if (action === 'TAP_DECLINED' && s.txState === 'CANCELLING') {
    effectiveAction = 'CANCEL_DECLINED';
  }

  // 2. Partial-payment guard: TAP_APPROVED while AWAITING_TAP with
  //    approvedAmount < amountCents → rewrite to TAP_DECLINED / PARTIAL_PAYMENT
  if (
    action === 'TAP_APPROVED' &&
    s.txState === 'AWAITING_TAP' &&
    typeof data.approvedAmount === 'number' &&
    data.approvedAmount < (s.amountCents ?? 0)
  ) {
    effectiveAction = 'TAP_DECLINED';
    data = { declineCode: 'PARTIAL_PAYMENT' };
  }

  // ── FSM state lookup ──────────────────────────────────────────────────────

  const allowed = TRANSITIONS[s.txState];
  if (!allowed) {
    // Unknown current state — return unchanged
    return s;
  }

  const nextTxState = allowed[effectiveAction];
  if (nextTxState === undefined) {
    // Action not allowed from this state — silently discard (enforceAllowedTransitions)
    return s;
  }

  // Advance the FSM
  s.txState = nextTxState;

  // ── Apply action data to model (guarded by post-transition txState) ───────

  if (action === 'INITIATE_PAYMENT' && s.txState === 'INITIATING') {
    s.orderId             = data.orderId;
    s.amountCents         = data.amountCents;
    s.transferId          = null;
    s.declineCode         = null;
    s.approvedAmountCents = null;
    s.paymentId           = null;
  }

  if (action === 'TRANSFER_CREATED' && s.txState === 'AWAITING_TAP') {
    s.transferId = data.transferId;
  }

  // VERIFICATION_STARTED: no observable fields change beyond txState

  if (action === 'TAP_APPROVED' && s.txState === 'RECORDING') {
    s.approvedAmountCents = typeof data.approvedAmount === 'number' ? data.approvedAmount : null;
  }

  if (effectiveAction === 'TAP_DECLINED' && s.txState === 'DECLINED') {
    s.declineCode = (data && data.declineCode !== undefined) ? data.declineCode : null;
  }

  if (effectiveAction === 'CANCEL_DECLINED' && s.txState === 'CANCELLED') {
    // declineCode from the original TAP_DECLINED data
    s.declineCode = (data && data.declineCode !== undefined) ? data.declineCode : null;
  }

  if (action === 'PAYMENT_RECORDED' && s.txState === 'COMPLETED') {
    s.paymentId = (data && data.paymentId !== undefined) ? data.paymentId : null;
  }

  if (action === 'EXIT_FLOW' && s.txState === 'IDLE') {
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