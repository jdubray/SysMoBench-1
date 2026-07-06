module.exports = {
  init: function() {
    return {
      txState: 'IDLE',
      orderId: null,
      amountCents: null,
      transferId: null,
      declineCode: null,
      approvedAmountCents: null,
      paymentId: null
    };
  },

  next: function(state, action, data) {
    const newState = { ...state };

    switch (action) {
      case 'INITIATE_PAYMENT':
        if (state.txState === 'IDLE') {
          newState.txState = 'INITIATING';
          newState.orderId = data.orderId;
          newState.amountCents = data.amountCents;
          newState.transferId = null;
          newState.declineCode = null;
          newState.approvedAmountCents = null;
          newState.paymentId = null;
        }
        break;

      case 'TRANSFER_CREATED':
        if (state.txState === 'INITIATING') {
          newState.txState = 'AWAITING_TAP';
          newState.transferId = data.transferId;
        }
        break;

      case 'VERIFICATION_STARTED':
        if (state.txState === 'INITIATING') {
          newState.txState = 'AWAITING_VERIFICATION';
        }
        break;

      case 'TAP_APPROVED':
        if (state.txState === 'AWAITING_TAP' || state.txState === 'AWAITING_VERIFICATION') {
          newState.txState = 'RECORDING';
          newState.approvedAmountCents = data.approvedAmount;
        }
        break;

      case 'TAP_DECLINED':
        if (state.txState === 'AWAITING_TAP') {
          newState.txState = 'DECLINED';
          newState.declineCode = data.declineCode;
        } else if (state.txState === 'CANCELLING') {
          newState.txState = 'CANCELLED';
          newState.declineCode = data.declineCode;
        }
        break;

      case 'PAYMENT_RECORDED':
        if (state.txState === 'RECORDING') {
          newState.txState = 'COMPLETED';
          newState.paymentId = data.paymentId;
        }
        break;

      case 'CANCEL_PAYMENT':
        if (state.txState === 'AWAITING_TAP' || state.txState === 'INITIATING') {
          newState.txState = 'CANCELLING';
        }
        break;

      case 'CANCEL_CONFIRMED':
        if (state.txState === 'CANCELLING') {
          newState.txState = 'CANCELLED';
        }
        break;

      case 'EXIT_FLOW':
        if (state.txState === 'COMPLETED' || state.txState === 'DECLINED' || state.txState === 'CANCELLED') {
          newState.txState = 'IDLE';
          newState.orderId = null;
          newState.amountCents = null;
          newState.transferId = null;
          newState.declineCode = null;
          newState.approvedAmountCents = null;
          newState.paymentId = null;
        }
        break;
    }

    return newState;
  }
};