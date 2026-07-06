module.exports = {
  init: () => ({
    txState:             'IDLE',
    orderId:             null,
    amountCents:         null,
    transferId:          null,
    declineCode:         null,
    approvedAmountCents: null,
    paymentId:           null,
  }),

  next: (state, action, data) => {
    // Pre-FSM rewrites (observable as state changes)
    if (action === 'TAP_DECLINED' && state.txState === 'CANCELLING') {
      action = 'CANCEL_DECLINED';
    }

    // Partial-payment guard: TAP_APPROVED with approvedAmount < amountCents
    // becomes TAP_DECLINED with PARTIAL_PAYMENT
    if (action === 'TAP_APPROVED' && state.txState === 'AWAITING_TAP') {
      const approved = data.approvedAmount;
      if (typeof approved === 'number' && approved < (state.amountCents ?? 0)) {
        action = 'TAP_DECLINED';
        data = { declineCode: 'PARTIAL_PAYMENT', declineMessage: `Card authorized $${(approved / 100).toFixed(2)} but order total is $${(state.amountCents / 100).toFixed(2)} — partial payments not accepted` };
      }
    }

    // FSM transition table (deterministic, no external state)
    const transitions = {
      'IDLE':                  { 'INITIATE_PAYMENT': 'INITIATING' },
      'INITIATING':            { 'TRANSFER_CREATED': 'AWAITING_TAP', 'VERIFICATION_STARTED': 'AWAITING_VERIFICATION', 'TAP_DECLINED': 'DECLINED', 'CANCEL_PAYMENT': 'CANCELLING' },
      'AWAITING_TAP':          { 'TAP_APPROVED': 'RECORDING', 'TAP_DECLINED': 'DECLINED', 'CANCEL_PAYMENT': 'CANCELLING' },
      'AWAITING_VERIFICATION': { 'TAP_APPROVED': 'RECORDING', 'TAP_DECLINED': 'DECLINED' },
      'RECORDING':             { 'PAYMENT_RECORDED': 'COMPLETED' },
      'COMPLETED':             { 'EXIT_FLOW': 'IDLE' },
      'DECLINED':              { 'EXIT_FLOW': 'IDLE' },
      'CANCELLING':            { 'CANCEL_CONFIRMED': 'CANCELLED', 'TAP_APPROVED': 'RECORDING', 'CANCEL_DECLINED': 'CANCELLED' },
      'CANCELLED':             { 'EXIT_FLOW': 'IDLE' },
    };

    const nextState = transitions[state.txState]?.[action];

    // No transition defined — return state unchanged (silently discard)
    if (!nextState) return state;

    // Build new state based on action and target state
    const newState = { ...state };

    if (action === 'INITIATE_PAYMENT' && nextState === 'INITIATING') {
      newState.orderId             = data.orderId;
      newState.amountCents         = data.amountCents;
      newState.transferId          = null;
      newState.declineCode         = null;
      newState.approvedAmountCents = null;
      newState.paymentId           = null;
    }

    if (action === 'TRANSFER_CREATED' && nextState === 'AWAITING_TAP') {
      newState.transferId = data.transferId;
    }

    if (action === 'TAP_APPROVED' && nextState === 'RECORDING') {
      newState.approvedAmountCents = data.approvedAmount;
    }

    if ((action === 'TAP_DECLINED' && nextState === 'DECLINED') ||
        (action === 'CANCEL_DECLINED' && nextState === 'CANCELLED')) {
      newState.declineCode = data.declineCode;
    }

    if (action === 'PAYMENT_RECORDED' && nextState === 'COMPLETED') {
      newState.paymentId = data.paymentId;
    }

    if (action === 'EXIT_FLOW' && nextState === 'IDLE') {
      newState.orderId             = null;
      newState.amountCents         = null;
      newState.transferId          = null;
      newState.declineCode         = null;
      newState.approvedAmountCents = null;
      newState.paymentId           = null;
    }

    newState.txState = nextState;
    return newState;
  },
};