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
  // Helper to create a new state object
  function newState(overrides) {
    return {
      txState: state.txState,
      orderId: state.orderId,
      amountCents: state.amountCents,
      transferId: state.transferId,
      declineCode: state.declineCode,
      approvedAmountCents: state.approvedAmountCents,
      paymentId: state.paymentId,
      ...overrides,
    };
  }

  // FSM transition table: allowed transitions per state
  const transitions = {
    IDLE: ['INITIATE_PAYMENT'],
    INITIATING: ['TRANSFER_CREATED', 'VERIFICATION_STARTED', 'TAP_DECLINED', 'CANCEL_PAYMENT'],
    AWAITING_TAP: ['TAP_APPROVED', 'TAP_DECLINED', 'CANCEL_PAYMENT'],
    AWAITING_VERIFICATION: ['TAP_APPROVED', 'TAP_DECLINED'],
    RECORDING: ['PAYMENT_RECORDED'],
    COMPLETED: ['EXIT_FLOW'],
    DECLINED: ['EXIT_FLOW'],
    CANCELLING: ['CANCEL_CONFIRMED', 'TAP_APPROVED', 'CANCEL_DECLINED'],
    CANCELLED: ['EXIT_FLOW'],
  };

  // Check if this action is allowed in the current state
  if (!transitions[state.txState] || !transitions[state.txState].includes(action)) {
    // Action not allowed in this state — return state unchanged
    return state;
  }

  // Pre-FSM rewrite: CANCELLING + TAP_DECLINED → CANCEL_DECLINED
  let effectiveAction = action;
  let effectiveData = data;
  if (action === 'TAP_DECLINED' && state.txState === 'CANCELLING') {
    effectiveAction = 'CANCEL_DECLINED';
  }

  // Pre-FSM rewrite: partial payment rejection
  if (
    action === 'TAP_APPROVED' &&
    state.txState === 'AWAITING_TAP' &&
    typeof data.approvedAmount === 'number' &&
    data.approvedAmount < (state.amountCents ?? 0)
  ) {
    effectiveAction = 'TAP_DECLINED';
    effectiveData = {
      declineCode: 'PARTIAL_PAYMENT',
    };
  }

  // Apply state transitions based on effective action
  switch (effectiveAction) {
    case 'INITIATE_PAYMENT':
      return newState({
        txState: 'INITIATING',
        orderId: data.orderId,
        amountCents: data.amountCents,
        transferId: null,
        declineCode: null,
        approvedAmountCents: null,
        paymentId: null,
      });

    case 'TRANSFER_CREATED':
      return newState({
        txState: 'AWAITING_TAP',
        transferId: data.transferId,
      });

    case 'VERIFICATION_STARTED':
      return newState({
        txState: 'AWAITING_VERIFICATION',
      });

    case 'TAP_APPROVED':
      return newState({
        txState: 'RECORDING',
        approvedAmountCents: data.approvedAmount,
      });

    case 'TAP_DECLINED':
      return newState({
        txState: 'DECLINED',
        declineCode: data.declineCode ?? null,
      });

    case 'CANCEL_DECLINED':
      return newState({
        txState: 'CANCELLED',
        declineCode: data.declineCode ?? null,
      });

    case 'PAYMENT_RECORDED':
      return newState({
        txState: 'COMPLETED',
        paymentId: data.paymentId ?? null,
      });

    case 'CANCEL_PAYMENT':
      return newState({
        txState: 'CANCELLING',
      });

    case 'CANCEL_CONFIRMED':
      return newState({
        txState: 'CANCELLED',
      });

    case 'EXIT_FLOW':
      return newState({
        txState: 'IDLE',
        orderId: null,
        amountCents: null,
        transferId: null,
        declineCode: null,
        approvedAmountCents: null,
        paymentId: null,
      });

    default:
      return state;
  }
}