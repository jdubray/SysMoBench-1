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
      'IDLE':                  { 'INITIATE_PAYMENT': 'INITIATING' },
      'INITIATING':            { 'TRANSFER_CREATED': 'AWAITING_TAP', 'VERIFICATION_STARTED': 'AWAITING_VERIFICATION', 'TAP_DECLINED': 'DECLINED', 'CANCEL_PAYMENT': 'CANCELLING' },
      'AWAITING_TAP':          { 'TAP_APPROVED': 'RECORDING', 'TAP_DECLINED': 'DECLINED', 'CANCEL_PAYMENT': 'CANCELLING' },
      'AWAITING_VERIFICATION': { 'TAP_APPROVED': 'RECORDING', 'TAP_DECLINED': 'DECLINED' },
      'RECORDING':             { 'PAYMENT_RECORDED': 'COMPLETED' },
      'COMPLETED':             { 'EXIT_FLOW': 'IDLE' },
      'DECLINED':              { 'EXIT_FLOW': 'IDLE' },
      'CANCELLING':            { 'CANCEL_CONFIRMED': 'CANCELLED', 'TAP_APPROVED': 'RECORDING', 'CANCEL_DECLINED': 'CANCELLED' },
      'CANCELLED':             { 'EXIT_FLOW': 'IDLE' },
    }

    const nextState = transitions[state.txState]?.[action]
    if (!nextState) return state // no transition — state unchanged

    // Apply action data to model
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