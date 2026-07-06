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
  // Helper to create a new state with updates
  const update = (overrides) => ({
    txState: state.txState,
    orderId: state.orderId,
    amountCents: state.amountCents,
    transferId: state.transferId,
    declineCode: state.declineCode,
    approvedAmountCents: state.approvedAmountCents,
    paymentId: state.paymentId,
    ...overrides,
  });

  switch (action) {
    case 'INITIATE_PAYMENT':
      if (state.txState !== 'IDLE') {
        return state; // FSM rejects from non-IDLE
      }
      return update({
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
        return state; // FSM rejects from non-INITIATING
      }
      return update({
        txState: 'AWAITING_TAP',
        transferId: data.transferId,
      });

    case 'VERIFICATION_STARTED':
      if (state.txState !== 'INITIATING') {
        return state; // FSM rejects from non-INITIATING
      }
      return update({
        txState: 'AWAITING_VERIFICATION',
      });

    case 'TAP_APPROVED':
      if (state.txState !== 'AWAITING_TAP' && state.txState !== 'CANCELLING' && state.txState !== 'AWAITING_VERIFICATION') {
        return state; // FSM rejects from other states
      }
      // CANCELLING + TAP_APPROVED → RECORDING (not CANCELLED)
      // AWAITING_TAP + TAP_APPROVED → RECORDING
      // AWAITING_VERIFICATION + TAP_APPROVED → RECORDING
      return update({
        txState: 'RECORDING',
        approvedAmountCents: data.approvedAmount,
      });

    case 'TAP_DECLINED':
      if (state.txState === 'AWAITING_TAP') {
        // Normal decline path: AWAITING_TAP → DECLINED
        return update({
          txState: 'DECLINED',
          declineCode: data.declineCode,
        });
      } else if (state.txState === 'CANCELLING') {
        // CANCELLING + TAP_DECLINED → rewrite to CANCEL_DECLINED → CANCELLED
        return update({
          txState: 'CANCELLED',
          declineCode: data.declineCode,
        });
      } else if (state.txState === 'INITIATING' || state.txState === 'AWAITING_VERIFICATION') {
        // TAP_DECLINED can arrive in INITIATING or AWAITING_VERIFICATION
        return update({
          txState: 'DECLINED',
          declineCode: data.declineCode,
        });
      } else if (state.txState === 'RECORDING' || state.txState === 'COMPLETED') {
        // Anti-glitch: silently discard TAP_DECLINED in terminal states
        return state;
      }
      return state;

    case 'PAYMENT_RECORDED':
      if (state.txState !== 'RECORDING') {
        return state; // FSM rejects from non-RECORDING
      }
      return update({
        txState: 'COMPLETED',
        paymentId: data.paymentId,
      });

    case 'CANCEL_PAYMENT':
      if (state.txState === 'AWAITING_TAP' || state.txState === 'INITIATING') {
        return update({
          txState: 'CANCELLING',
        });
      }
      return state; // FSM rejects from other states

    case 'CANCEL_CONFIRMED':
      if (state.txState !== 'CANCELLING') {
        return state; // FSM rejects from non-CANCELLING
      }
      return update({
        txState: 'CANCELLED',
      });

    case 'EXIT_FLOW':
      if (state.txState !== 'COMPLETED' && state.txState !== 'DECLINED' && state.txState !== 'CANCELLED') {
        return state; // FSM rejects from non-terminal states
      }
      return update({
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