import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatPaise, formatPrice, formatQty, formatRateBp, formatStockQty, paiseToInput, parsePercentBp, parseQty, parseRupees } from '../src/lib/money.ts';

test('formatting paise for display', () => {
  assert.equal(formatPaise(23200), '₹232.00');
  assert.equal(formatPaise(-20), '-₹0.20');
  assert.equal(formatPaise(12345678), '₹1,23,456.78'); // Indian grouping
  assert.equal(formatPrice(12900), '₹129');
  assert.equal(formatPrice(12950), '₹129.50');
  assert.throws(() => formatPaise(1.5), RangeError);
});

test('typed rupees become integer paise without floating point; bad input is refused', () => {
  assert.equal(parseRupees('129'), 12900);
  assert.equal(parseRupees(' 129.5 '), 12950);
  assert.equal(parseRupees('0.07'), 7);
  assert.equal(parseRupees('1,299.99'), 129999);
  assert.equal(parseRupees('0.29'), 29); // 0.29 * 100 is 28.999... in floating point
  for (const bad of ['', '.5', '1.234', '-5', '1e3', 'abc', '12.']) assert.equal(parseRupees(bad), null, bad);
});

test('percent input becomes basis points, capped at 100%', () => {
  assert.equal(parsePercentBp('10'), 1000);
  assert.equal(parsePercentBp('12.5'), 1250);
  assert.equal(parsePercentBp('100'), 10000);
  assert.equal(parsePercentBp('100.01'), null);
  assert.equal(parsePercentBp('x'), null);
  assert.equal(formatRateBp(500), '5%');
  assert.equal(formatRateBp(250), '2.5%');
  assert.equal(formatRateBp(1205), '12.05%');
  assert.equal(formatQty(2000), '2');
  assert.equal(formatQty(1500), '1.5');
});

test('stock quantities: typed amounts become thousandths without floats; display keeps the unit', () => {
  assert.equal(parseQty('1.5'), 1500);
  assert.equal(parseQty('0.125'), 125);
  assert.equal(parseQty(' 24 '), 24000);
  assert.equal(parseQty('0.3'), 300); // 0.3 * 1000 is 300.00000000000006 in floating point
  for (const bad of ['', '1.2345', '-1', 'a', '.5']) assert.equal(parseQty(bad), null, bad);
  assert.equal(formatStockQty(4600, 'kg'), '4.6 kg');
  assert.equal(formatStockQty(-3000, 'pcs'), '-3 pcs');
  assert.equal(formatStockQty(250, 'l'), '0.25 L');
});

test('editing a price shows exactly what was saved', () => {
  for (const p of [12900, 4950, 5, 0, 100000001]) assert.equal(parseRupees(paiseToInput(p)), p);
  assert.equal(paiseToInput(4950), '49.50');
  assert.equal(paiseToInput(12900), '129');
});

test('photos: resized to fit 1024 px without stretching or enlarging, saved at high quality; base64 matches Node', async () => {
  const { fitWithin, toBase64, PHOTO_QUALITY, sizeText } = await import('../src/lib/photo.ts');
  assert.deepEqual(fitWithin(4000, 3000), { w: 1024, h: 768 });
  assert.deepEqual(fitWithin(1080, 1920), { w: 576, h: 1024 });
  assert.deepEqual(fitWithin(300, 200), { w: 300, h: 200 }); // small photos are not enlarged
  assert.deepEqual(fitWithin(10000, 1), { w: 1024, h: 1 });
  assert.ok(PHOTO_QUALITY >= 0.9, 'measured: 90% keeps photos visually the same (docs/DECISIONS.md)');
  assert.equal(sizeText(48_000), '47 KB');
  assert.equal(sizeText(3_400_000), '3.2 MB');
  const bytes = Uint8Array.from({ length: 70_000 }, (_, i) => (i * 31) % 256); // larger than one 32 KB chunk
  assert.equal(toBase64(bytes), Buffer.from(bytes).toString('base64'));
});
