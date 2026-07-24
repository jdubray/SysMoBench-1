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
    // Pre-FSM acceptor: CANCELLING + TAP_DECLINED → CANCEL_DECLINED
    if (action === 'TAP_DECLINED' && state.txState === 'CANCELLING') {
      action = 'CANCEL_DECLINED'
    }

    // Partial-payment guard: SUCCEEDED but approved < requested → TAP_DECLINED
    if (action === 'TAP_APPROVED' && state.txState === 'AWAITING_TAP') {
      const approved = data.approvedAmount
      const requested = state.amountCents ?? 0
      if (typeof approved === 'number' && approved < requested) {
        action = 'TAP_DECLINED'
        data = { declineCode: 'PARTIAL_PAYMENT', declineMessage: `Card authorized $${(approved / 100).toFixed(2)} but order total is $${(requested / 100).toFixed(2)} — partial payments not accepted` }
      }
    }

    // FSM transition table
    const transitions = {
      'INITIATE_PAYMENT':      { 'IDLE': 'INITIATING' },
      'TRANSFER_CREATED':      { 'INITIATING': 'INITIATING', 'AWAITING_TAP': 'AWAITING_TAP' },
      'VERIFICATION_STARTED':  { 'INITIATING': 'INITIATING', 'AWAITING_VERIFICATION': 'AWAITING_VERIFICATION' },
      'TAP_APPROVED':          { 'AWAITING_TAP': 'AWAITING_TAP', 'AWAITING_VERIFICATION': 'AWAITING_VERIFICATION', 'RECORDING': 'RECORDING' },
      'TAP_DECLINED':          { 'AWAITING_TAP': 'DECLINED', 'AWAITING_VERIFICATION': 'DECLINED', 'CANCELLING': 'CANCELLED' },
      'CANCEL_DECLINED':       { 'CANCELLED': 'CANCELLED' },
      'PAYMENT_RECORDED':      { 'RECORDING': 'RECORDING', 'COMPLETED': 'COMPLETED' },
      'CANCEL_PAYMENT':        { 'INITIATING': 'CANCELLING', 'AWAITING_TAP': 'CANCELLING', 'AWAITING_VERIFICATION': 'CANCELLING', 'RECORDING': 'CANCELLING', 'CANCELLING': 'CANCELLING' },
      'CANCEL_CONFIRMED':      { 'CANCELLING': 'CANCELLED' },
      'EXIT_FLOW':             { 'COMPLETED': 'IDLE', 'DECLINED': 'IDLE', 'CANCELLED': 'IDLE' },
    }

    const nextState = transitions[action]?.[state.txState]
    if (!nextState) return state // no transition — state unchanged

    // Apply action data to new state
    const newState = {
      txState:             nextState,
      orderId:             state.orderId,
      amountCents:         state.amountCents,
      transferId:          state.transferId,
      declineCode:         state.declineCode,
      approvedAmountCents: state.approvedAmountCents,
      paymentId:           state.paymentId,
    }

    switch (action) {
      case 'INITIATE_PAYMENT':
        newState.orderId             = data.orderId
        newState.amountCents         = data.amountCents
        newState.transferId          = null
        newState.declineCode         = null
        newState.approvedAmountCents = null
        newState.paymentId           = null
        break

      case 'TRANSFER_CREATED':
        newState.transferId = data.transferId
        break

      case 'TAP_APPROVED':
        newState.approvedAmountCents = data.approvedAmount
        break

      case 'TAP_DECLINED':
        newState.declineCode = data.declineCode
        break

      case 'PAYMENT_RECORDED':
        newState.paymentId = data.paymentId
        break

      case 'CANCEL_CONFIRMED':
        newState.declineCode = null
        break

      case 'EXIT_FLOW':
        newState.orderId             = null
        newState.amountCents         = null
        newState.transferId          = null
        newState.declineCode         = null
        newState.approvedAmountCents = null
        newState.paymentId           = null
        break
    }

    return newState
  },
}