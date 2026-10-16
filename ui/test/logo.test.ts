import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitLogo, toBase64, toMono, trimRows } from '../src/lib/logo.ts';

const px = (w: number, h: number, f: (x: number, y: number) => [number, number, number, number]) => {
  const a = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a.set(f(x, y), (y * w + x) * 4);
  return a;
};

test('logo: fits 58 mm paper, keeps its shape, widths in steps of 8', () => {
  assert.deepEqual(fitLogo(1000, 500, 384), { width: 384, height: 192 });
  assert.deepEqual(fitLogo(100, 1000, 384), { width: 24, height: 240 }); // tall: limited by height
  assert.deepEqual(fitLogo(50, 20, 384), { width: 48, height: 19 }); // never enlarged
  assert.deepEqual(fitLogo(1000, 500, 192), { width: 192, height: 96 });
});

test('logo: dark pixels print black, light and transparent ones do not; dithering makes grey into a pattern', () => {
  // left half black, right half white, bottom row transparent black
  const img = px(16, 3, (x, y) => (y === 2 ? [0, 0, 0, 0] : x < 8 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
  const m = toMono(img, 16, 3, { threshold: 128, dither: false });
  assert.deepEqual([...m.bits], [0xff, 0x00, 0xff, 0x00, 0x00, 0x00]);
  const grey = toMono(px(16, 16, () => [128, 128, 128, 255]), 16, 16, { threshold: 128, dither: true });
  const black = [...grey.bits].reduce((s, b) => s + b.toString(2).split('1').length - 1, 0);
  assert.ok(black > 100 && black < 156, `about half the dots are black (${black} of 256)`);
  assert.deepEqual([...trimRows({ width: 8, height: 12, bits: Uint8Array.from([0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]) }).bits].slice(0, 1), [1]);
  assert.equal(toBase64(Uint8Array.from([0xff, 0])), '/wA=');
});
