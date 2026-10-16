import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { all, get, run, AppError } from '../src/store/db.ts';

import { FileTransport, MemoryTransport } from '../src/services/printing/transports.ts';
import { createPrinter, deletePrinter, invoicePrints, listPrinters, receiptPreview, updatePrinter } from '../src/services/printing/jobs.ts';
import { PrintQueue, listJobs } from '../src/services/printing/queue.ts';
import { parseEscPos } from '../src/services/printing/virtual.ts';
import { getHealth } from '../src/services/health.ts';
import { makeEnv, quickBill, rid, startShift } from './helpers.ts';

const code = (fn: () => unknown): string => { try { fn(); } catch (e) { if (e instanceof AppError) return e.code; throw e; } return 'NO_ERROR'; };
const add = (env: ReturnType<typeof makeEnv>, transport: 'tcp' | 'spooler' | 'serial' | 'file' | 'memory', address: string | null, extra: Record<string, unknown> = {}) =>
  createPrinter(env.ctx, env.manager, rid(), { name: `P ${transport} ${String(address)}`, transport, address, ...extra });

test('printers: each connection checks its own address (USB name, Wi-Fi IP, Bluetooth COM port)', () => {
  const env = makeEnv(); try {
    for (const ok of [['tcp', '192.168.1.50'], ['tcp', '192.168.1.50:9100'], ['tcp', 'kitchen-printer.local:9101'], ['spooler', 'EPSON TM-T82 Receipt'], ['serial', 'COM5'], ['serial', 'COM7:115200'], ['file', 'receipts.bin'], ['memory', null]] as const) {
      assert.equal(code(() => add(env, ok[0], ok[1])), 'NO_ERROR', `${ok[0]} ${ok[1]}`);
    }
    for (const bad of [['tcp', ''], ['tcp', '192.168.1.50:0'], ['tcp', '192.168.1.50:70000'], ['tcp', 'http://x'], ['spooler', ''], ['spooler', 'POS\n80'], ['serial', 'COM5;calc'], ['serial', 'LPT1'],
      ['file', '../../Windows/win.ini'], ['file', 'C:\\Windows\\win.ini'], ['file', 'sub/dir.bin']] as const) {
      assert.equal(code(() => add(env, bad[0], bad[1])), 'VALIDATION', `${bad[0]} ${bad[1]}`);
    }
    assert.equal(code(() => createPrinter(env.ctx, env.cashier, rid(), { name: 'X', transport: 'tcp', address: '10.0.0.5' })), 'FORBIDDEN');
  } finally { env.cleanup(); }
});

test('printers: the file connection only writes inside the data folder', async () => {
  const env = makeEnv(); try {
    const t = new FileTransport(join(env.ctx.dataDir, 'print-files'));
    await t.send({ id: 'f', name: 'F', transport: 'file', address: 'out.bin', width_mm: 80, profile: 'generic', raster: 0, is_receipt: 1, drawer: 0, stations: '[]', active: 1 }, Uint8Array.from([1, 2, 3]));
    assert.deepEqual([...readFileSync(join(env.ctx.dataDir, 'print-files', 'out.bin'))], [1, 2, 3]);
    await assert.rejects(t.send({ id: 'f', name: 'F', transport: 'file', address: '../escape.bin', width_mm: 80, profile: 'generic', raster: 0, is_receipt: 1, drawer: 0, stations: '[]', active: 1 }, Uint8Array.from([1])), /plain file name/);
    assert.ok(!existsSync(join(env.ctx.dataDir, 'escape.bin')));
  } finally { env.cleanup(); }
});

test('printers: edit settings; turning a printer off releases its waiting jobs as failed; removing keeps history', async () => {
  const env = makeEnv(); try {
    startShift(env);
    const counter = get<{ id: string }>(env.ctx.db, "SELECT id FROM printer WHERE name LIKE 'Counter%'")!.id;
    updatePrinter(env.ctx, env.manager, rid(), counter, { widthMm: 58, drawer: false, name: 'Counter 58' });
    const p = listPrinters(env.ctx).find((x) => x.id === counter)!;
    assert.deepEqual([p.name, p.widthMm, p.drawer], ['Counter 58', 58, false]);
    assert.equal(code(() => updatePrinter(env.ctx, env.manager, rid(), counter, { widthMm: 76 })), 'VALIDATION');
    assert.equal(code(() => updatePrinter(env.ctx, env.cashier, rid(), counter, { widthMm: 80 })), 'FORBIDDEN');
    assert.equal(code(() => updatePrinter(env.ctx, env.manager, rid(), 'nope', { widthMm: 80 })), 'NOT_FOUND');

    quickBill(env, [['Cheese Burger']]);
    assert.ok(get<{ n: number }>(env.ctx.db, "SELECT count(*) n FROM print_job WHERE printer_id = ? AND status = 'QUEUED'", counter)!.n > 0);
    updatePrinter(env.ctx, env.manager, rid(), counter, { active: false });
    assert.equal(get<{ n: number }>(env.ctx.db, "SELECT count(*) n FROM print_job WHERE printer_id = ? AND status = 'QUEUED'", counter)!.n, 0);
    const failed = listJobs(env.ctx, 'FAILED');
    assert.ok(failed.length > 0 && failed.every((j) => /turned off/.test(j.lastError ?? '')));
    assert.match(failed[0]!.invoiceNo ?? '', /^A1\//); // jobs carry the bill number and printer name for the cashier
    assert.equal(failed[0]!.printerName, 'Counter 58');
    const q = new PrintQueue(env.ctx, { memory: new MemoryTransport() });
    assert.throws(() => q.retry(failed[0]!.id), /turned off/);

    // removing a printer with print history turns it off instead; one without history is deleted
    assert.deepEqual(deletePrinter(env.ctx, env.manager, rid(), counter), { id: counter, removed: false, deactivated: true });
    const spare = add(env, 'tcp', '10.0.0.9').id;
    assert.deepEqual(deletePrinter(env.ctx, env.manager, rid(), spare), { id: spare, removed: true, deactivated: false });
    assert.equal(get(env.ctx.db, 'SELECT 1 FROM printer WHERE id = ?', spare), undefined);
    assert.ok(all(env.ctx.db, "SELECT 1 FROM audit_log WHERE action IN ('printer.update','printer.delete')").length >= 3);
  } finally { env.cleanup(); }
});

test('billing: finalize reports what was queued to print and warns when no receipt printer is set up', () => {
  const env = makeEnv(); try {
    startShift(env);
    const r1 = quickBill(env, [['Cheese Burger']]);
    assert.deepEqual(r1.print, { receipts: 1, kitchenTickets: 1, warnings: [] });
    run(env.ctx.db, 'UPDATE printer SET active = 0');
    const r2 = quickBill(env, [['Cheese Burger']]);
    assert.deepEqual(r2.print.receipts, 0);
    assert.deepEqual(r2.print.warnings, ['NO_RECEIPT_PRINTER', 'NO_KITCHEN_PRINTER']);
    assert.ok(getHealth(env.ctx).warnings.some((w) => /no receipt printer/i.test(w)));
  } finally { env.cleanup(); }
});

test('receipt preview is exactly what the printer gets; per-bill print status shows each job', async () => {
  const env = makeEnv(); try {
    startShift(env);
    const b = quickBill(env, [['Cheese Burger'], ['Cola 300ml', 2000]]);
    const job = get<{ payload: Uint8Array }>(env.ctx.db, "SELECT payload FROM print_job WHERE ref_id = ? AND kind = 'RECEIPT'", b.invoice.id)!;
    const pv = receiptPreview(env.ctx, b.invoice.id, 80);
    assert.equal(pv.cols, 48);
    assert.deepEqual(pv.lines, parseEscPos(job.payload).lines);
    assert.ok(pv.lines.some((l) => l.includes('Cheese Burger')));
    assert.equal(receiptPreview(env.ctx, b.invoice.id, 58).cols, 32);
    assert.equal(code(() => receiptPreview(env.ctx, 'nope', 80)), 'NOT_FOUND');

    let st = invoicePrints(env.ctx, b.invoice.id);
    assert.deepEqual(st.map((j) => [j.kind, j.status]).sort(), [['KOT', 'QUEUED'], ['KOT', 'QUEUED'], ['RECEIPT', 'QUEUED']].sort());
    const mem = new MemoryTransport();
    await new PrintQueue(env.ctx, { memory: mem }).processDue();
    st = invoicePrints(env.ctx, b.invoice.id);
    assert.ok(st.every((j) => j.status === 'PRINTED' && typeof j.printerName === 'string'));
    const p = listPrinters(env.ctx).find((x) => x.isReceipt)!;
    assert.equal(p.stats.failed, 0);
    assert.ok(p.stats.lastPrintedAt !== null);
  } finally { env.cleanup(); }
});
