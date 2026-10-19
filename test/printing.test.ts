import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { all, get, run, AppError } from '../src/store/db.ts';
import { EscPos, wrapText, sanitize } from '../src/services/printing/escpos.ts';
import { parseEscPos } from '../src/services/printing/virtual.ts';
import { PrintQueue } from '../src/services/printing/queue.ts';
import { clearPictureCache, expandPictures, findMarkers } from '../src/services/printing/textPicture.ts';
import type { PictureSpec, TextRenderer } from '../src/services/printing/textPicture.ts';
import { MemoryTransport, TcpTransport, chunks } from '../src/services/printing/transports.ts';
import type { PrinterRow } from '../src/services/printing/transports.ts';
import { createPrinter, testPrint } from '../src/services/printing/jobs.ts';
import { addLine, createOrder } from '../src/services/orders.ts';
import { finalizeInvoice, reprintInvoice } from '../src/services/invoices.ts';
import { createItem } from '../src/services/catalog.ts';
import { makeEnv, quickBill, rid, startShift } from './helpers.ts';
import type { Env } from './helpers.ts';

const jobFor = (env: Env, invoiceId: string, kind: string, printerName: string) => {
  const j = get<{ payload: Uint8Array }>(env.ctx.db, `SELECT j.payload FROM print_job j JOIN printer p ON p.id = j.printer_id WHERE j.ref_id = ? AND j.kind = ? AND p.name = ? ORDER BY j.created_at, j.rowid LIMIT 1`, invoiceId, kind, printerName);
  assert.ok(j, `no ${kind} job for ${printerName}`);
  return parseEscPos(j.payload);
};
const code = (fn: () => unknown): string => { try { fn(); } catch (e) { if (e instanceof AppError) return e.code; throw e; } return 'NO_ERROR'; };

function mixedBill(env: Env) {
  const cart0 = createOrder(env.ctx, env.cashier, rid());
  addLine(env.ctx, env.cashier, rid(), { orderId: cart0.order.id, itemId: env.items['Cheese Burger']!, modifierIds: [env.mods['Extra cheese']!] });
  const cart = addLine(env.ctx, env.cashier, rid(), { orderId: cart0.order.id, itemId: env.items['Cola 300ml']!, qtyMilli: 2000 });
  return finalizeInvoice(env.ctx, env.cashier, rid(), { orderId: cart.order.id, payments: [{ mode: 'CASH', amount: cart.totals.grandTotal, tendered: 50000 }] });
}

test('receipt (80 mm): layout, GST lines, drawer, cut; text mode prints the rupee sign as Rs', () => {
  const env = makeEnv(); try {
    startShift(env);
    const r = mixedBill(env);
    const p = jobFor(env, r.invoice.id, 'RECEIPT', 'Counter receipt (virtual)');
    assert.ok(p.lines.every((l) => l.length <= 48), 'no line exceeds 48 columns');
    for (const must of ['Demo Burger Hub', 'GSTIN: 29ABCDE1234F1Z5', 'FSSAI: 11223344556677', 'TAX INVOICE', 'A1/26-27/000001', 'Cheese Burger', '+ Extra cheese', 'CGST @2.5%', 'SGST @2.5%', 'CGST @6%', 'SGST @6%', 'Net Amount', 'Tendered', 'Change', 'Total Quantity', 'Bill No', 'Token']) {
      assert.ok(p.text.includes(must), `receipt should contain "${must}"`);
    }
    assert.ok(!p.text.includes('\u20b9'));
    assert.equal(p.cuts, 1);
    assert.equal(p.drawerKicks, 1);   // cash payment opens the drawer
    assert.equal(p.inits, 1);
    assert.ok(!p.text.includes('DUPLICATE'));
    const total = p.lines.find((l) => l.startsWith('Net Amount'))!;
    assert.ok(total.trim().endsWith('229.00'), total); // 12900+2000 + 2x4000 = 22900
  } finally { env.cleanup(); }
});

test('receipt (58 mm): fits 32 columns; UPI-only bills do not kick the drawer', () => {
  const env = makeEnv(); try {
    createPrinter(env.ctx, env.owner, rid(), { name: 'Slim 58', transport: 'memory', widthMm: 58, isReceipt: true, drawer: true });
    startShift(env);
    const r = quickBill(env, [['Peri Peri Fries', 2000], ['Double Patty Burger']], 'UPI');
    const p = jobFor(env, r.invoice.id, 'RECEIPT', 'Slim 58');
    assert.ok(p.lines.every((l) => l.length <= 32), `max line ${Math.max(...p.lines.map((l) => l.length))}`);
    assert.equal(p.drawerKicks, 0);
    assert.ok(p.text.includes('UPI'));
  } finally { env.cleanup(); }
});

test('Hindi and the rupee sign: the bill keeps the real text (screen preview), the queue prints it as a picture, or as text when it cannot draw', async () => {
  const env = makeEnv(); try {
    startShift(env);
    const tg = get<{ id: string }>(env.ctx.db, 'SELECT id FROM tax_group WHERE rate_bp = 500')!.id;
    const id = createItem(env.ctx, env.owner, rid(), { name: '\u091a\u093e\u092f Special \u20b9', taxGroupId: tg, price: 1500 }).id;
    env.items['chai'] = id;
    const r = quickBill(env, [['chai']]);
    const p = jobFor(env, r.invoice.id, 'RECEIPT', 'Counter receipt (virtual)');
    assert.ok(p.text.includes('\u091a\u093e\u092f Special \u20b9'), 'the preview shows the real name');
    assert.ok(p.pictures >= 1);
    assert.equal(sanitize('a\u2013b \u201cq\u201d'), 'a-b "q"');

    // no renderer (a printer reached from Linux, or drawing failed): the old text, and no marker reaches the printer
    clearPictureCache();
    const mem = new MemoryTransport();
    await new PrintQueue(env.ctx, { memory: mem }).processDue();
    const sentText = mem.sent.map((s) => parseEscPos(s.bytes));
    assert.ok(sentText.some((s) => s.text.includes('??? Special Rs')));
    assert.ok(sentText.every((s) => s.pictures === 0 && findMarkers(s.lines.length ? mem.sent[0]!.bytes : new Uint8Array()).length === 0));

    // with a renderer: those lines become raster pictures, the rest stays text
    const r2 = quickBill(env, [['chai']]);
    const seen: PictureSpec[] = [];
    const fake: TextRenderer = async (specs) => { seen.push(...specs); return specs.map((s) => ({ widthBytes: s.c * 12 * s.w / 8, height: 24 * s.h, data: new Uint8Array(s.c * 12 * s.w / 8 * 24 * s.h).fill(0xff) })); };
    const mem2 = new MemoryTransport();
    await new PrintQueue(env.ctx, { memory: mem2 }, [0, 0, 0], fake).processDue();
    const receipt = mem2.sent.map((s) => parseEscPos(s.bytes)).find((s) => s.text.includes(r2.invoice.invoiceNo))!;
    assert.ok(receipt.rasters.length >= 1, 'the Hindi line is a raster image');
    assert.ok(!receipt.text.includes('???'));
    assert.ok(seen.some((s) => s.s.some((g) => g.t.includes('\u091a\u093e\u092f'))));
    // a renderer that fails never stops printing
    const r3 = quickBill(env, [['chai']]);
    clearPictureCache();
    const mem3 = new MemoryTransport();
    await new PrintQueue(env.ctx, { memory: mem3 }, [0, 0, 0], async () => { throw new Error('no fonts'); }).processDue();
    assert.ok(mem3.sent.map((s) => parseEscPos(s.bytes).text).some((x) => x.includes(r3.invoice.invoiceNo) && x.includes('??? Special Rs')));
  } finally { env.cleanup(); }
});

test('picture lines keep table columns: each piece is placed in its own columns, also in the text fallback', async () => {
  const p = new EscPos(48).init();
  p.twoCol('\u0915\u0941\u0932', '\u20b9 258.00');
  p.segments([{ t: '\u092a\u0928\u0940\u0930 \u091f\u093f\u0915\u094d\u0915\u093e', col: 0, width: 26, align: 'l' }, { t: '2', col: 27, width: 3, align: 'r' }, { t: '258.00', col: 40, width: 8, align: 'r' }]);
  p.line('Plain line');
  const bytes = p.bytes();
  const marks = findMarkers(bytes);
  assert.equal(marks.length, 2);
  assert.deepEqual(marks[0]!.spec.s.map((g) => [g.col, g.width, g.align]), [[0, 39, 'l'], [40, 8, 'r']]);
  const fallback = parseEscPos(await expandPictures(bytes, null)).lines.filter(Boolean);
  assert.equal(fallback[0], '???' + ' '.repeat(36) + 'Rs 258.00', 'the amount keeps every digit: "Rs" grows into the free space');
  assert.equal(fallback[1]!.length, 48);
  assert.ok(fallback[1]!.endsWith('258.00'));
  assert.equal(fallback[2], 'Plain line');
  // the renderer output is checked for size; a wrong-size picture falls back to text
  const bad: TextRenderer = async (specs) => specs.map(() => ({ widthBytes: 2, height: 2, data: new Uint8Array(3) }));
  clearPictureCache();
  assert.equal(parseEscPos(await expandPictures(bytes, bad)).rasters.length, 0);
});

test('KOT: routed by category station, with token, modifiers and no prices', () => {
  const env = makeEnv(); try {
    startShift(env);
    const r = mixedBill(env);
    const kitchen = all<{ payload: Uint8Array }>(env.ctx.db, "SELECT payload FROM print_job WHERE kind='KOT' ORDER BY created_at").map((j) => parseEscPos(j.payload).text);
    assert.equal(kitchen.length, 2);
    const k = kitchen.find((t) => t.includes('KOT - kitchen'))!, b = kitchen.find((t) => t.includes('KOT - bar'))!;
    assert.ok(k.includes('TOKEN 1') && k.includes('1 x Cheese Burger') && k.includes('+ Extra cheese'));
    assert.ok(b.includes('2 x Cola 300ml') && !b.includes('Cheese Burger'));
    assert.ok(!/\d+\.\d\d/.test(k), 'kitchen tickets carry no prices');
    assert.ok(r.invoice.tokenNo === 1);
  } finally { env.cleanup(); }
});

test('builder + virtual printer: QR, raster, feed, size and long-name wrapping round-trip', () => {
  const p = new EscPos(32).init().qr('upi://pay?pa=shop@upi&am=100.00', 5).raster(2, 3, Uint8Array.from([1, 2, 3, 4, 5, 6])).feed(2).size(2, 2).center('BIG').size(1, 1).line('x').cut();
  const parsed = parseEscPos(p.bytes());
  assert.deepEqual(parsed.qrs, ['upi://pay?pa=shop@upi&am=100.00']);
  assert.deepEqual(parsed.rasters, [{ widthBytes: 2, height: 3 }]);
  assert.equal(parsed.cuts, 1);
  assert.ok(parsed.lines.includes('      BIG')); // centred within the doubled-width line (16 columns)
  assert.throws(() => new EscPos(32).raster(2, 3, new Uint8Array(5)));
  assert.throws(() => new EscPos(32).qr(''));
  assert.throws(() => parseEscPos(Uint8Array.from([0x1b, 0x99])));
  for (const w of [24, 32, 48]) {
    for (const s of ['Extra Large Double Patty Smoky BBQ Chicken Burger With Cheese', 'Supercalifragilisticexpialidocious_and_more_words_without_spaces', '', '   ']) {
      assert.ok(wrapText(s, w).every((l) => l.length <= w));
    }
  }
});

function queueEnv() {
  const env = makeEnv();
  const mem = new MemoryTransport();
  const q = new PrintQueue(env.ctx, { memory: mem });
  return { env, mem, q };
}
const statuses = (env: Env) => all<{ status: string; attempts: number }>(env.ctx.db, 'SELECT status, attempts FROM print_job ORDER BY created_at, rowid').map((r) => `${r.status}/${r.attempts}`);

test('queue prints every job in order and marks them PRINTED', async () => {
  const { env, mem, q } = queueEnv(); try {
    startShift(env);
    mixedBill(env);
    const res = await q.processDue();
    assert.equal(res.printed, 3);
    assert.deepEqual(statuses(env), ['PRINTED/0', 'PRINTED/0', 'PRINTED/0']);
    assert.equal(mem.sent.length, 3);
    assert.equal((await q.processDue()).printed, 0);
  } finally { env.cleanup(); }
});

test('queue: offline printer backs off 1s/3s/10s, then FAILED; one-click retry succeeds; billing is unaffected', async () => {
  const { env, mem, q } = queueEnv(); try {
    startShift(env);
    const events: string[] = [];
    env.ctx.events.on('print', (e: { status: string }) => events.push(e.status));
    quickBill(env, [['Masala Chai']]); // 1 receipt + 1 kitchen? (bar) -> 2 jobs
    mem.failures = 100;
    await q.processDue();
    assert.equal(statuses(env)[0], 'QUEUED/1');
    assert.equal((await q.processDue()).retried + (await q.processDue()).printed, 0); // not due yet (strict order, waits)
    env.clock.advance(1000); await q.processDue();
    assert.equal(statuses(env)[0], 'QUEUED/2');
    env.clock.advance(3000); await q.processDue();
    assert.equal(statuses(env)[0], 'QUEUED/3');
    env.clock.advance(10_000); await q.processDue();
    assert.equal(statuses(env)[0], 'FAILED/4');
    assert.ok(events.includes('RETRYING') && events.includes('FAILED'));
    // the bill itself is fine while printing is broken
    assert.equal(quickBill(env, [['Masala Chai']]).invoice.invoiceNo, 'A1/26-27/000002');
    mem.failures = 0;
    const failed = get<{ id: string }>(env.ctx.db, "SELECT id FROM print_job WHERE status='FAILED' LIMIT 1")!;
    q.retry(failed.id);
    assert.equal(code(() => q.retry(failed.id)), 'NOT_FOUND'); // only FAILED jobs can be retried
    await q.processDue();
    assert.equal(get<{ status: string }>(env.ctx.db, 'SELECT status FROM print_job WHERE id = ?', failed.id)!.status, 'PRINTED');
  } finally { env.cleanup(); }
});

test('queue keeps strict order per printer: a waiting head job holds back later jobs', async () => {
  const { env, mem, q } = queueEnv(); try {
    startShift(env);
    quickBill(env, [['French Fries']]);
    quickBill(env, [['French Fries']]);
    const receiptPrinter = get<{ id: string }>(env.ctx.db, "SELECT id FROM printer WHERE name LIKE 'Counter%'")!.id;
    mem.failures = 1;
    await q.processDue();
    const rec = all<{ status: string; ref_id: string }>(env.ctx.db, "SELECT status, ref_id FROM print_job WHERE printer_id = ? AND kind='RECEIPT' ORDER BY created_at, rowid", receiptPrinter);
    assert.deepEqual(rec.map((r) => r.status), ['QUEUED', 'QUEUED']); // second receipt did not jump the queue
    env.clock.advance(1000);
    await q.processDue();
    const sent = mem.sent.filter((s) => s.printerId === receiptPrinter).map((s) => parseEscPos(s.bytes).text.match(/A1\/26-27\/\d{6}/)![0]);
    assert.deepEqual(sent, ['A1/26-27/000001', 'A1/26-27/000002']);
  } finally { env.cleanup(); }
});

test('queue recovers jobs that were mid-send when the app crashed', async () => {
  const { env, mem, q } = queueEnv(); try {
    startShift(env);
    quickBill(env, [['French Fries']]);
    run(env.ctx.db, "UPDATE print_job SET status = 'SENDING'");
    assert.equal(q.recoverOnStartup(), 2);
    assert.equal((await q.processDue()).printed, 2);
    assert.equal(mem.sent.length, 2);
  } finally { env.cleanup(); }
});

test('reprint: manager approval, DUPLICATE marker, copy numbers, no double-print of the same copy', async () => {
  const { env, mem, q } = queueEnv(); try {
    startShift(env);
    const r = quickBill(env, [['French Fries']]);
    await q.processDue();
    assert.equal(code(() => reprintInvoice(env.ctx, env.cashier, rid(), { invoiceId: r.invoice.id })), 'APPROVAL_REQUIRED');
    const ov = { userId: env.manager.userId, pin: '2345' };
    const a = reprintInvoice(env.ctx, env.cashier, rid(), { invoiceId: r.invoice.id, override: ov });
    const b = reprintInvoice(env.ctx, env.manager, rid(), { invoiceId: r.invoice.id });
    assert.deepEqual([a.copyNo, b.copyNo], [2, 3]);
    await q.processDue();
    const texts = mem.sent.map((s) => parseEscPos(s.bytes).text);
    assert.equal(texts.filter((t) => t.includes('*** DUPLICATE ***')).length, 2);
    assert.equal(mem.sent.map((s) => parseEscPos(s.bytes)).filter((p) => p.drawerKicks > 0).length, 1); // only the original cash receipt opens the drawer, never a duplicate
  } finally { env.cleanup(); }
});

test('test page job prints a QR and the configured width', async () => {
  const { env, mem, q } = queueEnv(); try {
    const id = get<{ id: string }>(env.ctx.db, "SELECT id FROM printer WHERE name LIKE 'Counter%'")!.id;
    testPrint(env.ctx, env.owner, rid(), id);
    await q.processDue();
    const p = parseEscPos(mem.sent[0]!.bytes);
    assert.ok(p.text.includes('PRINTER TEST') && p.text.includes('Width: 48 characters'));
    assert.equal(p.qrs.length, 1);
    assert.equal(code(() => testPrint(env.ctx, env.cashier, rid(), id)), 'FORBIDDEN');
  } finally { env.cleanup(); }
});

async function captureServer() {
  const received: Buffer[] = [];
  const srv = net.createServer((s) => s.on('data', (d: Buffer | string) => received.push(Buffer.from(d))));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as net.AddressInfo).port;
  const total = () => received.reduce((n, b) => n + b.length, 0);
  const wait = async (n: number) => { const t0 = Date.now(); while (total() < n && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 10)); };
  return { port, received, wait, close: () => srv.close() };
}
const tcpPrinter = (port: number, profile = 'generic'): PrinterRow => ({ id: 'tcp1', name: 'LAN', transport: 'tcp', address: `127.0.0.1:${port}`, width_mm: 80, profile, raster: 0, is_receipt: 1, drawer: 0, stations: '[]', active: 1 });

test('TCP transport: delivers every byte of a large job, chunked for small-buffer printers', async () => {
  const cap = await captureServer(); try {
    const payload = Uint8Array.from({ length: 5000 }, (_, i) => i % 251);
    await new TcpTransport().send(tcpPrinter(cap.port, 'slow_buffer'), payload);
    await cap.wait(5000);
    assert.deepEqual(new Uint8Array(Buffer.concat(cap.received)), payload);
    assert.equal(chunks(payload, 256).length, 20);
    assert.equal(chunks(new Uint8Array(0), 256).length, 0);
  } finally { cap.close(); }
});

test('TCP transport: a refused connection is an error the queue can retry', async () => {
  await assert.rejects(new TcpTransport(500).send(tcpPrinter(1), new Uint8Array(3)));
});

test('end to end over TCP: the queue prints a real receipt to a LAN printer', async () => {
  const cap = await captureServer();
  const env = makeEnv(); try {
    startShift(env);
    run(env.ctx.db, "UPDATE printer SET is_receipt = 0, stations = '[]'"); // only the LAN printer remains
    createPrinter(env.ctx, env.owner, rid(), { name: 'LAN', transport: 'tcp', address: `127.0.0.1:${cap.port}`, isReceipt: true });
    const q = new PrintQueue(env.ctx, { tcp: new TcpTransport() });
    quickBill(env, [['Cheese Burger']]);
    assert.equal((await q.processDue()).printed, 1);
    const bytes = get<{ payload: Uint8Array }>(env.ctx.db, "SELECT payload FROM print_job WHERE status='PRINTED'")!.payload;
    await cap.wait(bytes.length);
    assert.deepEqual(new Uint8Array(Buffer.concat(cap.received)), new Uint8Array(bytes));
    assert.ok(parseEscPos(new Uint8Array(Buffer.concat(cap.received))).text.includes('Cheese Burger'));
  } finally { cap.close(); env.cleanup(); }
});

test('real Windows: a Hindi line and the rupee sign are drawn by Windows fonts (GDI+) into a printer picture', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  const { windowsTextRenderer } = await import('../src/services/printing/textRender.ts');
  const p = new EscPos(48).init().bold(true).line('मसाला चाय').bold(false).twoCol('Total', '₹ 129.00').line('Plain line');
  clearPictureCache();
  const out = parseEscPos(await expandPictures(p.bytes(), windowsTextRenderer()));
  assert.equal(out.rasters.length, 2);
  assert.deepEqual(out.rasters[0], { widthBytes: 72, height: 24 });
  assert.equal(out.pictures, 0, 'no marker reaches the printer');
  assert.ok(out.text.includes('Plain line'));
});
