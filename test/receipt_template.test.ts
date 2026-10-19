import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { all, get, AppError } from '../src/store/db.ts';
import { buildReceipt, sampleReceiptData } from '../src/services/printing/receipt.ts';
import { parseTemplate } from '../src/services/printing/receiptTemplate.ts';
import type { ReceiptTemplate } from '../src/services/printing/receiptTemplate.ts';
import { clearReceiptDesign, getReceiptDesign, previewReceiptDesign, setReceiptDesign } from '../src/services/printing/receiptDesign.ts';
import { createPrinter, receiptPreview, sampleReceipt } from '../src/services/printing/jobs.ts';
import { parseEscPos } from '../src/services/printing/virtual.ts';
import { allSettings } from '../src/services/settings.ts';
import { makeEnv, quickBill, rid, startShift } from './helpers.ts';

const DIR = join(import.meta.dirname, '..', 'templates', 'receipt');
const file = (name: string) => readFileSync(join(DIR, name), 'utf8');
const OUTLET = { name: 'Demo Burger House', address: '12 MG Road', gstin: '29ABCDE1234F1Z5', fssaiNo: '11223344556677', phone: '9876543210' };
const ok = (text: string): ReceiptTemplate => { const r = parseTemplate(text); assert.ok(r.ok, r.ok ? '' : r.errors.join(' | ')); return (r as { template: ReceiptTemplate }).template; };
const errorsOf = (t: unknown) => { const r = parseTemplate(typeof t === 'string' ? t : JSON.stringify(t)); assert.equal(r.ok, false); return (r as { errors: string[] }).errors.join(' | '); };
const render = (t: ReceiptTemplate, cols = 48, extra: Partial<Parameters<typeof buildReceipt>[1]> = {}, data = sampleReceiptData(OUTLET, Date.parse('2026-10-15T14:13:00Z'))) =>
  parseEscPos(buildReceipt(data, { cols, copyNo: 1, footer: 'Thank you!', drawer: false, template: t, ...extra }));
const code = (fn: () => unknown): string => { try { fn(); } catch (e) { if (e instanceof AppError) return e.code; throw e; } return 'NO_ERROR'; };

/** The smallest design a GST bill allows. */
const MINIMAL = { format: 'tiffin-receipt', version: 1, name: 'Minimal', blocks: [
  { type: 'text', text: '{{outlet.name}} GSTIN {{outlet.gstin}}' }, { type: 'doc-title' },
  { type: 'field', label: 'No', value: '{{invoice.no}}' }, { type: 'field', label: 'Date', value: '{{invoice.date}}' },
  { type: 'items', columns: [{ field: 'name', width: '*' }, { field: 'amount' }] }, { type: 'totals', rows: ['gst'] }, { type: 'grand-total' },
] };

test('every example design in templates/receipt is valid and fits 58 and 80 mm paper', () => {
  const names = readdirSync(DIR).filter((f) => f.endsWith('.tiffinreceipt'));
  assert.ok(names.length >= 3);
  for (const n of names) {
    const t = ok(file(n));
    for (const cols of [32, 48]) {
      const p = render(t, cols, { sample: true });
      for (const l of p.lines) assert.ok(l.length <= cols, `${n} at ${cols}: "${l}" is ${l.length} characters`);
      assert.equal(p.cuts, 1, `${n}: always cut`);
      assert.ok(p.text.includes('SAMPLE') && p.text.includes('TAX INVOICE') === false, `${n}: a sample is never titled TAX INVOICE`);
    }
  }
});

test('the standard design file prints the same information as the built-in layout', () => {
  const t = ok(file('standard.tiffinreceipt'));
  const data = sampleReceiptData(OUTLET, Date.parse('2026-10-15T14:13:00Z'));
  data.invoice.invoiceNo = 'A1/26-27/000007';
  const p = render(t, 48, { sample: false }, data);
  for (const s of ['Demo Burger House', 'GSTIN: 29ABCDE1234F1Z5', 'FSSAI: 11223344556677', 'TAX INVOICE', 'A1/26-27/000007', '15-10-2026 19:43',
    'Sample item with a longer', 'CGST @2.5%', 'SGST @9%', 'TOTAL', '470.00', 'Tendered', '30.00', 'Thank you!']) assert.ok(p.text.includes(s), s);
  assert.ok(!p.text.includes('Against:') && !p.text.includes('Buyer GSTIN'), 'empty fields are left out');
});

test('a design file is checked: wrong files, typos, unknown placeholders and missing GST bill parts are refused in plain words', () => {
  assert.match(errorsOf('not json'), /not valid JSON/);
  assert.match(errorsOf({ format: 'other' }), /not a receipt design file/);
  assert.match(errorsOf({ ...MINIMAL, version: 2 }), /version 2.*version 1/);
  assert.match(errorsOf({ ...MINIMAL, colour: 'red' }), /Unknown setting "colour"/);
  assert.match(errorsOf({ ...MINIMAL, blocks: [...MINIMAL.blocks, { type: 'picture' }] }), /Block 8: unknown block type "picture"/);
  assert.match(errorsOf({ ...MINIMAL, blocks: [...MINIMAL.blocks, { type: 'text', text: 'x', allign: 'center' }] }), /unknown setting "allign"/);
  assert.match(errorsOf({ ...MINIMAL, blocks: [...MINIMAL.blocks, { type: 'text', text: 'Hi {{customer.email}}' }] }), /unknown placeholder \{\{customer.email\}\}/);
  assert.match(errorsOf({ ...MINIMAL, money: { symbol: '$' } }), /"money" may only have "symbol"/);
  assert.equal(parseTemplate(JSON.stringify({ ...MINIMAL, money: { symbol: '₹' } })).ok, true, 'the rupee sign prints as a picture now');
  assert.match(errorsOf({ ...MINIMAL, blocks: [...MINIMAL.blocks, { type: 'items', columns: [{ field: 'name', width: '*' }, { field: 'qty', width: '*' }, { field: 'amount' }] }] }), /only one column can have width "\*"/);
  assert.match(errorsOf({ ...MINIMAL, blocks: [...MINIMAL.blocks, { type: 'items', columns: [{ field: 'name' }] }] }), /must show the item "name" and its "amount"/);
  assert.match(errorsOf('x'.repeat(70_000)), /too large/);
  // GST bill parts
  const without = (type: string) => errorsOf({ ...MINIMAL, blocks: MINIMAL.blocks.filter((b) => b.type !== type) });
  assert.match(without('doc-title'), /doc-title/);
  assert.match(without('items'), /"items" block/);
  assert.match(without('totals'), /GST amounts/);
  assert.match(without('grand-total'), /grand-total/);
  assert.match(without('field'), /bill number.*the date/);
  assert.match(errorsOf({ ...MINIMAL, blocks: MINIMAL.blocks.map((b) => (b.type === 'text' ? { type: 'text', text: '{{outlet.name}}' } : b)) }), /GSTIN/);
  ok(JSON.stringify(MINIMAL));
});

test('safety marks are always printed by doc-title; refunds and cancelled bills never show a UPI payment code', () => {
  const t = ok(file('restaurant-gst-table.tiffinreceipt'));
  const data = () => sampleReceiptData(OUTLET, Date.now());
  assert.match(render(t, 48, { copyNo: 2, sample: false }, data()).text, /DUPLICATE/);
  const cancelled = data(); cancelled.invoice.status = 'CANCELLED';
  const c = render(t, 48, { sample: false, upiId: 'shop@upi' }, cancelled);
  assert.match(c.text, /CANCELLED/);
  assert.equal(c.qrs.length, 0);
  const refund = data(); refund.invoice.docType = 'CREDIT_NOTE'; refund.invoice.originalInvoiceNo = 'A1/26-27/000001';
  const r = render(t, 48, { sample: false, upiId: 'shop@upi' }, refund);
  assert.match(r.text, /CREDIT NOTE/);
  assert.match(r.text, /REFUND AMOUNT/);
  assert.match(r.text, /Original bill\s+A1\/26-27\/000001/);
  assert.equal(r.qrs.length, 0);
  const paid = render(t, 48, { sample: false, upiId: 'shop@upi' }, data());
  assert.deepEqual(paid.qrs, [`upi://pay?pa=shop%40upi&pn=Demo%20Burger%20House&am=470.00&cu=INR&tn=SAMPLE`]);
  assert.equal(render(t, 48, { sample: false }, data()).qrs.length, 0, 'no UPI id set: no code');
});

test('item tables always fit: the name wraps inside its column, and very narrow paper switches to two lines per item', () => {
  const wide = { ...MINIMAL, blocks: MINIMAL.blocks.map((b) => (b.type === 'items' ? { type: 'items', columns: [{ field: 'sno' }, { field: 'name', width: '*' }, { field: 'hsn' }, { field: 'gst' }, { field: 'qty' }, { field: 'rate' }, { field: 'amount' }] } : b)) };
  const t = ok(JSON.stringify(wide));
  const p80 = render(t, 48);
  const row = p80.lines.find((l) => l.startsWith('2 Sample item'))!;
  assert.match(row, /^2 Sample item.*996331\s+18%\s+1\s+150\.00\s+150\.00$/);
  assert.ok(p80.lines.includes('  a longer name'), 'continuation is indented under the name');
  const p58 = render(t, 32);
  assert.ok(p58.lines.includes('Sample item with a longer name'), 'stacked: the name has its own line');
  assert.ok(p58.lines.some((l) => /996331\s+18%\s+1\s+150\.00\s+150\.00$/.test(l)));
  for (const l of p58.lines) assert.ok(l.length <= 32);
});

test('shop design: owner uploads after a preview; bills, reprints, the screen receipt and the sample use it; back to standard', () => {
  const env = makeEnv(); try {
    const design = file('restaurant-gst-table.tiffinreceipt');
    createPrinter(env.ctx, env.manager, rid(), { name: 'Counter', transport: 'memory', isReceipt: true });

    // preview checks the file and shows the sample, without saving
    const pv = previewReceiptDesign(env.ctx, env.owner, { fileName: 'shop.tiffinreceipt', content: design, widthMm: 80 });
    assert.equal(pv.name, 'Restaurant with GST table');
    assert.ok(pv.lines.some((l) => l.includes('NET PAYABLE')));
    assert.equal(getReceiptDesign(env.ctx, env.manager).active, null);
    // refused: wrong extension, broken file, not the owner
    assert.equal(code(() => previewReceiptDesign(env.ctx, env.owner, { fileName: 'shop.json', content: design, widthMm: 80 })), 'VALIDATION');
    try { setReceiptDesign(env.ctx, env.owner, rid(), { fileName: 'bad.tiffinreceipt', content: '{"format":"tiffin-receipt","version":1,"name":"x","blocks":[{"type":"doc-title"}]}' }); assert.fail(); }
    catch (e) { assert.ok(e instanceof AppError && e.code === 'VALIDATION'); assert.match((e.details as { errors: string[] }).errors.join(' '), /A GST bill must show/); }
    assert.equal(code(() => setReceiptDesign(env.ctx, env.manager, rid(), { fileName: 'shop.tiffinreceipt', content: design })), 'FORBIDDEN');

    const saved = setReceiptDesign(env.ctx, env.owner, rid(), { fileName: 'C:\\Users\\shop\\Downloads\\shop.tiffinreceipt', content: design });
    assert.deepEqual([saved.active.name, saved.active.fileName], ['Restaurant with GST table', 'shop.tiffinreceipt']);
    assert.equal(getReceiptDesign(env.ctx, env.manager).active!.name, 'Restaurant with GST table');
    assert.ok(!Object.keys(allSettings(env.ctx)).some((k) => k.startsWith('receipt_template')), 'not mixed into the plain settings');

    startShift(env, 50000);
    const bill = quickBill(env, [['Cheese Burger', 2000]]);
    const job = get<{ payload: Uint8Array }>(env.ctx.db, "SELECT payload FROM print_job WHERE kind = 'RECEIPT' AND ref_id = ?", bill.invoice.id)!;
    const printed = parseEscPos(job.payload).text;
    assert.match(printed, /NET PAYABLE/);
    assert.match(printed, new RegExp(bill.invoice.invoiceNo));
    assert.ok(receiptPreview(env.ctx, bill.invoice.id, 80).lines.some((l) => l.includes('NET PAYABLE')), 'screen receipt');
    assert.ok(sampleReceipt(env.ctx, 58).lines.some((l) => l.includes('NET PAYABLE')), 'settings sample');
    assert.ok(all(env.ctx.db, "SELECT 1 FROM audit_log WHERE action = 'receipt.design.set'").length === 1);

    clearReceiptDesign(env.ctx, env.owner, rid());
    assert.equal(getReceiptDesign(env.ctx, env.manager).active, null);
    assert.ok(!sampleReceipt(env.ctx, 80).lines.some((l) => l.includes('NET PAYABLE')), 'standard layout again');
  } finally { env.cleanup(); }
});

test('npm run receipt: shows a design on sample paper, and lists the problems of a broken file', () => {
  const script = join(import.meta.dirname, '..', 'scripts', 'receipt.ts');
  const out = execFileSync(process.execPath, [script, join(DIR, 'compact-58mm.tiffinreceipt'), '--width', '58'], { encoding: 'utf8' });
  assert.match(out, /"Compact \(58 mm\)" is valid/);
  assert.match(out, /\|TOTAL\s+470\.00\|/);
  let failed = '';
  try { execFileSync(process.execPath, [script, join(import.meta.dirname, 'helpers.ts')], { encoding: 'utf8', stdio: 'pipe' }); } catch (e) { failed = String((e as { stderr: string }).stderr); }
  assert.match(failed, /cannot be used:\s+- This is not a receipt design file/);
});

test('the default bill design is the Classic file, and its header row falls back to label lines on 58 mm paper', async () => {
  const { DEFAULT_TEMPLATE } = await import('../src/services/printing/defaultTemplate.ts');
  assert.deepEqual(ok(file('classic.tiffinreceipt')), DEFAULT_TEMPLATE);
  const data = sampleReceiptData(OUTLET, Date.parse('2026-10-15T14:13:00Z'));
  data.invoice.invoiceNo = 'A1/26-27/000123';
  const p80 = parseEscPos(buildReceipt(data, { cols: 48, copyNo: 1, footer: 'Get Back Joe Joe!', drawer: false }));
  const i = p80.lines.findIndex((l) => l.startsWith('Bill No'));
  assert.match(p80.lines[i]!, /^Bill No\s+Cashier\s+Token\s+Date\s+Time$/);
  assert.match(p80.lines[i + 2]!, /^A1\/26-27\/000123\s+Sample\s+42\s+15-10-2026\s+19:43$/);
  assert.ok(p80.lines.some((l) => /^Sample item\s+100\.00\s+2\.000\s+200\.00$/.test(l)));
  assert.ok(p80.lines.some((l) => /^Total Quantity\s+6\.000$/.test(l)));
  assert.ok(p80.lines.some((l) => /^Net Amount\s+470\.00$/.test(l)));
  const p58 = parseEscPos(buildReceipt(data, { cols: 32, copyNo: 1, footer: '', drawer: false }));
  for (const l of p58.lines) assert.ok(l.length <= 32, l);
  assert.ok(p58.lines.some((l) => /^Bill No\s+A1\/26-27\/000123$/.test(l)));
});
