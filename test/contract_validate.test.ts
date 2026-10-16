import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPlaceOrder, normaliseMobile } from '../contract/src/validate.ts';

const BASE = { fulfilment: 'PICKUP', payment: 'ONLINE', customer: { mobile: '9876543210' }, lines: [{ itemId: 'it1', qtyMilli: 2000 }], menuVersion: 3, expectedTotal: 25800 };
const errors = (o: unknown) => { const r = checkPlaceOrder(o); assert.equal(r.ok, false); return (r as { errors: Record<string, string> }).errors; };

test('placing an order: guest checkout pays online; cash on delivery needs a mobile verified by OTP', () => {
  const r = checkPlaceOrder({ ...BASE, customer: { name: '  ', mobile: '+91 98765-43210' } });
  assert.ok(r.ok);
  assert.deepEqual([r.value.customer, r.value.lines[0]!.modifierIds], [{ name: null, mobile: '9876543210' }, []]); // name optional
  assert.match(errors({ ...BASE, payment: 'COD' }).otp!, /OTP/);
  assert.ok(checkPlaceOrder({ ...BASE, payment: 'COD', otpToken: 'otp-proof' }).ok);
});

test('placing an order: delivery needs an address with a PIN code; bad mobiles, empty carts and odd values are refused in plain words', () => {
  assert.match(errors({ ...BASE, fulfilment: 'DELIVERY' }).address!, /delivery address/);
  const e = errors({ ...BASE, fulfilment: 'DELIVERY', address: { line1: '12 MG Road', city: 'Bengaluru', pincode: '56001' } });
  assert.match(e['address.pincode']!, /6-digit/);
  const ok = checkPlaceOrder({ ...BASE, fulfilment: 'DELIVERY', address: { line1: '12 MG Road', city: 'Bengaluru', pincode: '560001', landmark: ' near park ' } });
  assert.ok(ok.ok && ok.value.address!.landmark === 'near park');
  assert.match(errors({ ...BASE, customer: { mobile: '1234567890' } }).mobile!, /10-digit/); // Indian mobiles start 6-9
  assert.match(errors({ ...BASE, lines: [] }).lines!, /empty/);
  assert.ok(errors({ ...BASE, lines: [{ itemId: 'x', qtyMilli: 0.5 }] })['lines.0']);
  assert.ok(errors({ ...BASE, expectedTotal: 10.5 }).expectedTotal);
  assert.ok(errors({ ...BASE, fulfilment: 'DINE_IN' }).fulfilment);
  assert.deepEqual(Object.keys(errors(null)), ['order']);
  assert.equal(normaliseMobile('09876543210'), '9876543210');
});
