// Drives the billing and printing parts of the UI client against a real backend (in-process, temporary database).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createServer, listen } from '../../src/http/server.ts';
import { PrintQueue } from '../../src/services/printing/queue.ts';
import { MemoryTransport } from '../../src/services/printing/transports.ts';
import { makeEnv } from '../../test/helpers.ts';
import { ApiError, createApi, newKey } from '../src/lib/api.ts';

async function start() {
  const env = makeEnv({ seed: true });
  env.clock.t = Date.now();
  const mem = new MemoryTransport();
  const queue = new PrintQueue(env.ctx, { memory: mem }, [0, 0, 0]);
  const server: Server = createServer(env.ctx, { queue });
  const port = await listen(server, 0);
  let token: string | null = null;
  const api = createApi({ baseUrl: `http://127.0.0.1:${port}`, getToken: () => token, retryDelayMs: 1 });
  const signIn = async (name: string, pin: string) => { const u = (await api.loginUsers()).find((x) => x.name === name)!; token = (await api.login({ userId: u.id }, pin)).token; return u; };
  const close = () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); env.cleanup(); });
  return { env, api, queue, mem, signIn, close };
}
const is = (code: string) => (e: unknown) => e instanceof ApiError && e.code === code;

test('UI client: printers — add USB / Wi-Fi / Bluetooth printers, edit, test print, turn off, remove', async () => {
  const s = await start(); try {
    await s.signIn('Cashier', '1111');
    await assert.rejects(s.api.createPrinter({ name: 'X', transport: 'tcp', address: '10.0.0.5', widthMm: 80, isReceipt: false, drawer: false, stations: [] }), is('FORBIDDEN'));
    await s.signIn('Manager', '2345');
    const usb = await s.api.createPrinter({ name: 'Counter USB', transport: 'spooler', address: 'EPSON TM-T82 Receipt', widthMm: 80, isReceipt: true, drawer: true, stations: [] });
    const wifi = await s.api.createPrinter({ name: 'Kitchen Wi-Fi', transport: 'tcp', address: '192.168.1.60', widthMm: 80, isReceipt: false, drawer: false, stations: ['kitchen'] });
    const bt = await s.api.createPrinter({ name: 'Bluetooth 58', transport: 'serial', address: 'com6', widthMm: 58, isReceipt: false, drawer: false, stations: ['bar'] });
    await assert.rejects(s.api.createPrinter({ name: 'Bad', transport: 'serial', address: 'COM6;calc', widthMm: 58, isReceipt: false, drawer: false, stations: [] }), is('VALIDATION'));
    let list = await s.api.printers();
    assert.equal(list.find((p) => p.id === bt.id)!.address, 'COM6'); // normalised
    assert.deepEqual(list.find((p) => p.id === wifi.id)!.stats, { queued: 0, failed: 0, lastError: null, lastPrintedAt: null });

    await s.api.updatePrinter(wifi.id, { address: '192.168.1.61:9100', stations: ['kitchen', 'bar'] });
    list = await s.api.printers();
    assert.deepEqual(list.find((p) => p.id === wifi.id)!.stations, ['kitchen', 'bar']);
    const t = await s.api.testPrint(usb.id);
    assert.ok(t.jobId);
    const off = await s.api.updatePrinter(usb.id, { active: false });
    assert.equal(off.released, 1); // the queued test page is released as failed
    assert.deepEqual(await s.api.deletePrinter(bt.id), { id: bt.id, removed: true, deactivated: false });
    assert.deepEqual(await s.api.deletePrinter(usb.id), { id: usb.id, removed: false, deactivated: true });
    assert.ok(Array.isArray(await s.api.windowsPrinters()));
    assert.ok(Array.isArray(await s.api.serialPorts()));
  } finally { await s.close(); }
});

test('UI client: billing reports printing, shows the exact receipt, and tracks each print job', async () => {
  const s = await start(); try {
    await s.signIn('Cashier', '1111');
    await s.api.openShift(0);
    const cat = await s.api.catalog();
    const burger = cat.items.find((i) => i.name === 'Cheese Burger')!;
    let cart = await s.api.createOrder();
    cart = await s.api.addLine(cart.order.id, burger.id);
    const r = await s.api.finalize(cart.order.id, [{ mode: 'CASH', amount: cart.totals.grandTotal, tendered: 20000 }]);
    assert.deepEqual(r.print, { receipts: 1, kitchenTickets: 1, warnings: [] });
    const pv = await s.api.receiptPreview(r.invoice.id, 58);
    assert.equal(pv.cols, 32);
    assert.ok(pv.lines.some((l) => l.includes('Cheese Burger')) && pv.lines.every((l) => l.length <= 32));
    assert.ok((await s.api.invoicePrints(r.invoice.id)).every((j) => j.status === 'QUEUED'));
    await s.queue.processDue();
    const jobs = await s.api.invoicePrints(r.invoice.id);
    assert.deepEqual(jobs.map((j) => j.status), ['PRINTED', 'PRINTED']);
    assert.ok(jobs.some((j) => j.printerName === 'Counter receipt (virtual)'));
  } finally { await s.close(); }
});

test('UI client: split payment checked by the backend, hold and resume, cancel and refund with approval', async () => {
  const s = await start(); try {
    const mgr = { userId: (await s.signIn('Manager', '2345')).id, pin: '2345' };
    await s.signIn('Cashier', '1111');
    await s.api.openShift(0);
    const cat = await s.api.catalog();
    const id = (n: string) => cat.items.find((i) => i.name === n)!.id;

    // hold one bill, start another, then resume the first
    let a = await s.api.createOrder();
    a = await s.api.addLine(a.order.id, id('Brownie'));
    await s.api.updateOrder(a.order.id, { customerPhone: '9000000001', note: 'Table 2' });
    await s.api.holdOrder(a.order.id);
    const held = await s.api.openOrders('HELD');
    assert.deepEqual([held.length, held[0]!.grandTotal, held[0]!.note], [1, 8900, 'Table 2']);
    a = await s.api.resumeOrder(a.order.id);
    assert.equal(a.order.status, 'DRAFT');

    // split: Rs 89 = Rs 50 UPI + Rs 39 cash from Rs 50
    a = await s.api.addLine(a.order.id, id('Cheese Burger')); // now Rs 218
    const part = await s.api.checkPayments(a.order.id, [{ mode: 'UPI', amount: 10000 }]);
    assert.deepEqual([part.remaining, part.ok], [11800, false]);
    const split = [{ mode: 'UPI' as const, amount: 10000 }, { mode: 'CASH' as const, amount: part.remaining, tendered: 20000 }];
    const ok = await s.api.checkPayments(a.order.id, split);
    assert.deepEqual([ok.ok, ok.changeDue], [true, 8200]);
    const bill = await s.api.finalize(a.order.id, split, newKey());
    assert.equal(bill.payments.length, 2);
    assert.equal(bill.changeDue, 8200);

    // refund one brownie: preview == credit note; needs a manager
    const opts = await s.api.creditOptions(bill.invoice.id);
    const brownie = opts.lines.find((l) => l.name === 'Brownie')!;
    const pv = await s.api.previewCredit(bill.invoice.id, [{ invoiceLineId: brownie.invoiceLineId, qtyMilli: 1000 }]);
    await assert.rejects(s.api.createCredit(bill.invoice.id, { lines: [{ invoiceLineId: brownie.invoiceLineId, qtyMilli: 1000 }], reason: 'Returned', refunds: [{ mode: 'CASH', amount: pv.total }] }), is('APPROVAL_REQUIRED'));
    const cn = await s.api.createCredit(bill.invoice.id, { lines: [{ invoiceLineId: brownie.invoiceLineId, qtyMilli: 1000 }], reason: 'Returned', refunds: [{ mode: 'CASH', amount: pv.total }] }, mgr);
    assert.equal(cn.invoice.grandTotal, pv.total);
    assert.equal(cn.invoice.docType, 'CREDIT_NOTE');

    // cancel another bill made by mistake
    let b = await s.api.createOrder();
    b = await s.api.addLine(b.order.id, id('Masala Chai'));
    const wrong = await s.api.finalize(b.order.id, [{ mode: 'CASH', amount: b.totals.grandTotal }]);
    await assert.rejects(s.api.cancelInvoice(wrong.invoice.id, 'Wrong item'), is('APPROVAL_REQUIRED'));
    assert.equal((await s.api.cancelInvoice(wrong.invoice.id, 'Wrong item', mgr)).status, 'CANCELLED');
  } finally { await s.close(); }
});

test('UI client: plug and play — detection list, "not now", and one-tap setup needs a manager and a plugged-in printer', async () => {
  const s = await start(); try {
    await s.signIn('Cashier', '1111');
    const found = await s.api.detectedPrinters();
    assert.ok(Array.isArray(found)); // this PC has no USB receipt printer; a shop PC lists it here after plugging in
    await assert.rejects(s.api.quickAddPrinter('usb:0416:5011'), is('APPROVAL_REQUIRED'));
    const mgr = (await s.api.loginUsers()).find((u) => u.name === 'Manager')!;
    await assert.rejects(s.api.quickAddPrinter('usb:0416:5011', { userId: mgr.id, pin: '2345' }), is('NOT_FOUND'));
    assert.deepEqual(await s.api.dismissDetected('usb:0416:5011'), { key: 'usb:0416:5011' });
    await assert.rejects(s.api.dismissDetected('../../etc'), is('VALIDATION'));
    await s.signIn('Manager', '2345');
    const usb = await s.api.createPrinter({ name: 'Direct USB', transport: 'usb', address: '0416:5011', widthMm: 58, isReceipt: false, drawer: false, stations: [] });
    assert.equal((await s.api.printers()).find((p) => p.id === usb.id)!.transport, 'usb');
    await assert.rejects(s.api.createPrinter({ name: 'Bad USB', transport: 'usb', address: 'USB001', widthMm: 58, isReceipt: false, drawer: false, stations: [] }), is('VALIDATION'));
  } finally { await s.close(); }
});

test('UI client: printer setup screen — plugged-in USB list, sample bill, cash drawer test, retry failed, receipt footer, data speed', async () => {
  const s = await start(); try {
    await s.signIn('Manager', '2345');
    const usb = await s.api.usbDevices(true);
    assert.ok(Array.isArray(usb.devices)); // empty on a PC with no USB printer; lists plugged-in printers on a shop PC
    const printers = await s.api.printers();
    const counter = printers.find((p) => p.isReceipt)!;
    assert.ok((await s.api.printSample(counter.id)).jobId);
    assert.ok((await s.api.testDrawer(counter.id)).jobId);
    await s.queue.processDue();
    assert.ok(s.mem.sent.length >= 2);
    await s.api.updatePrinter(counter.id, { profile: 'slow_buffer' });
    assert.equal((await s.api.printers()).find((p) => p.id === counter.id)!.profile, 'slow_buffer');
    await assert.rejects(s.api.updatePrinter(counter.id, { profile: 'turbo' }), is('VALIDATION'));
    assert.deepEqual(await s.api.retryFailed(counter.id), { printerId: counter.id, requeued: 0 });
    // the footer is the owner's; the sample shows it
    await assert.rejects(s.api.saveSettings({ receipt_footer: 'x' }), is('FORBIDDEN'));
    await s.signIn('Owner', '1234');
    await s.api.saveSettings({ receipt_footer: 'Order online at demoburger.in' });
    const sample = await s.api.sampleReceipt(58);
    assert.ok(sample.lines.some((l) => l.includes('SAMPLE - NOT A BILL')) && sample.lines.some((l) => l.includes('demoburger.in')));
    assert.ok(sample.lines.every((l) => l.length <= 32));
    await s.signIn('Cashier', '1111');
    await assert.rejects(s.api.printSample(counter.id), is('FORBIDDEN'));
  } finally { await s.close(); }
});
