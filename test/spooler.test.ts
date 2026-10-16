import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get, run } from '../src/store/db.ts';
import { PrintQueue } from '../src/services/printing/queue.ts';
import { SpoolerTransport, spoolerScript } from '../src/services/printing/spooler.ts';
import type { SpoolRequest, SpoolResult } from '../src/services/printing/spooler.ts';
import type { PrinterRow } from '../src/services/printing/transports.ts';
import { createPrinter } from '../src/services/printing/jobs.ts';
import { parseEscPos } from '../src/services/printing/virtual.ts';
import { makeEnv, quickBill, rid, startShift } from './helpers.ts';

const spoolPrinter = (address: string | null = 'EPSON TM-T82 Receipt'): PrinterRow => ({ id: 'sp1', name: 'USB', transport: 'spooler', address, width_mm: 80, profile: 'generic', raster: 0, is_receipt: 1, drawer: 0, stations: '[]', active: 1 });

/** A fake runner that records what would reach PowerShell and answers like the script does. */
function fakeRunner(answer: (r: SpoolRequest) => SpoolResult) {
  const calls: SpoolRequest[] = [];
  return { calls, run: async (r: SpoolRequest) => { calls.push({ ...r, bytes: Uint8Array.from(r.bytes) }); return answer(r); } };
}
const ok = (r: SpoolRequest): SpoolResult => ({ code: 0, stdout: `OK ${r.bytes.length}`, stderr: '' });

test('spooler transport: hands the exact bytes and the Windows printer name to the runner', async () => {
  const f = fakeRunner(ok);
  const payload = Uint8Array.from({ length: 5000 }, (_, i) => i % 256);
  await new SpoolerTransport({ platform: 'win32', run: f.run }).send(spoolPrinter(), payload);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.printerName, 'EPSON TM-T82 Receipt');
  assert.deepEqual(f.calls[0]!.bytes, payload);
});

test('spooler transport: refuses outside Windows and without a printer name, before running anything', async () => {
  const f = fakeRunner(ok);
  await assert.rejects(new SpoolerTransport({ platform: 'linux', run: f.run }).send(spoolPrinter(), new Uint8Array(3)), /only available on Windows/);
  await assert.rejects(new SpoolerTransport({ platform: 'win32', run: f.run }).send(spoolPrinter(null), new Uint8Array(3)), /needs the Windows printer name/);
  await assert.rejects(new SpoolerTransport({ platform: 'win32', run: f.run }).send(spoolPrinter('  '), new Uint8Array(3)), /needs the Windows printer name/);
  assert.equal(f.calls.length, 0);
});

test('spooler transport: Win32 failures become plain-language errors the queue can retry', async () => {
  const cases: Array<[SpoolResult, RegExp]> = [
    [{ code: 1, stdout: 'ERR open 1801', stderr: '' }, /was not found in Windows/],
    [{ code: 1, stdout: 'ERR open 5', stderr: '' }, /permission/i],
    [{ code: 1, stdout: 'ERR startdoc 1804', stderr: '' }, /RAW/],
    [{ code: 1, stdout: 'ERR write 31', stderr: '' }, /stopped while sending.*31/],
    [{ code: 0, stdout: 'OK 2', stderr: '' }, /accepted 2 of 3 bytes/],
    [{ code: 1, stdout: '', stderr: 'Add-Type : compiler failure\r\nat line 1' }, /could not start the Windows print helper/],
    [{ code: null, stdout: '', stderr: '', timedOut: true }, /timed out/],
  ];
  for (const [answer, expected] of cases) {
    const t = new SpoolerTransport({ platform: 'win32', run: async () => answer });
    await assert.rejects(t.send(spoolPrinter(), new Uint8Array(3)), (e: Error) => {
      assert.match(e.message, expected);
      assert.ok(!/\r|\n|at line/.test(e.message), `no raw PowerShell text in "${e.message}"`);
      return true;
    });
  }
});

test('spooler script: printer name and data never appear in the command; a failed write aborts the job', () => {
  const s = spoolerScript();
  assert.ok(s.includes('$env:POS_SPOOL_PRINTER') && s.includes('[Console]::In.ReadToEnd()'));
  assert.ok(s.includes('"RAW"'), 'RAW datatype so the driver does not reinterpret ESC/POS');
  assert.ok(s.includes('AbortPrinter'), 'a partial job must be discarded, not printed');
});

test('end to end with a fake spooler: the queue prints a receipt, and retries when the printer is missing', async () => {
  const env = makeEnv(); try {
    startShift(env);
    run(env.ctx.db, "UPDATE printer SET is_receipt = 0, stations = '[]'");
    createPrinter(env.ctx, env.owner, rid(), { name: 'USB receipt', transport: 'spooler', address: 'POS-80', isReceipt: true });
    let missing = true;
    const f = fakeRunner((r) => (missing ? { code: 1, stdout: 'ERR open 1801', stderr: '' } : ok(r)));
    const q = new PrintQueue(env.ctx, { spooler: new SpoolerTransport({ platform: 'win32', run: f.run }) }, [0, 0, 0]);
    quickBill(env, [['Cheese Burger']]);
    assert.equal((await q.processDue()).retried, 1);
    assert.match(get<{ last_error: string }>(env.ctx.db, 'SELECT last_error FROM print_job')!.last_error, /not found/);
    missing = false;
    assert.equal((await q.processDue()).printed, 1);
    assert.ok(parseEscPos(f.calls.at(-1)!.bytes).text.includes('Cheese Burger'));
  } finally { env.cleanup(); }
});

// Real Windows spooler. Uses a printer name that cannot exist, so nothing is ever printed.
test('real Windows spooler: a missing printer is reported as not found', { skip: process.platform !== 'win32' && 'Windows only', timeout: 60_000 }, async () => {
  const name = `POS test missing printer ${Date.now()}`;
  await assert.rejects(new SpoolerTransport().send(spoolPrinter(name), new Uint8Array([0x1b, 0x40])), /was not found in Windows/);
});

// Opt-in: set POS_TEST_SPOOLER_PRINTER to a test queue (for example a Generic / Text Only printer on FILE: or a real receipt printer).
const realPrinter = process.env.POS_TEST_SPOOLER_PRINTER;
test('real Windows spooler: sends a RAW job to the printer named in POS_TEST_SPOOLER_PRINTER', { skip: !realPrinter && 'set POS_TEST_SPOOLER_PRINTER to run', timeout: 60_000 }, async () => {
  const bytes = new TextEncoder().encode('\x1b@POS spooler test\n\n\n\x1dV\x00');
  await new SpoolerTransport().send(spoolPrinter(realPrinter!), bytes);
});
