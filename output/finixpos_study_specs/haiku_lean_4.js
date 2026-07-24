module.exports = { init, next };

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
  // Create a new state object (never mutate the input)
  const newState = { ...state };

  // Pre-FSM acceptor: rewrite CANCELLING + TAP_DECLINED → CANCEL_DECLINED
  let actionName = action;
  if (action === 'TAP_DECLINED' && state.txState === 'CANCELLING') {
    actionName = 'CANCEL_DECLINED';
  }

  // Pre-FSM acceptor: reject partial authorizations
  if (
    action === 'TAP_APPROVED' &&
    state.txState === 'AWAITING_TAP' &&
    typeof data.approvedAmount === 'number' &&
    data.approvedAmount < (state.amountCents ?? 0)
  ) {
    actionName = 'TAP_DECLINED';
    data = {
      declineCode: 'PARTIAL_PAYMENT',
    };
  }

  // FSM state transitions with enforceAllowedTransitions
  const transitions = {
    IDLE: ['INITIATE_PAYMENT'],
    INITIATING: ['TRANSFER_CREATED', 'VERIFICATION_STARTED', 'TAP_DECLINED', 'CANCEL_PAYMENT'],
    AWAITING_TAP: ['TAP_APPROVED', 'TAP_DECLINED', 'CANCEL_PAYMENT'],
    AWAITING_VERIFICATION: ['TAP_APPROVED', 'TAP_DECLINED'],
    PROCESSING: [],
    RECORDING: ['PAYMENT_RECORDED'],
    COMPLETED: ['EXIT_FLOW'],
    DECLINED: ['EXIT_FLOW'],
    CANCELLING: ['CANCEL_CONFIRMED', 'TAP_APPROVED', 'CANCEL_DECLINED'],
    CANCELLED: ['EXIT_FLOW'],
  };

  const allowedTransitions = transitions[state.txState] || [];
  if (!allowedTransitions.includes(actionName)) {
    // Action not allowed in current state — return state unchanged
    return newState;
  }

  // Apply FSM state transition
  const nextStates = {
    INITIATE_PAYMENT: 'INITIATING',
    TRANSFER_CREATED: 'AWAITING_TAP',
    VERIFICATION_STARTED: 'AWAITING_VERIFICATION',
    TAP_APPROVED: 'RECORDING',
    TAP_DECLINED: 'DECLINED',
    CANCEL_DECLINED: 'CANCELLED',
    PAYMENT_RECORDED: 'COMPLETED',
    CANCEL_PAYMENT: 'CANCELLING',
    CANCEL_CONFIRMED: 'CANCELLED',
    EXIT_FLOW: 'IDLE',
  };

  newState.txState = nextStates[actionName];

  // Apply action data to model (guarded by post-transition txState)
  if (actionName === 'INITIATE_PAYMENT' && newState.txState === 'INITIATING') {
    newState.orderId = data.orderId;
    newState.amountCents = data.amountCents;
    newState.transferId = null;
    newState.declineCode = null;
    newState.approvedAmountCents = null;
    newState.paymentId = null;
  }

  if (actionName === 'TRANSFER_CREATED' && newState.txState === 'AWAITING_TAP') {
    newState.transferId = data.transferId;
  }

  if (actionName === 'TAP_APPROVED' && newState.txState === 'RECORDING') {
    newState.approvedAmountCents = typeof data.approvedAmount === 'number' ? data.approvedAmount : null;
  }

  if ((actionName === 'TAP_DECLINED' && newState.txState === 'DECLINED') ||
      (actionName === 'CANCEL_DECLINED' && newState.txState === 'CANCELLED')) {
    newState.declineCode = (data.declineCode ?? null);
  }

  if (actionName === 'PAYMENT_RECORDED' && newState.txState === 'COMPLETED') {
    newState.paymentId = (data.paymentId ?? null);
  }

  if (actionName === 'EXIT_FLOW' && newState.txState === 'IDLE') {
    newState.orderId = null;
    newState.amountCents = null;
    newState.transferId = null;
    newState.declineCode = null;
    newState.approvedAmountCents = null;
    newState.paymentId = null;
  }

  return newState;
}