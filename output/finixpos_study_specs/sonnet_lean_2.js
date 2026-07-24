"use strict";

// ---------------------------------------------------------------------------
// FSM transition table
// Derived from the terminalPaymentFSM definition in terminal-payment.ts
// ---------------------------------------------------------------------------

const ALLOWED_TRANSITIONS = {
  IDLE:                  ['INITIATE_PAYMENT'],
  INITIATING:            ['TRANSFER_CREATED', 'VERIFICATION_STARTED', 'TAP_DECLINED', 'CANCEL_PAYMENT'],
  AWAITING_TAP:          ['TAP_APPROVED', 'TAP_DECLINED', 'CANCEL_PAYMENT'],
  AWAITING_VERIFICATION: ['TAP_APPROVED', 'TAP_DECLINED'],
  PROCESSING:            [],
  RECORDING:             ['PAYMENT_RECORDED'],
  COMPLETED:             ['EXIT_FLOW'],
  DECLINED:              ['EXIT_FLOW'],
  CANCELLING:            ['CANCEL_CONFIRMED', 'TAP_APPROVED', 'CANCEL_DECLINED'],
  CANCELLED:             ['EXIT_FLOW'],
};

// Maps action name → next txState (for the FSM's deterministic transitions)
const ACTION_TO_NEXT_STATE = {
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
  // Step 1: Pre-FSM rewrites (mirrors the pre-FSM acceptor in the source)
  //
  // Rewrite 1: TAP_DECLINED while CANCELLING → CANCEL_DECLINED
  // Rewrite 2: TAP_APPROVED while AWAITING_TAP with approvedAmount < amountCents
  //            → TAP_DECLINED with declineCode='PARTIAL_PAYMENT'

  let effectiveAction = action;
  let effectiveData   = data;

  if (action === 'TAP_DECLINED' && state.txState === 'CANCELLING') {
    effectiveAction = 'CANCEL_DECLINED';
    // declineCode carries through from data
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

  // Step 2: FSM guard — enforceAllowedTransitions
  // If the effective action is not in the allowed list for the current state,
  // the FSM silently rejects it (no state change, no model mutation).

  const allowed = ALLOWED_TRANSITIONS[state.txState] ?? [];
  if (!allowed.includes(effectiveAction)) {
    // Silently discard — return state unchanged (new object, same values)
    return Object.assign({}, state);
  }

  // Step 3: Advance txState
  const nextTxState = ACTION_TO_NEXT_STATE[effectiveAction];
  if (nextTxState === undefined) {
    // Unknown action — should not happen given the guard above, but be safe
    return Object.assign({}, state);
  }

  // Step 4: Build the new state, applying action data (mirrors the data-apply
  // acceptor in the source, guarded by the expected post-transition txState)

  // Start from a shallow copy
  const s = Object.assign({}, state, { txState: nextTxState });

  if (effectiveAction === 'INITIATE_PAYMENT' && nextTxState === 'INITIATING') {
    s.orderId             = data.orderId;
    s.amountCents         = data.amountCents;
    s.transferId          = null;
    s.declineCode         = null;
    s.approvedAmountCents = null;
    s.paymentId           = null;
  }

  if (effectiveAction === 'TRANSFER_CREATED' && nextTxState === 'AWAITING_TAP') {
    s.transferId = data.transferId;
  }

  // VERIFICATION_STARTED — no observable field changes beyond txState

  if (effectiveAction === 'TAP_APPROVED' && nextTxState === 'RECORDING') {
    s.approvedAmountCents = typeof data.approvedAmount === 'number' ? data.approvedAmount : null;
  }

  if (effectiveAction === 'TAP_DECLINED' && nextTxState === 'DECLINED') {
    s.declineCode = (effectiveData.declineCode !== undefined ? effectiveData.declineCode : null);
  }

  if (effectiveAction === 'CANCEL_DECLINED' && nextTxState === 'CANCELLED') {
    // declineCode from the original TAP_DECLINED data (carried in effectiveData)
    s.declineCode = (data.declineCode !== undefined ? data.declineCode : null);
  }

  if (effectiveAction === 'PAYMENT_RECORDED' && nextTxState === 'COMPLETED') {
    s.paymentId = (data.paymentId !== undefined ? data.paymentId : null);
  }

  // CANCEL_PAYMENT → CANCELLING: no observable field changes beyond txState
  // CANCEL_CONFIRMED → CANCELLED: no observable field changes beyond txState

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