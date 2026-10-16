import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ORDER_STATES, TERMINAL, TRANSITIONS, canTransition, label, needsRefund, nextStates } from '../contract/src/order.ts';
import type { OrderFacts, OrderState } from '../contract/src/order.ts';

const DELIVERY_COD: OrderFacts = { fulfilment: 'DELIVERY', payment: 'COD' };
const PICKUP_ONLINE: OrderFacts = { fulfilment: 'PICKUP', payment: 'ONLINE' };
const ok = (o: OrderFacts, path: OrderState[], actors: Array<'customer' | 'pos' | 'hub' | 'gateway'>) => {
  for (let i = 1; i < path.length; i++) assert.deepEqual(canTransition(o, path[i - 1]!, path[i]!, actors[i - 1]!), { ok: true }, `${path[i - 1]} -> ${path[i]}`);
};

test('order life cycle: the happy paths for COD delivery and online-paid pickup', () => {
  ok(DELIVERY_COD, ['PLACED', 'SENT_TO_STORE', 'RECEIVED', 'ACCEPTED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY', 'DELIVERED'], ['hub', 'pos', 'pos', 'pos', 'pos', 'pos', 'pos']);
  ok(PICKUP_ONLINE, ['PLACED', 'PAYMENT_PENDING', 'SENT_TO_STORE', 'ACCEPTED', 'READY', 'PICKED_UP'], ['customer', 'gateway', 'pos', 'pos', 'pos']);
  ok(PICKUP_ONLINE, ['PLACED', 'PAYMENT_PENDING', 'PAYMENT_FAILED', 'PAYMENT_PENDING', 'SENT_TO_STORE'], ['customer', 'gateway', 'customer', 'gateway']); // retry payment
});

test('order life cycle: wrong paths, wrong actors and finished orders are refused with a reason', () => {
  assert.equal(canTransition(DELIVERY_COD, 'PLACED', 'PAYMENT_PENDING', 'customer').ok, false); // COD has no online payment
  assert.equal(canTransition(PICKUP_ONLINE, 'PLACED', 'SENT_TO_STORE', 'hub').ok, false); // online orders wait for payment
  assert.equal(canTransition(PICKUP_ONLINE, 'READY', 'OUT_FOR_DELIVERY', 'pos').ok, false); // pickup has no rider
  assert.equal(canTransition(DELIVERY_COD, 'READY', 'PICKED_UP', 'pos').ok, false);
  assert.match((canTransition(DELIVERY_COD, 'SENT_TO_STORE', 'ACCEPTED', 'customer') as { reason: string }).reason, /Only pos/);
  assert.equal(canTransition(DELIVERY_COD, 'ACCEPTED', 'CANCELLED', 'customer').ok, false); // after accept only the store can cancel
  assert.equal(canTransition(DELIVERY_COD, 'ACCEPTED', 'CANCELLED', 'pos').ok, true);
  assert.equal(canTransition(PICKUP_ONLINE, 'PAYMENT_PENDING', 'SENT_TO_STORE', 'customer').ok, false); // only the gateway confirms payment
  for (const t of TERMINAL) for (const to of ORDER_STATES) assert.equal(canTransition(DELIVERY_COD, t, to, 'pos').ok, false, `${t} is final`);
  assert.match((canTransition(DELIVERY_COD, 'DELIVERED', 'CANCELLED', 'pos') as { reason: string }).reason, /already delivered/);
});

test('order life cycle: buttons per actor, refunds, and every state reachable and labelled', () => {
  assert.deepEqual(nextStates(DELIVERY_COD, 'RECEIVED', 'pos').sort(), ['ACCEPTED', 'REJECTED']);
  assert.deepEqual(nextStates(DELIVERY_COD, 'RECEIVED', 'hub'), ['AUTO_REJECTED']);
  assert.deepEqual(nextStates(DELIVERY_COD, 'RECEIVED', 'customer'), ['CANCELLED']);
  assert.deepEqual(nextStates(DELIVERY_COD, 'READY', 'pos').sort(), ['CANCELLED', 'OUT_FOR_DELIVERY']);
  assert.equal(needsRefund({ ...PICKUP_ONLINE, paid: true }, 'AUTO_REJECTED'), true);
  assert.equal(needsRefund({ ...DELIVERY_COD, paid: false }, 'REJECTED'), false);
  assert.equal(needsRefund({ ...PICKUP_ONLINE, paid: true }, 'READY'), false);
  const reachable = new Set<OrderState>(['PLACED', ...TRANSITIONS.map((t) => t.to)]);
  for (const s of ORDER_STATES) { assert.ok(reachable.has(s), `${s} is reachable`); assert.ok(label(s)); }
});
