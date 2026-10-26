import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseKotTemplate, renderKot, sampleKot } from '../src/services/printing/kotTemplate.ts';
import type { KotTicket } from '../src/services/printing/kotTemplate.ts';
import { DEFAULT_KOT_TEMPLATES } from '../src/services/printing/defaultKotTemplates.ts';
import { parseEscPos } from '../src/services/printing/virtual.ts';

const lines = (bytes: Uint8Array) => parseEscPos(bytes, { widen: false }).lines.map((l) => l.trimEnd());
const ticket = (o: Partial<KotTicket> = {}): KotTicket => ({ ...sampleKot(Date.parse('2026-10-11T13:20:00+05:30')), ...o });

test('KOT designs: the standard customer KOT prints like the shop\'s ticket (token and station, order, items with notes, totals, END)', () => {
  const t = DEFAULT_KOT_TEMPLATES.customer;
  const out = lines(renderKot(t, ticket(), { cols: 32 }));
  const text = out.join('\n');
  assert.ok(out.some((l) => l.trim() === 'Spice Route Kitchen'), text);
  assert.ok(out.some((l) => l.trim() === 'KITCHEN ORDER TICKET'));
  assert.ok(out.some((l) => l.trim() === 'TOKEN'));
  assert.ok(out.some((l) => l.includes('113 | TANDOOR')), 'token and station, big');
  assert.ok(out.some((l) => l.trim() === 'COUNTER'), 'where the order came from');
  assert.match(lines(renderKot(t, ticket(), { cols: 48 })).join('\n'), /Order: A1\/26-27\/000029 +11 Oct, 01:20 PM/, 'one line on 80 mm paper');
  assert.match(text, /Order: A1\/26-27\/000029\n +11 Oct, 01:20 PM/, 'two lines on 58 mm paper');
  assert.ok(out.some((l) => l.trim() === '4 x Tandoori Roti'));
  assert.ok(out.some((l) => l.trim() === '>> Less spicy'), 'notes under the item');
  assert.match(text, /Items: 3 +Qty: 6/);
  assert.ok(out.some((l) => l.trim() === '** END **'));
  for (const slot of ['station', 'online'] as const) assert.ok(lines(renderKot(DEFAULT_KOT_TEMPLATES[slot], ticket(), { cols: 48 })).some((l) => l.includes('Tandoori Roti')), slot);
});

test('KOT designs: reprints, add-on tickets and cancelled items are always marked, whatever the design', () => {
  const plain = parseKotTemplate(JSON.stringify({ format: 'tiffin-kot', version: 1, name: 'Bare', blocks: [{ type: 'items' }] }));
  assert.ok(plain.ok, JSON.stringify(plain));
  if (!plain.ok) return;
  const text = lines(renderKot(plain.template, ticket({ reprint: true, kotNo: 2, lines: [{ name: 'Paneer Tikka', qtyMilli: 1000, modifiers: [], note: null, cancel: true }] }), { cols: 32 })).join('\n');
  assert.match(text, /\*\*\* REPRINT \*\*\*/);
  assert.match(text, /ADD-ON KOT 2/);
  assert.match(text, /CANCEL 1 x Paneer Tikka/);
});

test('KOT designs: wrong files are refused with reasons; empty placeholders drop their line', () => {
  const bad = parseKotTemplate(JSON.stringify({ format: 'tiffin-kot', version: 1, name: 'X', blocks: [{ type: 'text', text: '{{invoice.total}}', allign: 'center' }] }));
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    const all = bad.errors.join(' ');
    assert.match(all, /unknown placeholder \{\{invoice.total\}\}/);
    assert.match(all, /unknown setting "allign"/);
    assert.match(all, /"items" block/);
  }
  assert.equal(parseKotTemplate('not json').ok, false);
  assert.equal(parseKotTemplate(JSON.stringify({ format: 'tiffin-receipt', version: 1, name: 'X', blocks: [] })).ok, false);
  // no order number yet (a KOT sent from the cart before billing): the date prints alone
  const out = lines(renderKot(DEFAULT_KOT_TEMPLATES.customer, ticket({ orderNo: null, station: null }), { cols: 32 }));
  assert.ok(!out.some((l) => l.includes('Order:')));
  assert.ok(out.some((l) => l.trim() === '11 Oct, 01:20 PM'));
  assert.ok(out.some((l) => l.trim() === '113'), 'token alone without a station');
});

test('KOT designs: the example files in templates/kot are valid', () => {
  const dir = join(import.meta.dirname, '..', 'templates', 'kot');
  const files = readdirSync(dir).filter((f) => f.endsWith('.tiffinkot'));
  assert.ok(files.length >= 3);
  for (const f of files) { const r = parseKotTemplate(readFileSync(join(dir, f), 'utf8')); assert.ok(r.ok, `${f}: ${r.ok ? '' : r.errors.join('; ')}`); }
  // the standard designs are the files
  for (const slot of ['customer', 'station', 'online'] as const) assert.deepEqual(JSON.parse(readFileSync(join(dir, `${slot}.tiffinkot`), 'utf8')), DEFAULT_KOT_TEMPLATES[slot]);
});
