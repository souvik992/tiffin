import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulDivRound, formatINR, parsePaise, formatQty } from '../src/core/money.ts';
import { apportion, resolveDiscount } from '../src/core/discount.ts';
import { computeInvoice, checkInvariants } from '../src/core/tax.ts';
import type { TaxableLineInput } from '../src/core/tax.ts';
import { financialYear, formatDocNo, istDay } from '../src/core/numbering.ts';
import { createIdGenerator } from '../src/core/ids.ts';

const line = (o: Partial<TaxableLineInput> & { id: string }): TaxableLineInput => ({
  qtyMilli: 1000, unitPrice: 10000, rateBp: 500, cessBp: 0, priceIncludesTax: true, ...o,
});
const intra = { intraState: true, roundToRupee: true };

test('mulDivRound is half-up and BigInt-safe', () => {
  assert.equal(mulDivRound(500, 3, 1000), 2); // 1.5 -> 2
  assert.equal(mulDivRound(250, 9999, 1000), 2500); // 2499.75 -> 2500
  assert.equal(mulDivRound(1, 1, 3), 0);
  assert.equal(mulDivRound(2, 1, 3), 1);
  assert.equal(mulDivRound(9_000_000_000, 9_000_000_000, 9_000_000_000), 9_000_000_000);
  assert.throws(() => mulDivRound(-1, 1, 1));
  assert.throws(() => mulDivRound(1, 1, 0));
  assert.throws(() => mulDivRound(1.5, 1, 1));
});

test('formatting helpers', () => {
  assert.equal(formatINR(12345678), '\u20b91,23,456.78');
  assert.equal(formatINR(100000 * 100, ''), '1,00,000.00');
  assert.equal(formatINR(5, ''), '0.05');
  assert.equal(formatINR(-12500, ''), '-125.00');
  assert.equal(parsePaise('1,20,000.5'), 12000050);
  assert.equal(parsePaise('99'), 9900);
  assert.throws(() => parsePaise('12.345'));
  assert.equal(formatQty(1500), '1.5');
  assert.equal(formatQty(250), '0.25');
  assert.equal(formatQty(3000), '3');
});

// ---- golden GST cases (hand-checked; a CA must still validate the rules before release) ----
test('golden: inclusive 5%, single line', () => {
  const c = computeInvoice([line({ id: 'a', unitPrice: 10500 })], intra);
  assert.deepEqual([c.taxableTotal, c.cgst, c.sgst, c.igst, c.grandTotal, c.roundOff], [10000, 250, 250, 0, 10500, 0]);
});
test('golden: exclusive 18%, qty 2', () => {
  const c = computeInvoice([line({ id: 'a', qtyMilli: 2000, rateBp: 1800, priceIncludesTax: false })], intra);
  assert.deepEqual([c.taxableTotal, c.cgst, c.sgst, c.grandTotal], [20000, 1800, 1800, 23600]);
});
test('golden: odd paisa goes to CGST (intra) or IGST (inter)', () => {
  const l = line({ id: 'a', unitPrice: 3000 }); // taxable 2857, tax 143
  const a = computeInvoice([l], { intraState: true, roundToRupee: false });
  assert.deepEqual([a.taxableTotal, a.cgst, a.sgst, a.igst], [2857, 72, 71, 0]);
  const b = computeInvoice([l], { intraState: false, roundToRupee: false });
  assert.deepEqual([b.taxableTotal, b.cgst, b.sgst, b.igst], [2857, 0, 0, 143]);
});
test('golden: bill discount apportioned by largest remainder, then round-off', () => {
  const c = computeInvoice(
    [line({ id: 'a', unitPrice: 10000, priceIncludesTax: false }), line({ id: 'b', unitPrice: 20000, priceIncludesTax: false })],
    { billDiscount: { type: 'amount', value: 1000 }, intraState: true, roundToRupee: true },
  );
  assert.deepEqual(c.lines.map((l) => l.discount), [333, 667]);
  assert.deepEqual(c.lines.map((l) => l.taxable), [9667, 19333]);
  assert.deepEqual(c.lines.map((l) => [l.cgst, l.sgst]), [[242, 241], [484, 483]]);
  assert.deepEqual([c.taxableTotal, c.discountTotal, c.roundOff, c.grandTotal], [29000, 1000, 50, 30500]);
});
test('golden: cess exclusive and inclusive agree', () => {
  const ex = computeInvoice([line({ id: 'a', rateBp: 2800, cessBp: 1200, priceIncludesTax: false })], intra);
  assert.deepEqual([ex.cgst, ex.sgst, ex.cess, ex.grandTotal], [1400, 1400, 1200, 14000]);
  const inc = computeInvoice([line({ id: 'a', unitPrice: 14000, rateBp: 2800, cessBp: 1200 })], intra);
  assert.deepEqual([inc.taxableTotal, inc.cgst, inc.sgst, inc.cess, inc.grandTotal], [10000, 1400, 1400, 1200, 14000]);
});
test('golden: loose quantity (1.5 kg) at 0% tax', () => {
  const c = computeInvoice([line({ id: 'a', qtyMilli: 1500, unitPrice: 8000, rateBp: 0 })], intra);
  assert.deepEqual([c.grossTotal, c.taxableTotal, c.grandTotal], [12000, 12000, 12000]);
});
test('golden: 100% line discount gives zero bill', () => {
  const c = computeInvoice([line({ id: 'a', unitPrice: 5000, discount: { type: 'percent', value: 10000 } })], intra);
  assert.deepEqual([c.discountTotal, c.taxableTotal, c.grandTotal], [5000, 0, 0]);
});
test('golden: mixed rates in one bill', () => {
  const c = computeInvoice(
    [line({ id: 'a', unitPrice: 10000, rateBp: 0 }), line({ id: 'b', unitPrice: 10500, rateBp: 500 }), line({ id: 'c', unitPrice: 11200, rateBp: 1200 }), line({ id: 'd', unitPrice: 11800, rateBp: 1800 })],
    intra,
  );
  assert.deepEqual(c.lines.map((l) => l.taxable), [10000, 10000, 10000, 10000]);
  assert.deepEqual([c.cgst + c.sgst, c.grandTotal], [500 + 1200 + 1800, 43500]);
});
test('golden: percent line discount 10% inclusive 5%', () => {
  const c = computeInvoice([line({ id: 'a', unitPrice: 21000, discount: { type: 'percent', value: 1000 } })], { intraState: true, roundToRupee: false });
  // gross 21000, discount 2100, net 18900, taxable 18000, tax 900
  assert.deepEqual([c.discountTotal, c.taxableTotal, c.cgst, c.sgst, c.grandTotal], [2100, 18000, 450, 450, 18900]);
});
test('golden: 1,000-line cart at very high prices does not overflow', () => {
  const lines = Array.from({ length: 1000 }, (_, i) => line({ id: `l${i}`, unitPrice: 99_999_999, rateBp: 1800, priceIncludesTax: false }));
  const c = computeInvoice(lines, { intraState: true, roundToRupee: true });
  assert.equal(c.taxableTotal, 99_999_999_000);
  assert.equal(c.cgst + c.sgst, 18_000_000_000);
  assert.deepEqual(checkInvariants(c), []);
});
test('discount errors', () => {
  assert.throws(() => resolveDiscount({ type: 'amount', value: 101 }, 100));
  assert.throws(() => resolveDiscount({ type: 'percent', value: 10001 }, 100));
  assert.throws(() => computeInvoice([line({ id: 'a', qtyMilli: 0 })], intra));
});

// ---- deterministic randomized invariant tests ----
function lcg(seed: number) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }

test('property: apportion sums exactly and never exceeds weights', () => {
  const r = lcg(42);
  for (let n = 0; n < 3000; n++) {
    const k = 1 + Math.floor(r() * 12);
    const w = Array.from({ length: k }, () => Math.floor(r() * 100000));
    const W = w.reduce((a, b) => a + b, 0);
    if (W === 0) continue;
    const total = Math.floor(r() * (W + 1));
    const out = apportion(total, w);
    assert.equal(out.reduce((a, b) => a + b, 0), total);
    out.forEach((v, i) => assert.ok(v >= 0 && v <= w[i]!));
  }
});

test('property: 5,000 random invoices satisfy every invariant', () => {
  const r = lcg(7);
  const rates = [0, 250, 500, 1200, 1800, 2800];
  for (let n = 0; n < 5000; n++) {
    const k = 1 + Math.floor(r() * 25);
    const lines = Array.from({ length: k }, (_, i) => {
      const hasDisc = r() < 0.3;
      return line({
        id: `l${i}`,
        qtyMilli: 1 + Math.floor(r() * 20000),
        unitPrice: Math.floor(r() * 500000),
        rateBp: rates[Math.floor(r() * rates.length)]!,
        cessBp: r() < 0.1 ? 1200 : 0,
        priceIncludesTax: r() < 0.6,
        discount: hasDisc ? (r() < 0.5 ? { type: 'percent' as const, value: Math.floor(r() * 10001) } : { type: 'amount' as const, value: 0 }) : null,
      });
    });
    const billDiscount = r() < 0.4 ? { type: 'percent' as const, value: Math.floor(r() * 10001) } : null;
    const c = computeInvoice(lines, { billDiscount, intraState: r() < 0.7, roundToRupee: r() < 0.5 });
    assert.deepEqual(checkInvariants(c), [], `case ${n}`);
    // recomputing the same input gives identical output (determinism)
    const again = computeInvoice(lines, { billDiscount, intraState: true, roundToRupee: true });
    const again2 = computeInvoice(lines, { billDiscount, intraState: true, roundToRupee: true });
    assert.deepEqual(again, again2);
  }
});

test('numbering: financial year boundary in IST', () => {
  assert.equal(financialYear(Date.UTC(2026, 2, 31, 18, 29, 59)), '25-26'); // 31 Mar 23:59:59 IST
  assert.equal(financialYear(Date.UTC(2026, 2, 31, 18, 30, 0)), '26-27'); // 1 Apr 00:00:00 IST
  assert.equal(financialYear(Date.UTC(2026, 11, 31)), '26-27');
  assert.equal(financialYear(Date.UTC(2027, 0, 1)), '26-27');
  assert.equal(istDay(Date.UTC(2026, 2, 31, 18, 30, 0)), '2026-04-01');
});
test('numbering: format and 16-character limit', () => {
  assert.equal(formatDocNo('A1', '26-27', 123), 'A1/26-27/000123');
  assert.equal(formatDocNo('A1', '26-27', 123).length, 15);
  assert.equal(formatDocNo('A1C', '26-27', 999999).length, 16);
  assert.throws(() => formatDocNo('A1CD', '26-27', 1));
  assert.throws(() => formatDocNo('A1', '26-27', 1_000_000));
  assert.throws(() => formatDocNo('A1', '26-27', 0));
});
test('uuidv7: version bits, monotonic with a frozen clock, deterministic', () => {
  const rng = (n: number) => new Uint8Array(n).fill(0xab);
  const gen = createIdGenerator({ now: () => 1_700_000_000_000 }, rng);
  const ids = Array.from({ length: 5000 }, () => gen.next());
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const sorted = [...ids].sort();
  assert.deepEqual(sorted, ids);
  assert.equal(new Set(ids).size, ids.length);
});
