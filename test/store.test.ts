import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { get, run, AppError } from '../src/store/db.ts';
import { clearStoreLogo, getStore, logoPng, setStoreLogo, storeLogo, updateStore } from '../src/services/store.ts';
import { createPrinter, receiptPreview, sampleReceipt } from '../src/services/printing/jobs.ts';
import { parseEscPos } from '../src/services/printing/virtual.ts';
import { makeEnv, quickBill, rid, startShift } from './helpers.ts';

const code = (fn: () => unknown): string => { try { fn(); } catch (e) { if (e instanceof AppError) return e.code; throw e; } return 'NO_ERROR'; };
const fieldError = (fn: () => unknown) => { try { fn(); } catch (e) { if (e instanceof AppError) return JSON.stringify(e.details); throw e; } return ''; };
const VALID_KA = '29AAGCB7383J1Z4'; // valid check digit, Karnataka (29) like the dev seed
const base = { name: 'Demo Burger Hub', address: '12 MG Road\nBengaluru 560001', phone: '080 4144 0067', gstin: '29ABCDE1234F1Z5', fssaiNo: '11223344556677' };
/** 16 x 8 dots: a black frame. */
const LOGO = { width: 16, height: 8, bitsBase64: Buffer.from([0xff, 0xff, ...Array(12).fill(0).map((_, i) => (i % 2 ? 0x01 : 0x80)), 0xff, 0xff]).toString('base64') };

test('store details: owner only; GSTIN check digit and state, FSSAI and address are checked; an unchanged demo GSTIN does not block other edits', () => {
  const env = makeEnv(); try {
    assert.equal(getStore(env.ctx, env.manager).name, 'Demo Burger Hub');
    assert.equal(code(() => updateStore(env.ctx, env.manager, rid(), base)), 'FORBIDDEN');
    assert.equal(code(() => getStore(env.ctx, env.cashier)), 'FORBIDDEN');
    assert.match(fieldError(() => updateStore(env.ctx, env.owner, rid(), { ...base, gstin: '29AAGCB7383J1Z5' })), /typo/);
    assert.match(fieldError(() => updateStore(env.ctx, env.owner, rid(), { ...base, gstin: '27AAPFU0939F1ZV' })), /state 27.*state 29/);
    assert.match(fieldError(() => updateStore(env.ctx, env.owner, rid(), { ...base, fssaiNo: '12345' })), /14 digits/);
    assert.match(fieldError(() => updateStore(env.ctx, env.owner, rid(), { ...base, address: 'a\nb\nc\nd\ne' })), /4 lines/);
    assert.match(fieldError(() => updateStore(env.ctx, env.owner, rid(), { ...base, name: ' ' })), /store name/);
    // the demo GSTIN has no valid check digit, but it is not being changed
    const r = updateStore(env.ctx, env.owner, rid(), { ...base, name: 'The Local Diners', gstin: ' 29abcde1234f1z5 '.toUpperCase() });
    assert.deepEqual(r.changed.sort(), ['address', 'name', 'phone']);
    assert.equal(getStore(env.ctx, env.manager).address, '12 MG Road\nBengaluru 560001');
    updateStore(env.ctx, env.owner, rid(), { ...base, name: 'The Local Diners', gstin: VALID_KA });
    assert.equal(getStore(env.ctx, env.manager).gstin, VALID_KA);
    assert.ok(get(env.ctx.db, "SELECT 1 FROM audit_log WHERE action = 'store.update'"));
  } finally { env.cleanup(); }
});

test('a bill keeps the store details valid when it was issued, also on reprints; the history cannot be edited', () => {
  const env = makeEnv(); try {
    startShift(env, 50000);
    const before = quickBill(env, [['Cheese Burger']]);
    env.clock.advance(60_000);
    updateStore(env.ctx, env.owner, rid(), { ...base, name: 'The Local Diners', address: '#2075, 4th Cross\nKalyan Nagar\nBANGALORE-560 043' });
    env.clock.advance(60_000);
    const after = quickBill(env, [['Cheese Burger']]);
    const old = receiptPreview(env.ctx, before.invoice.id, 80).lines.join('\n');
    const now = receiptPreview(env.ctx, after.invoice.id, 80).lines.join('\n');
    assert.match(old, /Demo Burger Hub/);
    assert.doesNotMatch(old, /Local Diners/);
    assert.match(now, /The Local Diners/);
    assert.match(now, /#2075, 4th Cross\n\s+Kalyan Nagar\n\s+BANGALORE-560 043/); // the address keeps its lines, centred
    assert.throws(() => run(env.ctx.db, "UPDATE outlet_version SET name = 'x'"), /append-only/);
    assert.throws(() => run(env.ctx.db, 'DELETE FROM outlet_version'), /append-only/);
  } finally { env.cleanup(); }
});

test('bill logo: checked, printed centred above the store name, shown as a black-and-white PNG; removable', () => {
  const env = makeEnv(); try {
    assert.equal(code(() => setStoreLogo(env.ctx, env.manager, rid(), LOGO)), 'FORBIDDEN');
    assert.equal(code(() => setStoreLogo(env.ctx, env.owner, rid(), { ...LOGO, width: 12 })), 'VALIDATION');
    assert.equal(code(() => setStoreLogo(env.ctx, env.owner, rid(), { ...LOGO, width: 400 })), 'VALIDATION');
    assert.equal(code(() => setStoreLogo(env.ctx, env.owner, rid(), { ...LOGO, height: 9 })), 'VALIDATION'); // data does not match the size
    assert.equal(code(() => setStoreLogo(env.ctx, env.owner, rid(), { ...LOGO, bitsBase64: Buffer.alloc(16).toString('base64') })), 'VALIDATION'); // blank
    assert.equal(logoPng(env.ctx), null);
    setStoreLogo(env.ctx, env.owner, rid(), LOGO);
    assert.deepEqual(getStore(env.ctx, env.manager).logo && [getStore(env.ctx, env.manager).logo!.width, getStore(env.ctx, env.manager).logo!.height], [16, 8]);

    createPrinter(env.ctx, env.manager, rid(), { name: 'Slim', transport: 'memory', widthMm: 58, isReceipt: true });
    startShift(env, 50000);
    const bill = quickBill(env, [['Cheese Burger']]);
    for (const row of env.ctx.db.prepare("SELECT j.payload, p.width_mm FROM print_job j JOIN printer p ON p.id = j.printer_id WHERE j.kind = 'RECEIPT' AND j.ref_id = ?").all(bill.invoice.id) as Array<{ payload: Uint8Array; width_mm: number }>) {
      const p = parseEscPos(row.payload);
      assert.deepEqual(p.rasters, [{ widthBytes: row.width_mm === 58 ? 25 : 37, height: 8 }], `${row.width_mm} mm: padded to centre (paper ${row.width_mm === 58 ? 48 : 72} bytes)`);
      assert.equal(p.lines[0], '[LOGO]');
      assert.match(p.lines[1]!, /Demo Burger Hub/);
    }
    assert.equal(sampleReceipt(env.ctx, 80).lines[0], '[LOGO]');

    const png = logoPng(env.ctx)!;
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20), png[24], png[25]], [16, 8, 1, 0]); // 16 x 8, 1 bit grey
    const idatLen = png.readUInt32BE(33);
    const raw = inflateSync(png.subarray(41, 41 + idatLen));
    assert.deepEqual([...raw.subarray(0, 3)], [0, 0x00, 0x00]); // first row black (PNG grey 0 = black)
    assert.deepEqual([...raw.subarray(3, 6)], [0, 0x7f, 0xfe]); // second row: left and right edges black

    clearStoreLogo(env.ctx, env.owner, rid());
    assert.equal(storeLogo(env.ctx), null);
    assert.notEqual(sampleReceipt(env.ctx, 80).lines[0], '[LOGO]');
  } finally { env.cleanup(); }
});
