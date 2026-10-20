import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { all, get, AppError } from '../src/store/db.ts';
import { allSettings } from '../src/services/settings.ts';
import { paytmChecksum, verifyPaytmChecksum } from '../src/services/terminals/paytmChecksum.ts';
import { PaytmCloud, PaytmWired } from '../src/services/terminals/paytm.ts';
import { PineCloud, PineWired, csvFields, frame } from '../src/services/terminals/pinelabs.ts';
import type { Connector } from '../src/services/terminals/types.ts';
import { completeCharge, getTxn, listTerminals, recheckCharge, resumeCharges, saveTerminal, setConnectorFactory, startCharge, cancelCharge, voidCharge, openChargeFor } from '../src/services/terminals/service.ts';
import type { TerminalInput } from '../src/services/terminals/service.ts';
import { runReport } from '../src/services/reportCatalog.ts';
import { addLine } from '../src/services/orders.ts';
import { correctPaymentMode } from '../src/services/counter.ts';
import { cartOf, makeEnv, rid, startShift } from './helpers.ts';
import type { Env } from './helpers.ts';

const KEY = 'kbzk1DSbJiV_O3p5'; // a made-up 16-character test key
const code = async (fn: () => unknown): Promise<string> => { try { await fn(); } catch (e) { if (e instanceof AppError) return e.code; throw e; } return 'NO_ERROR'; };
const waitFor = async (env: Env, id: string, done: (s: string) => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) { const t = getTxn(env.ctx, env.cashier, id); if (done(t.status)) return t; if (Date.now() > end) throw new Error(`still ${t.status}: ${t.message}`); await new Promise((r) => setTimeout(r, 20)); }
};

test('Paytm checksum: identical to Paytm\'s own library (paytmchecksum 1.5.1), and a wrong key or body is refused', () => {
  // vectors made with Paytm's library: calculateChecksum(body, key, salt)
  assert.equal(paytmChecksum('{"paytmMid":"TEST123","amount":"1000"}', KEY, 'Ab1='), 'mNaJTaLBjhrH4I+7hyqCxDlOJzsPLMyl0gjsMlPdKVlnSRwhWnq3tvR+rtGvJOyrn7A7h/K5uYSql45jnzLlg7rJkiX5XUj5AHeCC+TdrK4=');
  assert.equal(paytmChecksum('{"a":"₹ हिंदी"}', KEY, 'xY9/'), 'hBTRXtT8qgEfVyEfNmfSKedITrymbbwukwtrpaxfipGECYIJ9oOIOlP/qcClh2iQO8odxLzsoBREJ27mdhE7liwo0w85x6S+aJGAASr/MVo=');
  const c = paytmChecksum('{"x":"1"}', KEY);
  assert.equal(verifyPaytmChecksum('{"x":"1"}', KEY, c), true);
  assert.equal(verifyPaytmChecksum('{"x":"2"}', KEY, c), false);
  assert.equal(verifyPaytmChecksum('{"x":"1"}', 'AAAAAAAAAAAAAAAA', c), false);
  assert.throws(() => paytmChecksum('{}', 'short'), /16 characters/);
});

/** A local stand-in for a company's server: records requests, answers from a handler. */
async function fakeServer(handle: (path: string, body: any) => unknown) {
  const seen: Array<{ path: string; body: any; raw: string }> = [];
  const s = http.createServer(async (req, res) => {
    let raw = ''; for await (const ch of req) raw += ch;
    const body = raw ? JSON.parse(raw) : null;
    seen.push({ path: req.url!, body, raw });
    const out = handle(req.url!, body);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(s.address() as net.AddressInfo).port}`;
  const f: typeof fetch = (url, init) => fetch(String(url).replace(/^https:\/\/[^/]+/, base), init);
  return { seen, f, close: () => new Promise<void>((r) => { s.close(() => r()); s.closeAllConnections(); }) };
}

function useMachine(env: Env, make: () => Connector) {
  setConnectorFactory(env.ctx, () => make(), { pollMs: 10, waitMs: 2000 });
}
const paytmCloudInput: TerminalInput = { name: 'Counter Paytm', provider: 'paytm', connection: 'cloud', modes: ['CARD', 'UPI'], config: { mid: 'TEST123', tid: '12345678', channelId: 'EDC', env: 'test' }, secret: KEY };

test('Paytm over the internet: signed requests, the customer pays by UPI, the bill is saved with the approval details, matched in the report, then reversed', async () => {
  const env = makeEnv();
  let polls = 0;
  const srv = await fakeServer((path, b) => {
    if (path === '/ecr/payment/request') return { head: {}, body: { resultInfo: { resultStatus: 'A', resultCodeId: '0009', resultMsg: 'ACCEPTED_SUCCESS' } } };
    if (path === '/ecr/V2/payment/status' && b.body.event === 'VOID') return { head: {}, body: { resultInfo: { resultStatus: 'S', resultCodeId: '0000', resultMsg: 'SUCCESS' } } };
    if (path === '/ecr/V2/payment/status') return ++polls < 3 ? { head: {}, body: { resultInfo: { resultStatus: 'U', resultCodeId: '0010', resultMsg: 'PENDING' } } }
      : { head: {}, body: { resultInfo: { resultStatus: 'S', resultCodeId: '0000', resultMsg: 'SUCCESS' }, payMethod: 'UPI', authCode: '7261A9', retrievalReferenceNo: '624615343002', acquirementId: 'PAYTM-77' } };
    if (path === '/ecr/void') return { head: {}, body: { resultInfo: { resultStatus: 'A', resultCodeId: '0009', resultMsg: 'ACCEPTED_SUCCESS' } } };
    return { body: { resultInfo: { resultStatus: 'F', resultMsg: 'unknown' } } };
  });
  try {
    startShift(env);
    const m = saveTerminal(env.ctx, env.owner, rid(), null, paytmCloudInput);
    useMachine(env, () => new PaytmCloud(m.config as never, KEY, srv.f));
    const cart = cartOf(env, [['Masala Chai'], ['Brownie']]);
    const t = startCharge(env.ctx, env.cashier, rid(), { orderId: cart.order.id, mode: 'UPI' });
    assert.equal(t.amount, cart.totals.grandTotal, 'the backend total is sent, never the screen\'s');
    assert.equal(await code(() => startCharge(env.ctx, env.cashier, rid(), { orderId: cart.order.id, mode: 'UPI' })), 'TERMINAL_BUSY');
    const done = await waitFor(env, t.id, (s) => s !== 'PENDING');
    assert.equal(done.status, 'APPROVED');
    // every request was signed with the merchant key over the exact body text
    for (const r of srv.seen) { const bodyText = r.raw.slice(r.raw.indexOf('"body":') + 7, -1); assert.equal(verifyPaytmChecksum(bodyText, KEY, r.body.head.checksum), true, r.path); }
    const sale = srv.seen.find((r) => r.path === '/ecr/payment/request')!.body.body;
    assert.equal(sale.transactionAmount, String(cart.totals.grandTotal));
    assert.equal(sale.paytmTid, '12345678');
    assert.match(sale.merchantTransactionId, /^[A-Z0-9]{8,25}$/);

    assert.equal(openChargeFor(env.ctx, env.cashier, cart.order.id)!.id, t.id, 'after a reload the POS offers to finish the bill');
    const bill = completeCharge(env.ctx, env.cashier, rid(), t.id);
    assert.equal(bill.payments[0]!.mode, 'UPI');
    assert.match(bill.payments[0]!.reference!, /^Paytm Auth 7261A9 RRN 624615343002/);
    assert.equal(openChargeFor(env.ctx, env.cashier, cart.order.id), null);
    const day = new Date(env.clock.now() + 330 * 60_000).toISOString().slice(0, 10);
    const rep = runReport(env.ctx, env.manager, 'card-machines', { from: day, to: day });
    assert.equal(rep.rows[0]!.match, 'Matched to bill');
    assert.equal(rep.rows[0]!.invoiceNo, bill.invoice.invoiceNo);

    assert.equal(await code(() => voidCharge(env.ctx, env.cashier, rid(), t.id)), 'APPROVAL_REQUIRED');
    const v = voidCharge(env.ctx, env.manager, rid(), t.id);
    const vd = await waitFor(env, v.id, (s) => s !== 'PENDING', 20000);
    assert.equal(vd.status, 'APPROVED');
    assert.equal(runReport(env.ctx, env.manager, 'card-machines', { from: day, to: day }).rows[0]!.match, 'Reversed (void)');
  } finally { await srv.close(); env.cleanup(); }
});

test('Pine Labs over the internet: upload, "uploaded" means still waiting, approved with card details; a waiting payment is cancelled from the POS', async () => {
  const env = makeEnv();
  let polls = 0;
  const srv = await fakeServer((path, b) => {
    if (path.endsWith('/UploadBilledTransaction')) return { ResponseCode: 0, ResponseMessage: 'APPROVED', PlutusTransactionReferenceID: 701409 + (b.Amount % 7) };
    if (path.endsWith('/GetCloudBasedTxnStatus')) return ++polls < 3 ? { ResponseCode: 1001, ResponseMessage: 'TXN UPLOADED' }
      : { ResponseCode: 0, ResponseMessage: 'TXN APPROVED', TransactionData: [{ Tag: 'ApprovalCode', Value: '00123A' }, { Tag: 'RRN', Value: '998877665544' }, { Tag: 'Card Number', Value: '************4242' }, { Tag: 'Card Type', Value: 'VISA' }, { Tag: 'PaymentMode', Value: 'CARD' }] };
    if (path.endsWith('/CancelTransaction')) return { ResponseCode: 0, ResponseMessage: 'APPROVED' };
    return { ResponseCode: 1, ResponseMessage: 'UNKNOWN' };
  });
  try {
    startShift(env);
    const m = saveTerminal(env.ctx, env.owner, rid(), null, { name: 'Pine Labs', provider: 'pinelabs', connection: 'cloud', modes: ['CARD'], config: { merchantId: '1234', storeId: '61607', clientId: '307639', env: 'test' }, secret: 'token-abc' });
    useMachine(env, () => new PineCloud(m.config as never, 'token-abc', srv.f));
    const cart = cartOf(env, [['Cheese Burger']]);
    const t = startCharge(env.ctx, env.cashier, rid(), { orderId: cart.order.id, mode: 'CARD' });
    const done = await waitFor(env, t.id, (s) => s !== 'PENDING');
    assert.equal(done.status, 'APPROVED');
    assert.equal(done.result?.cardLast4, '4242');
    const up = srv.seen.find((r) => r.path.endsWith('/UploadBilledTransaction'))!.body;
    assert.deepEqual([up.MerchantID, up.SecurityToken, up.StoreId, up.ClientId, up.AllowedPaymentMode, up.Amount], [1234, 'token-abc', 61607, 307639, '1', cart.totals.grandTotal]);
    const bill = completeCharge(env.ctx, env.cashier, rid(), t.id);
    assert.equal(bill.payments[0]!.mode, 'CARD');
    assert.match(bill.payments[0]!.reference!, /Pine Labs Auth 00123A RRN 998877665544 \*4242/);

    // a second customer walks away: cancelled from the POS
    polls = -1000; // stays "uploaded"
    const cart2 = cartOf(env, [['Brownie']]);
    const t2 = startCharge(env.ctx, env.cashier, rid(), { orderId: cart2.order.id, mode: 'CARD' });
    await new Promise((r) => setTimeout(r, 50));
    const c = await cancelCharge(env.ctx, env.cashier, t2.id);
    assert.equal(c.status, 'CANCELLED');
    assert.ok(srv.seen.some((r) => r.path.endsWith('/CancelTransaction') && r.body.PlutusTransactionReferenceID));
  } finally { await srv.close(); env.cleanup(); }
});

/** A stand-in for Pine Labs' PAD Controller: checks the documented frame, answers from a handler. */
async function fakeController(answer: (csv: string) => string) {
  const got: string[] = [];
  const s = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 6) return;
      const len = buf.readUInt16BE(4);
      if (buf.length < 6 + len + 1) return;
      assert.equal(buf.readUInt16BE(0), 0x1000); assert.equal(buf.readUInt16BE(2), 0x0997); assert.equal(buf[6 + len], 0xff);
      const csv = buf.subarray(6, 6 + len).toString('latin1');
      got.push(csv);
      const data = Buffer.from(answer(csv), 'latin1');
      const out = Buffer.alloc(8 + data.length + 1);
      out.writeUInt16BE(0x1000, 0); out.writeUInt16BE(0x0997, 2); out.writeUInt16BE(0x0001, 4); out.writeUInt16BE(data.length, 6); data.copy(out, 8); out[out.length - 1] = 0xff;
      sock.write(out);
    });
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return { got, port: (s.address() as net.AddressInfo).port, close: () => new Promise<void>((r) => s.close(() => r())) };
}

test('Pine Labs by cable (PAD Controller, port 8082 frame): approved sale and void; a decline; the controller not running', async () => {
  assert.deepEqual([...frame('4001,TX1,100,,,,,,,')].slice(0, 6), [0x10, 0x00, 0x09, 0x97, 0x00, 19]);
  assert.deepEqual(csvFields('105,"7261A9","APPROVED"," ************2802"'), ['105', '7261A9', 'APPROVED', '************2802']);
  const env = makeEnv();
  let decline = false;
  const ctl = await fakeController((csv) => csv.startsWith('4006,') ? 'APPROVED'
    : decline ? '105,"","DECLINED","","","","",0,0,"30000001",1,"CARD DECLINED"'
    : '105,"7261A9","APPROVED"," ************2802","0406","CUSTOMER","VISA",000013,2,"30000001",1,"PROCESSED","HDFC BANK","000100090015607"," 624615343002",1,1," SHOP"," Road"," City","1.51",01');
  try {
    startShift(env);
    const m = saveTerminal(env.ctx, env.owner, rid(), null, { name: 'Pine cable', provider: 'pinelabs', connection: 'wired', modes: ['CARD'], config: { host: '127.0.0.1', port: ctl.port } });
    assert.equal(await code(() => saveTerminal(env.ctx, env.owner, rid(), null, { name: 'x', provider: 'pinelabs', connection: 'wired', modes: ['UPI'], config: { host: '127.0.0.1' } })), 'VALIDATION');
    useMachine(env, () => new PineWired(m.config as never));
    assert.equal((await new PineWired({ host: '127.0.0.1', port: ctl.port }).check()).ok, true);
    const cart = cartOf(env, [['Masala Chai']]);
    const t = startCharge(env.ctx, env.cashier, rid(), { orderId: cart.order.id, mode: 'CARD' });
    const done = await waitFor(env, t.id, (s) => s !== 'PENDING');
    assert.equal(done.status, 'APPROVED');
    assert.deepEqual([done.result?.approvalCode, done.result?.cardLast4, done.result?.rrn, done.result?.invoiceNo], ['7261A9', '2802', '624615343002', '000013']);
    assert.match(ctl.got[0]!, new RegExp(`^4001,TP[A-Z0-9]+,${cart.totals.grandTotal},,,,,,,$`));
    completeCharge(env.ctx, env.cashier, rid(), t.id);
    const v = voidCharge(env.ctx, env.manager, rid(), t.id);
    assert.equal((await waitFor(env, v.id, (s) => s !== 'PENDING')).status, 'APPROVED');
    assert.match(ctl.got[1]!, new RegExp(`^4006,TP[A-Z0-9]+,${cart.totals.grandTotal},01,,,000013,`));

    decline = true;
    const cart2 = cartOf(env, [['Brownie']]);
    const t2 = startCharge(env.ctx, env.cashier, rid(), { orderId: cart2.order.id, mode: 'CARD' });
    const d2 = await waitFor(env, t2.id, (s) => s !== 'PENDING');
    assert.equal(d2.status, 'FAILED');
    assert.match(d2.message!, /DECLINED/);
    assert.equal((await new PineWired({ host: '127.0.0.1', port: 1 }).check()).ok, false);
  } finally { await ctl.close(); env.cleanup(); }
});

test('Paytm by USB cable (Windows): Paytm\'s library is called from a constant script with values in environment variables; other systems are told plainly', async () => {
  const lib = mkdtempSync(join(tmpdir(), 'paytm-lib-'));
  writeFileSync(join(lib, 'PaytmPayments_v1.0.0.9.dll'), 'stand-in');
  const env = makeEnv();
  const calls: Array<{ script: string; env: Record<string, string> }> = [];
  const runner = async (r: { script: string; env?: Record<string, string> }) => {
    calls.push({ script: r.script, env: r.env ?? {} });
    const op = r.env?.PAYTM_OP;
    const out = op === 'CHECK' ? { statusCode: '000', statusMessage: 'Command Initiated Successfully', version: '1.1.0' }
      : { statusCode: '101', statusMessage: 'Transaction was successful', txnId: 'T-9', authCode: 'A55', rrn: '112233445566', cardNo: '4111XXXXXXXX1111', payMethod: 'DEBIT_CARD', cardScheme: 'VISA' };
    return { code: 0, stdout: JSON.stringify(out), stderr: '' };
  };
  try {
    startShift(env);
    const m = saveTerminal(env.ctx, env.owner, rid(), null, { name: 'Paytm USB', provider: 'paytm', connection: 'wired', modes: ['CARD', 'UPI'], config: { mid: 'TEST123', comPort: 'COM4', libFolder: lib, baud: 115200 } });
    assert.equal(await code(() => saveTerminal(env.ctx, env.owner, rid(), null, { name: 'x', provider: 'paytm', connection: 'wired', modes: ['CARD'], config: { mid: 'T', comPort: 'USB4', libFolder: lib } })), 'VALIDATION');
    useMachine(env, () => new PaytmWired(m.config as never, runner, 'win32'));
    assert.equal((await new PaytmWired(m.config as never, runner, 'win32').check()).ok, true);
    const cart = cartOf(env, [['Cold Coffee']]);
    const t = startCharge(env.ctx, env.cashier, rid(), { orderId: cart.order.id, mode: 'CARD' });
    const done = await waitFor(env, t.id, (s) => s !== 'PENDING');
    assert.equal(done.status, 'APPROVED');
    const sale = calls.find((c) => c.env.PAYTM_OP === 'SALE')!;
    assert.deepEqual([sale.env.PAYTM_PORT, sale.env.PAYTM_AMOUNT, sale.env.PAYTM_MODE, sale.env.PAYTM_MID], ['COM4', String(cart.totals.grandTotal), 'CARD', 'TEST123']);
    assert.ok(!sale.script.includes('TEST123') && !sale.script.includes('COM4'), 'no shop value is written into the script');
    const paid = completeCharge(env.ctx, env.cashier, rid(), t.id);
    assert.equal(paid.payments[0]!.mode, 'CARD');
    assert.equal(await code(() => correctPaymentMode(env.ctx, env.manager, rid(), { paymentId: paid.payments[0]!.id, toMode: 'CASH', reason: 'try to change' })), 'MACHINE_PAYMENT', 'a machine payment\'s mode is not changed by hand');
    assert.match((await new PaytmWired(m.config as never, runner, 'linux').check()).message, /Windows POS/);
    assert.match((await new PaytmWired({ ...(m.config as object), libFolder: join(lib, 'missing') } as never, runner, 'win32').check()).message, /not in/);
  } finally { env.cleanup(); rmSync(lib, { recursive: true, force: true }); }
});

test('safety: a cable machine that stops answering is UNCLEAR (never "failed"), a restart does the same, the bill cannot change after approval, owner-only setup, keys never shown', async () => {
  const env = makeEnv();
  try {
    startShift(env);
    assert.equal(await code(() => saveTerminal(env.ctx, env.manager, rid(), null, paytmCloudInput)), 'FORBIDDEN');
    const m = saveTerminal(env.ctx, env.owner, rid(), null, paytmCloudInput);
    assert.equal(m.hasSecret, true);
    assert.ok(!JSON.stringify(listTerminals(env.ctx, env.cashier)).includes(KEY));
    assert.ok(!JSON.stringify(allSettings(env.ctx)).includes(KEY));
    assert.equal(await code(() => saveTerminal(env.ctx, env.owner, rid(), null, { ...paytmCloudInput, secret: null, config: { ...paytmCloudInput.config, env: 'live' } })), 'VALIDATION');

    // a cable machine whose answer is lost
    const lost: Connector = { start: async () => { throw new Error('The machine did not answer in time. Check its screen.'); }, check: async () => ({ ok: true, message: '' }) };
    const w = saveTerminal(env.ctx, env.owner, rid(), null, { name: 'cable', provider: 'pinelabs', connection: 'wired', modes: ['CARD'], config: { host: '127.0.0.1' }, isDefault: true });
    setConnectorFactory(env.ctx, () => lost, { pollMs: 10, waitMs: 500 });
    const cart = cartOf(env, [['Masala Chai']]);
    const t = startCharge(env.ctx, env.cashier, rid(), { orderId: cart.order.id, mode: 'CARD', terminalId: w.id });
    assert.equal((await waitFor(env, t.id, (s) => s !== 'PENDING')).status, 'UNKNOWN');
    assert.equal(await code(() => recheckCharge(env.ctx, env.cashier, t.id)), 'CHECK_ON_MACHINE');

    // the POS restarts while a cable machine waits
    const hang: Connector = { start: () => new Promise(() => {}), check: async () => ({ ok: true, message: '' }) };
    setConnectorFactory(env.ctx, () => hang);
    const cart2 = cartOf(env, [['Brownie']]);
    const t2 = startCharge(env.ctx, env.cashier, rid(), { orderId: cart2.order.id, mode: 'CARD', terminalId: w.id });
    resumeCharges(env.ctx);
    assert.equal(getTxn(env.ctx, env.cashier, t2.id).status, 'UNKNOWN');

    // approved, then someone adds an item: the bill is not saved with the old amount
    const ok: Connector = { start: async () => ({ status: 'APPROVED', message: 'APPROVED', approvalCode: 'X1' }), check: async () => ({ ok: true, message: '' }) };
    setConnectorFactory(env.ctx, () => ok);
    const cart3 = cartOf(env, [['Masala Chai']]);
    const t3 = startCharge(env.ctx, env.cashier, rid(), { orderId: cart3.order.id, mode: 'CARD', terminalId: w.id });
    await waitFor(env, t3.id, (s) => s === 'APPROVED');
    assert.equal(await code(() => startCharge(env.ctx, env.cashier, rid(), { orderId: cart3.order.id, mode: 'CARD' })), 'ALREADY_PAID_ON_MACHINE');
    addLine(env.ctx, env.cashier, rid(), { orderId: cart3.order.id, itemId: env.items['Brownie']! });
    assert.equal(await code(() => completeCharge(env.ctx, env.cashier, rid(), t3.id)), 'AMOUNT_CHANGED');
    assert.equal(get<{ n: number }>(env.ctx.db, "SELECT count(*) n FROM invoice WHERE order_id = ?", cart3.order.id)!.n, 0);
    const day = new Date(env.clock.now() + 330 * 60_000).toISOString().slice(0, 10);
    const rep = runReport(env.ctx, env.manager, 'card-machines', { from: day, to: day });
    assert.equal(rep.summary.find((s) => s.label === 'Approved without a bill')!.value, 1);
    assert.equal(rep.summary.find((s) => s.label === 'Unclear (check the machine)')!.value, 2);
    assert.equal(all(env.ctx.db, 'SELECT 1 FROM terminal_txn').length, 3);
  } finally { env.cleanup(); }
});
