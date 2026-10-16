import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, get, run, AppError } from '../src/store/db.ts';
import { createPrinter, printSample, sampleReceipt, testDrawer } from '../src/services/printing/jobs.ts';
import { retryFailed } from '../src/services/printing/queue.ts';
import { listUsbDevices, resetDetectCache } from '../src/services/printing/detect.ts';
import { parseEscPos } from '../src/services/printing/virtual.ts';
import { setSetting } from '../src/services/settings.ts';
import { makeEnv, rid } from './helpers.ts';

const code = (fn: () => unknown): string => { try { fn(); } catch (e) { if (e instanceof AppError) return e.code; throw e; } return 'NO_ERROR'; };
const counter = (env: ReturnType<typeof makeEnv>) => get<{ id: string }>(env.ctx.db, "SELECT id FROM printer WHERE name LIKE 'Counter%'")!.id;

test('sample receipt: the real layout with the shop header and footer, clearly marked as not a bill', () => {
  const env = makeEnv(); try {
    setSetting(env.ctx, 'receipt_footer', 'Follow us @demoburger');
    const s = sampleReceipt(env.ctx, 80);
    assert.equal(s.cols, 48);
    const text = s.lines.join('\n');
    for (const must of ['Demo Burger Hub', 'GSTIN: 29ABCDE1234F1Z5', 'SAMPLE - NOT A BILL', 'Follow us @demoburger', 'Net Amount']) assert.ok(text.includes(must), must);
    assert.ok(!text.includes('TAX INVOICE'));
    assert.ok(s.lines.every((l) => l.length <= 48));
    assert.ok(sampleReceipt(env.ctx, 58).lines.every((l) => l.length <= 32));
    assert.equal(code(() => sampleReceipt(env.ctx, 76)), 'VALIDATION');
  } finally { env.cleanup(); }
});

test('setup tests: print a sample receipt and kick the cash drawer on a chosen printer (managers only)', () => {
  const env = makeEnv(); try {
    const id = counter(env);
    const s = printSample(env.ctx, env.manager, rid(), id);
    const sample = get<{ payload: Uint8Array; kind: string }>(env.ctx.db, 'SELECT payload, kind FROM print_job WHERE id = ?', s.jobId)!;
    assert.equal(sample.kind, 'TEST');
    assert.ok(parseEscPos(sample.payload).text.includes('SAMPLE - NOT A BILL'));
    const d = testDrawer(env.ctx, env.manager, rid(), id);
    const kick = parseEscPos(get<{ payload: Uint8Array }>(env.ctx.db, 'SELECT payload FROM print_job WHERE id = ?', d.jobId)!.payload);
    assert.equal(kick.drawerKicks, 1);
    assert.equal(kick.cuts, 0); // no paper wasted
    assert.equal(code(() => printSample(env.ctx, env.cashier, rid(), id)), 'FORBIDDEN');
    assert.equal(code(() => testDrawer(env.ctx, env.cashier, rid(), id)), 'FORBIDDEN');
    assert.equal(code(() => testDrawer(env.ctx, env.manager, rid(), 'nope')), 'NOT_FOUND');
    run(env.ctx.db, 'UPDATE printer SET active = 0 WHERE id = ?', id);
    assert.equal(code(() => printSample(env.ctx, env.manager, rid(), id)), 'PRINTER_OFF');
  } finally { env.cleanup(); }
});

test('retry failed: every failed job of a printer goes back in the queue; refused while the printer is off', () => {
  const env = makeEnv(); try {
    const id = counter(env);
    for (let i = 0; i < 3; i++) printSample(env.ctx, env.manager, rid(), id);
    run(env.ctx.db, "UPDATE print_job SET status = 'FAILED', attempts = 4, last_error = 'offline' WHERE printer_id = ?", id);
    assert.deepEqual(retryFailed(env.ctx, env.manager, id), { printerId: id, requeued: 3 });
    assert.equal(all(env.ctx.db, "SELECT 1 FROM print_job WHERE printer_id = ? AND status = 'QUEUED' AND attempts = 0", id).length, 3);
    assert.equal(code(() => retryFailed(env.ctx, env.cashier, id)), 'NO_ERROR'); // cashiers may retry their failed prints
    run(env.ctx.db, 'UPDATE printer SET active = 0 WHERE id = ?', id);
    assert.equal(code(() => retryFailed(env.ctx, env.manager, id)), 'PRINTER_OFF');
    assert.ok(get(env.ctx.db, "SELECT 1 FROM audit_log WHERE action = 'print.retry_failed'"));
  } finally { env.cleanup(); }
});

test('connected USB printers: every plugged-in printer is listed, with the printer it is set up as (if any)', async () => {
  const env = makeEnv(); try {
    resetDetectCache(env.ctx);
    const p = createPrinter(env.ctx, env.manager, rid(), { name: 'Counter USB', transport: 'usb', address: '0416:5011', isReceipt: true });
    let scans = 0;
    const scan = async () => { scans++; return {
      usb: [
        { id: '0416:5011', vid: '0416', pid: '5011', serial: null, name: 'USB Printing Support', vendor: 'Winbond (common in 58/80 mm POS printers)', driver: 'usbprint' as const },
        { id: '0483:5743', vid: '0483', pid: '5743', serial: null, name: 'POS58 USB', vendor: null, driver: 'usbprint' as const },
      ],
      windows: [{ name: 'EPSON TM-T82', port: 'USB003', driver: 'EPSON TM-T82 Receipt', offline: false, connection: 'usb' as const }],
    }; };
    const r = await listUsbDevices(env.ctx, { scan, platform: 'win32' });
    assert.deepEqual(r.devices.map((d) => [d.key, d.printerId === p.id ? 'Counter USB' : d.printerName, d.widthMm]), [
      ['usb:0416:5011', 'Counter USB', 80],
      ['usb:0483:5743', null, 58],
      ['spooler:EPSON TM-T82', null, 80],
    ]);
    assert.equal(typeof r.scannedAt, 'number');
    await listUsbDevices(env.ctx, { scan, platform: 'win32' });
    assert.equal(scans, 1); // cached
    await listUsbDevices(env.ctx, { scan, platform: 'win32', refresh: true });
    assert.equal(scans, 2); // "Scan again" forces a fresh look
    assert.deepEqual((await listUsbDevices(env.ctx, { scan, platform: 'linux' })).devices, []);
  } finally { env.cleanup(); }
});
