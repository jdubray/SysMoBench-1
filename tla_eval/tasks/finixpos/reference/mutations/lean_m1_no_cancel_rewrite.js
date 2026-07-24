/**
 * Hand-written reference lean-contract spec of the finixpos payment workflow.
 * Positive control for the study (docs/finixpos_study_plan.md §4).
 *
 * Dispatch-level single-step semantics of terminal-payment.ts:
 *   - FSM transition table (EXTRACTION.md §2), total: rejected actions no-op
 *   - CANCELLING + TAP_DECLINED -> CANCELLED (pre-FSM rewrite)
 *   - partial approval in AWAITING_TAP -> DECLINED with 'PARTIAL_PAYMENT'
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
      // Partial-payment guard (AWAITING_TAP only, strict <): rewrite to decline.
      if (
        s.txState === 'AWAITING_TAP' &&
        typeof data.approvedAmount === 'number' &&
        data.approvedAmount < (s.amountCents ?? 0)
      ) {
        s.txState = 'DECLINED';
        s.declineCode = 'PARTIAL_PAYMENT';
        return s;
      }
      s.txState = 'RECORDING';
      s.approvedAmountCents =
        typeof data.approvedAmount === 'number' ? data.approvedAmount : null;
      return s;
    }

    case 'TAP_DECLINED':
      if (!['INITIATING', 'AWAITING_TAP', 'AWAITING_VERIFICATION', 'CANCELLING'].includes(s.txState)) return s;
      s.txState = 'DECLINED';
      s.declineCode = data.declineCode ?? null;
      return s;

    case 'PAYMENT_RECORDED':
      if (s.txState !== 'RECORDING') return s;
      s.txState = 'COMPLETED';
      s.paymentId = data.paymentId ?? null;
      return s;

    case 'CANCEL_PAYMENT':
      if (!['INITIATING', 'AWAITING_TAP'].includes(s.txState)) return s;
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
