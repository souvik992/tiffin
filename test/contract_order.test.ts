import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ORDER_STATES, TERMINAL, TRANSITIONS, canTransition, label, needsRefund, nextStates } from '../contract/src/order.ts';
import type { OrderFacts, OrderState } from '../contract/src/order.ts';

const DELIVERY_COD: OrderFacts = { fulfilment: 'DELIVERY', payment: 'COD' };
const PICKUP_ONLINE: OrderFacts = { fulfilment: 'PICKUP', payment: 'ONLINE' };
const ok = (o: OrderFacts, path: OrderState[], actors: Array<'customer' | 'pos' | 'hub' | 'gateway' | 'aggregator'>) => {
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

test('order life cycle: Swiggy and Zomato (through UrbanPiper) cancel, pick up and complete their orders; the store does not deliver for them', () => {
  const PLATFORM: OrderFacts = { fulfilment: 'DELIVERY', payment: 'ONLINE', deliveredBy: 'platform' };
  const OWN_RIDER: OrderFacts = { fulfilment: 'DELIVERY', payment: 'ONLINE', deliveredBy: 'store' };
  // the platform cancels at any point until the order is finished, also before the store accepts
  for (const from of ['SENT_TO_STORE', 'RECEIVED', 'ACCEPTED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY'] as const) assert.deepEqual(canTransition(PLATFORM, from, 'CANCELLED', 'aggregator'), { ok: true }, from);
  assert.equal(canTransition(PLATFORM, 'DELIVERED', 'CANCELLED', 'aggregator').ok, false);
  // its rider picks the food up and delivers it; the store cannot mark those steps itself
  ok(PLATFORM, ['SENT_TO_STORE', 'ACCEPTED', 'READY'], ['pos', 'pos']);
  assert.deepEqual(canTransition(PLATFORM, 'READY', 'OUT_FOR_DELIVERY', 'aggregator'), { ok: true });
  assert.deepEqual(canTransition(PLATFORM, 'PREPARING', 'OUT_FOR_DELIVERY', 'aggregator'), { ok: true }, 'the rider may take it before "ready" was pressed');
  assert.deepEqual(canTransition(PLATFORM, 'OUT_FOR_DELIVERY', 'DELIVERED', 'aggregator'), { ok: true });
  assert.equal(canTransition(PLATFORM, 'READY', 'OUT_FOR_DELIVERY', 'pos').ok, false);
  assert.equal(canTransition(PLATFORM, 'OUT_FOR_DELIVERY', 'DELIVERED', 'pos').ok, false);
  assert.deepEqual(nextStates(PLATFORM, 'READY', 'pos'), ['CANCELLED']);
  // the store's own rider (self-delivery on the platform): the store delivers as usual
  ok(OWN_RIDER, ['ACCEPTED', 'READY', 'OUT_FOR_DELIVERY', 'DELIVERED'], ['pos', 'pos', 'pos']);
  // a pickup order collected: the platform completes it
  assert.deepEqual(canTransition({ fulfilment: 'PICKUP', payment: 'ONLINE', deliveredBy: 'platform' }, 'READY', 'PICKED_UP', 'aggregator'), { ok: true });
  // the platform never accepts or rejects for the store
  assert.equal(canTransition(PLATFORM, 'RECEIVED', 'ACCEPTED', 'aggregator').ok, false);
  // a customer cancelling before acceptance still works for the store's own app and website
  assert.deepEqual(canTransition(DELIVERY_COD, 'RECEIVED', 'CANCELLED', 'customer'), { ok: true });
  assert.match((canTransition(DELIVERY_COD, 'RECEIVED', 'CANCELLED', 'pos') as { reason: string }).reason, /Only customer or aggregator/);
});
