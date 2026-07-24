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
  paymentId: null
};

const clone = (value) => JSON.parse(JSON.stringify(value));

const { intents } = instance({
  initialState: clone(INITIAL_STATE),
  component: {
    actions: [
      (data) => ({ __name: 'INITIATE_PAYMENT', orderId: data.orderId, amountCents: data.amountCents }),
      (data) => ({ __name: 'TRANSFER_CREATED', transferId: data.transferId }),
      () => ({ __name: 'VERIFICATION_STARTED' }),
      (data) => ({ __name: 'TAP_APPROVED', approvedAmount: data.approvedAmount }),
      (data) => ({ __name: 'TAP_DECLINED', declineCode: data.declineCode }),
      (data) => ({ __name: 'PAYMENT_RECORDED', paymentId: data.paymentId }),
      () => ({ __name: 'CANCEL_PAYMENT' }),
      () => ({ __name: 'CANCEL_CONFIRMED' }),
      () => ({ __name: 'EXIT_FLOW' })
    ],
    acceptors: [
      // Pre-FSM rewrites
      (model) => (proposal) => {
        if (proposal.__name === 'TAP_DECLINED' && model.txState === 'CANCELLING') {
          proposal.__name = 'CANCEL_DECLINED';
        }
        if (proposal.__name === 'TAP_APPROVED' && model.txState === 'AWAITING_TAP' &&
            typeof proposal.approvedAmount === 'number' &&
            proposal.approvedAmount < (model.amountCents ?? 0)) {
          proposal.__name = 'TAP_DECLINED';
          proposal.declineCode = 'PARTIAL_PAYMENT';
        }
      },
      // FSM state transitions
      (model) => (proposal) => {
        const validTransitions = {
          IDLE: ['INITIATE_PAYMENT'],
          INITIATING: ['TRANSFER_CREATED', 'VERIFICATION_STARTED', 'TAP_DECLINED', 'CANCEL_PAYMENT'],
          AWAITING_TAP: ['TAP_APPROVED', 'TAP_DECLINED', 'CANCEL_PAYMENT'],
          AWAITING_VERIFICATION: ['TAP_APPROVED', 'TAP_DECLINED'],
          RECORDING: ['PAYMENT_RECORDED'],
          COMPLETED: ['EXIT_FLOW'],
          DECLINED: ['EXIT_FLOW'],
          CANCELLING: ['CANCEL_CONFIRMED', 'TAP_APPROVED', 'CANCEL_DECLINED'],
          CANCELLED: ['EXIT_FLOW']
        };
        if (validTransitions[model.txState]?.includes(proposal.__name)) {
          model.txState = {
            INITIATE_PAYMENT: 'INITIATING',
            TRANSFER_CREATED: 'AWAITING_TAP',
            VERIFICATION_STARTED: 'AWAITING_VERIFICATION',
            TAP_APPROVED: 'RECORDING',
            TAP_DECLINED: 'DECLINED',
            CANCEL_DECLINED: 'CANCELLED',
            PAYMENT_RECORDED: 'COMPLETED',
            CANCEL_PAYMENT: 'CANCELLING',
            CANCEL_CONFIRMED: 'CANCELLED',
            EXIT_FLOW: 'IDLE'
          }[proposal.__name];
        }
      },
      // Apply action data to model
      (model) => (proposal) => {
        if (proposal.__name === 'INITIATE_PAYMENT' && model.txState === 'INITIATING') {
          model.orderId = proposal.orderId;
          model.amountCents = proposal.amountCents;
          model.transferId = null;
          model.declineCode = null;
          model.approvedAmountCents = null;
          model.paymentId = null;
        }
        if (proposal.__name === 'TRANSFER_CREATED' && model.txState === 'AWAITING_TAP') {
          model.transferId = proposal.transferId;
        }
        if (proposal.__name === 'TAP_APPROVED' && model.txState === 'RECORDING') {
          model.approvedAmountCents = proposal.approvedAmount;
        }
        if ((proposal.__name === 'TAP_DECLINED' && model.txState === 'DECLINED') ||
            (proposal.__name === 'CANCEL_DECLINED' && model.txState === 'CANCELLED')) {
          model.declineCode = proposal.declineCode;
        }
        if (proposal.__name === 'PAYMENT_RECORDED' && model.txState === 'COMPLETED') {
          model.paymentId = proposal.paymentId;
        }
        if (proposal.__name === 'EXIT_FLOW' && model.txState === 'IDLE') {
          model.orderId = null;
          model.amountCents = null;
          model.transferId = null;
          model.declineCode = null;
          model.approvedAmountCents = null;
          model.paymentId = null;
        }
      }
    ],
    reactors: [
      (model) => () => {
        if (model.txState === 'RECORDING') {
          model.txState = 'COMPLETED';
        }
      }
    ]
  }
});

const sanitizeReplacer = (key, value) => {
  if (typeof key === 'string' && key.startsWith('__')) return undefined;
  if (typeof value === 'function') return undefined;
  return value;
};

const getState = () => JSON.parse(JSON.stringify(instance({}).state(), sanitizeReplacer));

const setState = (snapshot) => {
  instance({ initialState: clone(snapshot) });
};

const init = () => {
  instance({}).state().clearError();
  setState(clone(INITIAL_STATE));
};

const actions = {
  INITIATE_PAYMENT: (data) => intents[0](data),
  TRANSFER_CREATED: (data) => intents[1](data),
  VERIFICATION_STARTED: () => intents[2](),
  TAP_APPROVED: (data) => intents[3](data),
  TAP_DECLINED: (data) => intents[4](data),
  PAYMENT_RECORDED: (data) => intents[5](data),
  CANCEL_PAYMENT: () => intents[6](),
  CANCEL_CONFIRMED: () => intents[7](),
  EXIT_FLOW: () => intents[8]()
};

const checkerIntents = [
  { name: 'INITIATE_PAYMENT', intent: actions.INITIATE_PAYMENT, values: [
    [{ orderId: 'O1', amountCents: 1000 }],
    [{ orderId: 'O2', amountCents: 500 }]
  ]},
  { name: 'TRANSFER_CREATED', intent: actions.TRANSFER_CREATED, values: [
    [{ transferId: 'TR1' }],
    [{ transferId: 'TR2' }]
  ]},
  { name: 'VERIFICATION_STARTED', intent: actions.VERIFICATION_STARTED, values: [[{}]]},
  { name: 'TAP_APPROVED', intent: actions.TAP_APPROVED, values: [
    [{ approvedAmount: 1000 }],
    [{ approvedAmount: 1500 }]
  ]},
  { name: 'TAP_DECLINED', intent: actions.TAP_DECLINED, values: [
    [{ declineCode: 'INSUFFICIENT_FUNDS' }],
    [{ declineCode: 'CANCELLATION_VIA_API' }],
    [{ declineCode: null }]
  ]},
  { name: 'PAYMENT_RECORDED', intent: actions.PAYMENT_RECORDED, values: [
    [{ paymentId: 'P1' }],
    [{ paymentId: null }]
  ]},
  { name: 'CANCEL_PAYMENT', intent: actions.CANCEL_PAYMENT, values: [[{}]]},
  { name: 'CANCEL_CONFIRMED', intent: actions.CANCEL_CONFIRMED, values: [[{}]]},
  { name: 'EXIT_FLOW', intent: actions.EXIT_FLOW, values: [[{}]]}
];

module.exports = { instance, init, actions, getState, setState, checkerIntents };