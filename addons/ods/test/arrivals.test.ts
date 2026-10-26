import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrivals } from '../ui/arrivals.ts';

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
