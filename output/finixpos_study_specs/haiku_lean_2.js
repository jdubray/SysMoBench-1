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

  switch (action) {
    case 'INITIATE_PAYMENT':
      if (state.txState !== 'IDLE') {
        return state;
      }
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
      if (state.txState !== 'INITIATING') {
        return state;
      }
      return newState({
        txState: 'AWAITING_TAP',
        transferId: data.transferId,
      });

    case 'VERIFICATION_STARTED':
      if (state.txState !== 'INITIATING') {
        return state;
      }
      return newState({
        txState: 'AWAITING_VERIFICATION',
      });

    case 'TAP_APPROVED':
      if (state.txState !== 'AWAITING_TAP' && state.txState !== 'CANCELLING') {
        return state;
      }
      if (state.txState === 'CANCELLING') {
        return state;
      }
      return newState({
        txState: 'RECORDING',
        approvedAmountCents: data.approvedAmount,
      });

    case 'TAP_DECLINED':
      if (state.txState === 'AWAITING_TAP') {
        return newState({
          txState: 'DECLINED',
          declineCode: data.declineCode,
        });
      }
      if (state.txState === 'CANCELLING') {
        return newState({
          txState: 'CANCELLED',
          declineCode: data.declineCode,
        });
      }
      if (state.txState === 'INITIATING') {
        return newState({
          txState: 'DECLINED',
          declineCode: data.declineCode,
        });
      }
      return state;

    case 'CANCEL_DECLINED':
      if (state.txState !== 'CANCELLING') {
        return state;
      }
      return newState({
        txState: 'CANCELLED',
        declineCode: data.declineCode,
      });

    case 'PAYMENT_RECORDED':
      if (state.txState !== 'RECORDING') {
        return state;
      }
      return newState({
        txState: 'COMPLETED',
        paymentId: data.paymentId,
      });

    case 'CANCEL_PAYMENT':
      if (state.txState !== 'AWAITING_TAP' && state.txState !== 'AWAITING_VERIFICATION') {
        return state;
      }
      return newState({
        txState: 'CANCELLING',
      });

    case 'CANCEL_CONFIRMED':
      if (state.txState !== 'CANCELLING') {
        return state;
      }
      return newState({
        txState: 'CANCELLED',
      });

    case 'EXIT_FLOW':
      if (state.txState !== 'COMPLETED' && state.txState !== 'DECLINED' && state.txState !== 'CANCELLED') {
        return state;
      }
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