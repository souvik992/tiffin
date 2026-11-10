import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrivals, lateOrders, prepClock } from '../ui/arrivals.ts';

test('preparation clock: counts down to the ready time, warns in the last 2 minutes, then says how late', () => {
  const eta = 1_000_000;
  assert.deepEqual(prepClock('ACCEPTED', eta, eta - 15 * 60_000), { text: 'Ready in 15:00', soon: false, late: false });
  assert.deepEqual(prepClock('PREPARING', eta, eta - 61_500), { text: 'Ready in 1:02', soon: true, late: false });
  assert.deepEqual(prepClock('PREPARING', eta, eta), { text: 'Late by 1 min', soon: false, late: true });
  assert.deepEqual(prepClock('PREPARING', eta, eta + 3 * 60_000 + 1), { text: 'Late by 4 min', soon: false, late: true });
  // no clock once it is ready, or before it has a ready time
  assert.equal(prepClock('READY', eta, eta + 60_000), null);
  assert.equal(prepClock('ACCEPTED', null, eta), null);
  assert.equal(prepClock('RECEIVED', eta, eta), null);
});

test('late orders: only accepted or preparing orders past their ready time', () => {
  const at = (id: string, state: string, etaAt: number | null) => ({ id, number: `W-${id}`, state, billInvoiceId: 'inv', order: { etaAt } });
  const late = lateOrders([at('1', 'ACCEPTED', 4000), at('2', 'PREPARING', 5000), at('3', 'PREPARING', 6000), at('4', 'READY', 1000), at('5', 'ACCEPTED', null)], 5000);
  assert.deepEqual(late.map((o) => o.id), ['1', '2']);
});

const o = (id: string, state: string, billed = false) => ({ id, number: `W-${id}`, state, billInvoiceId: billed ? `inv-${id}` : null });

test('buzzer: a new order rings whether it waits for staff or was accepted automatically; orders already there when the POS starts do not', () => {
  // the first update after the POS starts: nothing counts as new (the waiting ones ring through the waiting list)
  const first = arrivals(null, [o('1', 'ACCEPTED', true), o('2', 'RECEIVED')]);
  assert.deepEqual(first.arrived, []);
  // a new order accepted automatically before the feed even showed it waiting
  const next = arrivals(first.ids, [o('1', 'ACCEPTED', true), o('2', 'RECEIVED'), o('3', 'ACCEPTED', true)]);
  assert.deepEqual(next.arrived.map((x) => x.id), ['3']);
  assert.deepEqual(next.autoAccepted.map((x) => x.number), ['W-3']);
  // a new order waiting for staff: it arrives, but rings through the waiting list (not as accepted automatically)
  const waiting = arrivals(next.ids, [o('1', 'ACCEPTED', true), o('2', 'RECEIVED'), o('3', 'ACCEPTED', true), o('4', 'SENT_TO_STORE')]);
  assert.deepEqual(waiting.arrived.map((x) => x.id), ['4']);
  assert.deepEqual(waiting.autoAccepted, []);
  // an order that is already finished when it first shows (cancelled at once) does not ring
  assert.deepEqual(arrivals(waiting.ids, [o('5', 'CANCELLED')]).arrived, []);
});
