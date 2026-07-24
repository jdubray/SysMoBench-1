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
    // Pre-FSM acceptor: CANCELLING + TAP_DECLINED → rewrite to CANCEL_DECLINED
    if (action === 'TAP_DECLINED' && state.txState === 'CANCELLING') {
      action = 'CANCEL_DECLINED'
    }

    // Partial-payment guard: SUCCEEDED but amount < requested → TAP_DECLINED
    if (action === 'TAP_APPROVED' && state.txState === 'AWAITING_TAP') {
      const approved = data.approvedAmount
      if (typeof approved === 'number' && approved < (state.amountCents ?? 0)) {
        action = 'TAP_DECLINED'
        data = { declineCode: 'PARTIAL_PAYMENT', declineMessage: 'Partial payment not accepted' }
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

    if (!nextState) {
      // No transition defined — return state unchanged
      return state
    }

    // Apply action data to model
    const newState = { ...state }

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

      case 'VERIFICATION_STARTED':
        // No data fields to apply
        break

      case 'TAP_APPROVED':
        newState.approvedAmountCents = data.approvedAmount
        newState.declineCode         = null
        newState.declineMessage      = null
        break

      case 'TAP_DECLINED':
        newState.declineCode    = data.declineCode
        newState.declineMessage = data.declineMessage ?? null
        newState.approvedAmountCents = null
        break

      case 'CANCEL_DECLINED':
        newState.declineCode    = null
        newState.declineMessage = null
        break

      case 'PAYMENT_RECORDED':
        newState.paymentId = data.paymentId
        break

      case 'CANCEL_PAYMENT':
        // No data fields to apply
        break

      case 'CANCEL_CONFIRMED':
        // No data fields to apply
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

    newState.txState = nextState
    return newState
  },
}