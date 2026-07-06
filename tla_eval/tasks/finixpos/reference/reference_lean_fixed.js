/**
 * Hand-written reference lean-contract spec of the PATCHED finixpos payment
 * workflow (terminal-payment-gapfix-preview.ts). Positive control for the
 * post-fix corpus (data/sys_traces/finixpos_fixed).
 *
 * Dispatch-level deltas vs reference_lean.js, per the fixed traces:
 *   - partial guard fires in AWAITING_TAP, CANCELLING and AWAITING_VERIFICATION
 *     (CANCELLING partial -> CANCELLED; others -> DECLINED), and STASHES the
 *     settled amount (approvedAmountCents) and transfer id on the rejection
 *   - TAP_APPROVED data may carry `transferId` (recovery dispatches); it is
 *     applied only when the model has none
 *   - CANCEL_PAYMENT is also accepted from AWAITING_VERIFICATION
 */

'use strict';

const INITIAL_STATE = {
  txState: 'IDLE',
  orderId: null,
  amountCents: null,
  transferId: null,
  declineCode: null,
  approvedAmountCents: null,
  paymentId: null,
};

const init = () => ({ ...INITIAL_STATE });

const next = (state, action, data = {}) => {
  const s = { ...state };
  switch (action) {
    case 'INITIATE_PAYMENT':
      if (s.txState !== 'IDLE') return s;
      return {
        txState: 'INITIATING',
        orderId: data.orderId,
        amountCents: data.amountCents,
        transferId: null,
        declineCode: null,
        approvedAmountCents: null,
        paymentId: null,
      };

    case 'TRANSFER_CREATED':
      if (s.txState !== 'INITIATING') return s;
      s.txState = 'AWAITING_TAP';
      s.transferId = data.transferId;
      return s;

    case 'VERIFICATION_STARTED':
      if (s.txState !== 'INITIATING') return s;
      s.txState = 'AWAITING_VERIFICATION';
      return s;

    case 'TAP_APPROVED': {
      const ok = ['AWAITING_TAP', 'AWAITING_VERIFICATION', 'CANCELLING'];
      if (!ok.includes(s.txState)) return s;
      const tid = data.transferId ?? null;
      // Widened partial guard (strict <), all three approvable states; the
      // rejection stashes the settled amount + transfer id for the refund.
      if (
        typeof data.approvedAmount === 'number' &&
        data.approvedAmount < (s.amountCents ?? 0)
      ) {
        s.txState = s.txState === 'CANCELLING' ? 'CANCELLED' : 'DECLINED';
        s.declineCode = 'PARTIAL_PAYMENT';
        s.approvedAmountCents = data.approvedAmount;
        s.transferId = s.transferId ?? tid;
        return s;
      }
      s.txState = 'RECORDING';
      s.approvedAmountCents =
        typeof data.approvedAmount === 'number' ? data.approvedAmount : null;
      s.transferId = s.transferId ?? tid;
      return s;
    }

    case 'TAP_DECLINED':
      if (s.txState === 'CANCELLING') {
        s.txState = 'CANCELLED';
        s.declineCode = data.declineCode ?? null;
        return s;
      }
      if (!['INITIATING', 'AWAITING_TAP', 'AWAITING_VERIFICATION'].includes(s.txState)) return s;
      s.txState = 'DECLINED';
      s.declineCode = data.declineCode ?? null;
      return s;

    case 'PAYMENT_RECORDED':
      if (s.txState !== 'RECORDING') return s;
      s.txState = 'COMPLETED';
      s.paymentId = data.paymentId ?? null;
      return s;

    case 'CANCEL_PAYMENT':
      if (!['INITIATING', 'AWAITING_TAP', 'AWAITING_VERIFICATION'].includes(s.txState)) return s;
      s.txState = 'CANCELLING';
      return s;

    case 'CANCEL_CONFIRMED':
      if (s.txState !== 'CANCELLING') return s;
      s.txState = 'CANCELLED';
      return s;

    case 'EXIT_FLOW':
      if (!['COMPLETED', 'DECLINED', 'CANCELLED'].includes(s.txState)) return s;
      return { ...INITIAL_STATE };

    default:
      return s;
  }
};

module.exports = { init, next };
