import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { AppError, get } from '../src/store/db.ts';
import { AndroidTransport, listAndroidPrinters, bridgeConfig } from '../src/services/printing/android.ts';
import type { PrinterRow } from '../src/services/printing/transports.ts';
import { createPrinter } from '../src/services/printing/jobs.ts';
import { listUsbDevices, quickAddPrinter, resetDetectCache } from '../src/services/printing/detect.ts';
import { makeEnv, rid } from './helpers.ts';

const TOKEN = 'T'.repeat(32);
/** A stand-in for the Android app's printer service (PrinterBridge.java), speaking the same line protocol. */
async function fakeBridge(o: { fail?: string } = {}) {
  const printed: Array<{ address: string; slow: boolean; bytes: Buffer }> = [];
  let sawBadToken = false;
  const server = net.createServer((s) => {
    let buf = Buffer.alloc(0), head: Record<string, unknown> | null = null;
    s.on('data', (c: Buffer) => {
      buf = Buffer.concat([buf, c]);
      if (!head) { const i = buf.indexOf(10); if (i < 0) return; head = JSON.parse(buf.subarray(0, i).toString()) as Record<string, unknown>; buf = buf.subarray(i + 1); }
      if (head.token !== TOKEN) { sawBadToken = true; s.end(JSON.stringify({ ok: false, error: 'Not allowed.' }) + '\n'); return; }
      if (head.op === 'list') { s.end(JSON.stringify({ ok: true, printers: [
        { address: 'bt:00:11:22:33:44:55', name: 'Built-in printer', detail: 'Bluetooth InnerPrinter', builtin: true },
        { address: 'usb:0416:5011', name: 'USB receipt printer', detail: 'USB 0416:5011' },
        { address: '../../etc/passwd', name: 'bad' },
      ] }) + '\n'); return; }
      if (head.op === 'print' && buf.length >= Number(head.length)) {
        if (o.fail) { s.end(JSON.stringify({ ok: false, error: o.fail }) + '\n'); return; }
        printed.push({ address: String(head.address), slow: head.slow === true, bytes: buf.subarray(0, Number(head.length)) });
        s.end(JSON.stringify({ ok: true }) + '\n');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return { env: { POS_ANDROID_BRIDGE: `${port}:${TOKEN}` }, printed, badToken: () => sawBadToken, close: () => new Promise<void>((r) => server.close(() => r())) };
}
const row = (address: string, profile = 'generic') => ({ id: 'p', name: 'P', transport: 'android', address, width_mm: 58, profile, raster: 0, is_receipt: 1, drawer: 0, stations: '[]', active: 1 }) as PrinterRow;

test('Android printers: listed through the app (bad addresses dropped), bytes sent with the token, failures reported', async () => {
  const b = await fakeBridge();
  try {
    assert.equal(bridgeConfig({}), null);
    assert.deepEqual(await listAndroidPrinters({}), [], 'not in the Android app: nothing');
    const list = await listAndroidPrinters(b.env);
    assert.deepEqual(list.map((p) => [p.address, p.builtin]), [['bt:00:11:22:33:44:55', true], ['usb:0416:5011', false]]);
    const t = new AndroidTransport(b.env);
    await t.send(row('bt:00:11:22:33:44:55', 'slow_buffer'), Uint8Array.from([0x1b, 0x40, 0x41, 0x0a]));
    assert.deepEqual(b.printed.map((p) => [p.address, p.slow, [...p.bytes]]), [['bt:00:11:22:33:44:55', true, [0x1b, 0x40, 0x41, 0x0a]]]);
    await assert.rejects(t.send(row('../../etc'), Uint8Array.from([1])), /Unknown Android printer address/);
    await assert.rejects(new AndroidTransport({ POS_ANDROID_BRIDGE: `${b.env.POS_ANDROID_BRIDGE.split(':')[0]}:${'x'.repeat(32)}` }).send(row('usb:0416:5011'), Uint8Array.from([1])), /Not allowed/);
    assert.equal(b.badToken(), true);
    await assert.rejects(new AndroidTransport({}).send(row('usb:0416:5011'), Uint8Array.from([1])), /only in the Tiffin POS Android app/);
  } finally { await b.close(); }
  const f = await fakeBridge({ fail: 'Allow the USB printer on the screen, then print again.' });
  try { await assert.rejects(new AndroidTransport(f.env).send(row('usb:0416:5011'), Uint8Array.from([1])), /Allow the USB printer/); } finally { await f.close(); }
});

test('Android printers: addresses are checked when saved; found printers appear in Printer setup and set up in one tap', async () => {
  const env = makeEnv(); try {
    const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as AppError).code; } return 'NO_ERROR'; };
    assert.equal(code(() => createPrinter(env.ctx, env.owner, rid(), { name: 'X', transport: 'android', address: 'bt:zz' })), 'VALIDATION');
    const p = createPrinter(env.ctx, env.owner, rid(), { name: 'Kitchen BT', transport: 'android', address: 'bt:AA:BB:CC:DD:EE:FF', stations: [get<{ id: string }>(env.ctx.db, "SELECT id FROM prep_station WHERE name = 'Kitchen'")!.id] });
    assert.ok(p);
    const scan = async () => ({ usb: [], windows: [], android: [
      { address: 'bt:00:11:22:33:44:55', name: 'Built-in printer', detail: 'Bluetooth InnerPrinter', builtin: true },
      { address: 'bt:AA:BB:CC:DD:EE:FF', name: 'BT-58', detail: 'Bluetooth', builtin: false },
    ] });
    resetDetectCache(env.ctx);
    assert.deepEqual((await listUsbDevices(env.ctx, { scan, platform: 'linux' })).devices, [], 'other platforms: nothing');
    const r = await listUsbDevices(env.ctx, { scan, platform: 'android' });
    assert.deepEqual(r.devices.map((d) => [d.key, d.widthMm, d.printerName]), [['android:bt:00:11:22:33:44:55', 58, null], ['android:bt:AA:BB:CC:DD:EE:FF', 58, 'Kitchen BT']]);
    const added = quickAddPrinter(env.ctx, env.owner, rid(), { key: 'android:bt:00:11:22:33:44:55' });
    assert.equal(added.name, 'Built-in printer');
    assert.equal(get<{ t: string; a: string }>(env.ctx.db, 'SELECT transport t, address a FROM printer WHERE id = ?', added.printerId)!.a, 'bt:00:11:22:33:44:55');
  } finally { env.cleanup(); }
});
