'use strict';

const { createInstance } = require('@cognitive-fab/sam-pattern');

const instance = createInstance({ instanceName: 'finixpos', hasAsyncActions: false });

const INITIAL_STATE = {
  txState: 'IDLE',
  orderId: null,
  amountCents: null,
  transferId: null,
  declineCode: null,
  approvedAmountCents: null,
  paymentId: null,
};

const clone = (value) => JSON.parse(JSON.stringify(value));

const sanitizeReplacer = (key, value) => {
  if (typeof key === 'string' && key.startsWith('__')) return undefined;
  if (typeof value === 'function') return undefined;
  return value;
};

// FSM allowed transitions
const ALLOWED_TRANSITIONS = {
  IDLE:                  ['INITIATE_PAYMENT'],
  INITIATING:            ['TRANSFER_CREATED', 'VERIFICATION_STARTED', 'TAP_DECLINED', 'CANCEL_PAYMENT'],
  AWAITING_TAP:          ['TAP_APPROVED', 'TAP_DECLINED', 'CANCEL_PAYMENT'],
  AWAITING_VERIFICATION: ['TAP_APPROVED', 'TAP_DECLINED'],
  PROCESSING:            [],
  RECORDING:             ['PAYMENT_RECORDED'],
  COMPLETED:             ['EXIT_FLOW'],
  DECLINED:              ['EXIT_FLOW'],
  CANCELLING:            ['CANCEL_CONFIRMED', 'TAP_APPROVED', 'CANCEL_DECLINED'],
  CANCELLED:             ['EXIT_FLOW'],
};

// FSM next-state map
const NEXT_STATE = {
  INITIATE_PAYMENT:     'INITIATING',
  TRANSFER_CREATED:     'AWAITING_TAP',
  VERIFICATION_STARTED: 'AWAITING_VERIFICATION',
  TAP_APPROVED:         'RECORDING',
  TAP_DECLINED:         'DECLINED',
  CANCEL_DECLINED:      'CANCELLED',
  PAYMENT_RECORDED:     'COMPLETED',
  CANCEL_PAYMENT:       'CANCELLING',
  CANCEL_CONFIRMED:     'CANCELLED',
  EXIT_FLOW:            'IDLE',
};

const { intents } = instance({
  initialState: clone(INITIAL_STATE),
  component: {
    actions: [
      (data) => ({ __name: 'INITIATE_PAYMENT', orderId: data.orderId, amountCents: data.amountCents }),
      (data) => ({ __name: 'TRANSFER_CREATED', transferId: data.transferId }),
      (data) => ({ __name: 'VERIFICATION_STARTED' }),
      (data) => ({ __name: 'TAP_APPROVED', approvedAmount: data.approvedAmount }),
      (data) => ({ __name: 'TAP_DECLINED', declineCode: data.declineCode }),
      (data) => ({ __name: 'PAYMENT_RECORDED', paymentId: data.paymentId }),
      (data) => ({ __name: 'CANCEL_PAYMENT' }),
      (data) => ({ __name: 'CANCEL_CONFIRMED' }),
      (data) => ({ __name: 'EXIT_FLOW' }),
    ],
    acceptors: [
      // Pre-FSM rewrite: TAP_DECLINED in CANCELLING → CANCEL_DECLINED
      (model) => (proposal) => {
        if (proposal.__name === 'TAP_DECLINED' && model.txState === 'CANCELLING') {
          proposal.__name = 'CANCEL_DECLINED';
        }
      },

      // Pre-FSM rewrite: partial payment guard
      // TAP_APPROVED where approvedAmount < amountCents → TAP_DECLINED with PARTIAL_PAYMENT
      (model) => (proposal) => {
        if (
          proposal.__name === 'TAP_APPROVED' &&
          model.txState === 'AWAITING_TAP' &&
          typeof proposal.approvedAmount === 'number' &&
          proposal.approvedAmount < (model.amountCents || 0)
        ) {
          proposal.__name = 'TAP_DECLINED';
          proposal.declineCode = 'PARTIAL_PAYMENT';
        }
      },

      // FSM transition guard: enforce allowed transitions
      (model) => (proposal) => {
        const actionName = proposal.__name;
        const allowed = ALLOWED_TRANSITIONS[model.txState] || [];
        if (!allowed.includes(actionName)) {
          // Silently reject — mark as blocked so subsequent acceptors skip
          proposal.__blocked = true;
          return;
        }
        // Advance txState
        const nextState = NEXT_STATE[actionName];
        if (nextState !== undefined) {
          model.txState = nextState;
        }
      },

      // Apply action data to model (guarded by post-transition txState)
      (model) => (proposal) => {
        if (proposal.__blocked) return;

        const action = proposal.__name;

        if (action === 'INITIATE_PAYMENT' && model.txState === 'INITIATING') {
          model.orderId             = proposal.orderId !== undefined ? proposal.orderId : null;
          model.amountCents         = proposal.amountCents !== undefined ? proposal.amountCents : null;
          model.transferId          = null;
          model.declineCode         = null;
          model.approvedAmountCents = null;
          model.paymentId           = null;
        }

        if (action === 'TRANSFER_CREATED' && model.txState === 'AWAITING_TAP') {
          model.transferId = proposal.transferId !== undefined ? proposal.transferId : null;
        }

        // VERIFICATION_STARTED: no observable field changes beyond txState

        if (action === 'TAP_APPROVED' && model.txState === 'RECORDING') {
          model.approvedAmountCents = typeof proposal.approvedAmount === 'number'
            ? proposal.approvedAmount
            : null;
        }

        if (action === 'TAP_DECLINED' && model.txState === 'DECLINED') {
          model.declineCode = proposal.declineCode !== undefined ? proposal.declineCode : null;
        }

        if (action === 'CANCEL_DECLINED' && model.txState === 'CANCELLED') {
          // declineCode not tracked in observable state for CANCEL_DECLINED path
        }

        if (action === 'PAYMENT_RECORDED' && model.txState === 'COMPLETED') {
          model.paymentId = proposal.paymentId !== undefined ? proposal.paymentId : null;
        }

        // CANCEL_PAYMENT, CANCEL_CONFIRMED: no observable field changes beyond txState

        if (action === 'EXIT_FLOW' && model.txState === 'IDLE') {
          model.orderId             = null;
          model.amountCents         = null;
          model.transferId          = null;
          model.declineCode         = null;
          model.approvedAmountCents = null;
          model.paymentId           = null;
        }
      },
    ],
  },
});

const [
  initiatePaymentIntent,
  transferCreatedIntent,
  verificationStartedIntent,
  tapApprovedIntent,
  tapDeclinedIntent,
  paymentRecordedIntent,
  cancelPaymentIntent,
  cancelConfirmedIntent,
  exitFlowIntent,
] = intents;

const getState = () => {
  const raw = instance({}).state();
  const full = JSON.parse(JSON.stringify(raw, sanitizeReplacer));
  return {
    txState:             full.txState             !== undefined ? full.txState             : 'IDLE',
    orderId:             full.orderId             !== undefined ? full.orderId             : null,
    amountCents:         full.amountCents         !== undefined ? full.amountCents         : null,
    transferId:          full.transferId          !== undefined ? full.transferId          : null,
    declineCode:         full.declineCode         !== undefined ? full.declineCode         : null,
    approvedAmountCents: full.approvedAmountCents !== undefined ? full.approvedAmountCents : null,
    paymentId:           full.paymentId           !== undefined ? full.paymentId           : null,
  };
};

const setState = (snapshot) => {
  instance({ initialState: clone(snapshot) });
};

const init = () => {
  instance({}).state().clearError();
  setState(INITIAL_STATE);
};

const actions = {
  INITIATE_PAYMENT:     (data) => initiatePaymentIntent(data),
  TRANSFER_CREATED:     (data) => transferCreatedIntent(data),
  VERIFICATION_STARTED: (data) => verificationStartedIntent(data),
  TAP_APPROVED:         (data) => tapApprovedIntent(data),
  TAP_DECLINED:         (data) => tapDeclinedIntent(data),
  PAYMENT_RECORDED:     (data) => paymentRecordedIntent(data),
  CANCEL_PAYMENT:       (data) => cancelPaymentIntent(data),
  CANCEL_CONFIRMED:     (data) => cancelConfirmedIntent(data),
  EXIT_FLOW:            (data) => exitFlowIntent(data),
};

const checkerIntents = [
  {
    name: 'INITIATE_PAYMENT',
    intent: actions.INITIATE_PAYMENT,
    values: [
      [{ orderId: 'O1', amountCents: 500 }],
      [{ orderId: 'O1', amountCents: 1000 }],
      [{ orderId: 'O2', amountCents: 1500 }],
    ],
  },
  {
    name: 'TRANSFER_CREATED',
    intent: actions.TRANSFER_CREATED,
    values: [
      [{ transferId: 'TR1' }],
    ],
  },
  {
    name: 'VERIFICATION_STARTED',
    intent: actions.VERIFICATION_STARTED,
    values: [
      [{}],
    ],
  },
  {
    name: 'TAP_APPROVED',
    intent: actions.TAP_APPROVED,
    values: [
      [{ approvedAmount: 500 }],
      [{ approvedAmount: 1000 }],
      [{ approvedAmount: 1500 }],
      [{ approvedAmount: 400 }],
    ],
  },
  {
    name: 'TAP_DECLINED',
    intent: actions.TAP_DECLINED,
    values: [
      [{ declineCode: 'INSUFFICIENT_FUNDS' }],
      [{ declineCode: 'CANCELLATION_VIA_API' }],
      [{ declineCode: 'CANCELLATION_VIA_DEVICE' }],
      [{ declineCode: 'IMMEDIATE_FAILURE' }],
      [{ declineCode: null }],
    ],
  },
  {
    name: 'PAYMENT_RECORDED',
    intent: actions.PAYMENT_RECORDED,
    values: [
      [{ paymentId: 'P1' }],
      [{ paymentId: null }],
    ],
  },
  {
    name: 'CANCEL_PAYMENT',
    intent: actions.CANCEL_PAYMENT,
    values: [
      [{}],
    ],
  },
  {
    name: 'CANCEL_CONFIRMED',
    intent: actions.CANCEL_CONFIRMED,
    values: [
      [{}],
    ],
  },
  {
    name: 'EXIT_FLOW',
    intent: actions.EXIT_FLOW,
    values: [
      [{}],
    ],
  },
];

module.exports = { instance, init, actions, getState, setState, checkerIntents };