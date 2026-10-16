import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SERVICEABILITY, checkServiceability, distanceKm, isOpen, quote } from '../contract/src/serviceability.ts';
import type { ServiceabilityConfig } from '../contract/src/serviceability.ts';

const STORE = { lat: 13.0213, lng: 77.6460, label: 'Kalyan Nagar, Bengaluru' };
const CFG: ServiceabilityConfig = { ...DEFAULT_SERVICEABILITY, location: STORE, packagingFee: 1000 };
const errs = (c: unknown) => { const r = checkServiceability(c); assert.equal(r.ok, false); return (r as { errors: Record<string, string> }).errors; };
/** IST wall time on a known date: 2026-10-12 is a Monday. */
const ist = (day: number, hhmm: string) => Date.parse(`2026-10-${String(11 + day).padStart(2, '0')}T${hhmm}:00+05:30`);

test('serviceability: distance bands, minimum order, free delivery above, packaging fee and pickup', () => {
  const near = { lat: 13.0300, lng: 77.6460 }; // about 1 km north
  const mid = { lat: 13.0650, lng: 77.6460 }; // about 4.9 km
  const far = { lat: 13.1200, lng: 77.6460 }; // about 11 km
  assert.ok(Math.abs(distanceKm(STORE, near) - 1) < 0.1);
  assert.deepEqual(quote(CFG, { fulfilment: 'DELIVERY', to: near, itemsTotal: 30000 }), { ok: true, fulfilment: 'DELIVERY', distanceKm: 1, zone: 0, deliveryFee: 2000, packagingFee: 1000, minOrder: 10000, etaMinutes: 30 });
  assert.equal((quote(CFG, { fulfilment: 'DELIVERY', to: near, itemsTotal: 50000 }) as { deliveryFee: number }).deliveryFee, 0); // free above Rs 500
  assert.deepEqual(quote(CFG, { fulfilment: 'DELIVERY', to: near, itemsTotal: 8000 }), { ok: false, reason: 'BELOW_MINIMUM', minOrder: 10000, shortBy: 2000 });
  const q2 = quote(CFG, { fulfilment: 'DELIVERY', to: mid, itemsTotal: 25000 });
  assert.ok(q2.ok && q2.zone === 1 && q2.deliveryFee === 4000 && q2.etaMinutes === 45);
  assert.deepEqual(quote(CFG, { fulfilment: 'DELIVERY', to: far, itemsTotal: 99999 }), { ok: false, reason: 'OUT_OF_AREA', maxKm: 6 });
  assert.deepEqual(quote({ ...CFG, location: null }, { fulfilment: 'DELIVERY', to: near, itemsTotal: 30000 }), { ok: false, reason: 'NO_LOCATION' });
  assert.deepEqual(quote({ ...CFG, zones: [] }, { fulfilment: 'DELIVERY', to: near, itemsTotal: 30000 }), { ok: false, reason: 'NO_DELIVERY' });
  assert.deepEqual(quote(CFG, { fulfilment: 'PICKUP', itemsTotal: 100 }), { ok: true, fulfilment: 'PICKUP', distanceKm: null, zone: null, deliveryFee: 0, packagingFee: 1000, minOrder: 0, etaMinutes: 20 });
});

test('serviceability: opening hours in IST, two slots a day, and slots past midnight', () => {
  const hours = { ...DEFAULT_SERVICEABILITY.hours, 1: [{ open: '11:00', close: '15:00' }, { open: '18:00', close: '01:00' }], 2: [] };
  assert.equal(isOpen(hours, ist(1, '10:59')), false);
  assert.equal(isOpen(hours, ist(1, '11:00')), true);
  assert.equal(isOpen(hours, ist(1, '15:00')), false); // closes at 15:00
  assert.equal(isOpen(hours, ist(1, '23:30')), true);
  assert.equal(isOpen(hours, ist(2, '00:30')), true); // Monday's late slot runs into Tuesday, which is otherwise closed
  assert.equal(isOpen(hours, ist(2, '01:00')), false);
  assert.equal(isOpen(hours, ist(2, '12:00')), false);
});

test('serviceability: the configuration is checked in plain words', () => {
  assert.ok(checkServiceability(CFG).ok);
  assert.ok(checkServiceability(DEFAULT_SERVICEABILITY).ok); // no location yet is allowed (delivery stays off)
  assert.match(errs({ ...CFG, location: { lat: 51.5, lng: -0.1, label: 'London' } }).location!, /India/);
  assert.match(errs({ ...CFG, zones: [{ ...CFG.zones[0]!, upToKm: 5 }, { ...CFG.zones[1]!, upToKm: 4 }] })['zones.1.upToKm']!, /more than 5 km/);
  assert.match(errs({ ...CFG, zones: [{ ...CFG.zones[0]!, upToKm: 30 }] })['zones.0.upToKm']!, /at most 25 km/);
  assert.match(errs({ ...CFG, zones: [{ ...CFG.zones[0]!, upToKm: 2.25 }] })['zones.0.upToKm']!, /one decimal/);
  assert.ok(errs({ ...CFG, zones: [{ ...CFG.zones[0]!, deliveryFee: 12.5 }] })['zones.0.deliveryFee']);
  assert.ok(errs({ ...CFG, zones: Array.from({ length: 7 }, (_, i) => ({ ...CFG.zones[0]!, upToKm: i + 1 })) }).zones);
  assert.ok(errs({ ...CFG, packagingFee: 60000 }).packagingFee);
  assert.match(errs({ ...CFG, hours: { ...CFG.hours, 3: [{ open: '25:00', close: '10:00' }] } })['hours.3.0']!, /times like/);
  assert.match(errs({ ...CFG, hours: { ...CFG.hours, 4: [{ open: '10:00', close: '16:00' }, { open: '15:00', close: '22:00' }] } })['hours.4']!, /overlap/);
  assert.match(errs({ ...CFG, hours: { ...CFG.hours, 5: [{ open: '09:00', close: '10:00' }, { open: '11:00', close: '12:00' }, { open: '13:00', close: '14:00' }] } })['hours.5']!, /Up to 2/);
});
