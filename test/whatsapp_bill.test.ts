import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { cancelInvoice, createCreditNote } from '../src/services/invoices.ts';
import { allSettings, setSetting } from '../src/services/settings.ts';
import { syncSales } from '../src/services/salesSync.ts';
import { receiptPreview } from '../src/services/printing/jobs.ts';
import { buildReceipt, sampleReceiptData } from '../src/services/printing/receipt.ts';
import { parseEscPos } from '../src/services/printing/virtual.ts';
import { parseTemplate } from '../src/services/printing/receiptTemplate.ts';
import { indianMobile, sendBillOnWhatsApp, shareCode, whatsappQrFor, whatsappStatus } from '../src/services/whatsappBill.ts';
import { NO_HUB, loadCloudHub } from './cloudHub.ts';
import { makeEnv, quickBill, rid, startShift } from './helpers.ts';

// Bills on WhatsApp (src/services/whatsappBill.ts): the QR on the bill, the bill sent up with the sales sync, and
// "Send on WhatsApp", against the real PosiNext Cloud hub (posinext-cloud hub/src/whatsapp-bills.ts).

const { Hub, createHubServer } = await loadCloudHub();
const META = { provider: 'meta', number: '919845012345', phoneNumberId: '1234567890', accessToken: 'EAAG' + 'x'.repeat(40), appSecret: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', codes: 'off', billTemplate: 'bill_pdf' };

async function cloud() {
  const dir = mkdtempSync(join(tmpdir(), 'hub-wa-'));
  const sent: Array<Record<string, unknown>> = [];
  const waFetch = (async (_url: string, init: RequestInit) => { sent.push(JSON.parse(String(init.body))); return new Response('{"messages":[{"id":"x"}]}', { status: 200 }); }) as unknown as typeof fetch;
  const hub = new Hub({ dbPath: join(dir, 'hub.db'), waFetch });
  const server: Server = createHubServer(hub, {});
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const store = hub.createStore('chai-point', 'Chai Point');
  const key = hub.pair(store.pairingCode, 'POS').deviceKey as string;
  const close = async () => { await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }); hub.close(); rmSync(dir, { recursive: true, force: true }); };
  return { hub, url, key, sent, close };
}

const qrLines = (lines: string[]) => lines.filter((l) => /WhatsApp|\[QR code\]/.test(l)).map((l) => l.trim());

test('WhatsApp QR on the receipt: only when given; never on a cancelled bill or a credit note; a design can place it', () => {
  const d = { ...sampleReceiptData({ name: 'Chai Point', address: null, gstin: null, fssaiNo: null, phone: null }, Date.now()), payments: [] };
  d.invoice.id = 'inv-1';
  const base = { cols: 32, copyNo: 1, footer: 'Thank you', drawer: false };
  const url = (id: string) => `https://cloud.example/wa/bill/${id === 'inv-1' ? 'ABCDEFGH2345' : 'X'}`;
  assert.deepEqual(qrLines(parseEscPos(buildReceipt(d, base)).lines), []);
  const on = parseEscPos(buildReceipt(d, { ...base, whatsappQr: url })).lines;
  assert.deepEqual(qrLines(on), ['Get this bill on WhatsApp', '[QR code]']);
  assert.ok(on.findIndex((l) => l.includes('WhatsApp')) > on.findIndex((l) => l.includes('Thank you')), 'at the bottom, after the footer');
  assert.ok(Buffer.from(buildReceipt(d, { ...base, whatsappQr: url })).toString('latin1').includes('https://cloud.example/wa/bill/ABCDEFGH2345'));
  assert.deepEqual(qrLines(parseEscPos(buildReceipt({ ...d, invoice: { ...d.invoice, status: 'CANCELLED' } }, { ...base, whatsappQr: url })).lines), []);
  assert.deepEqual(qrLines(parseEscPos(buildReceipt({ ...d, invoice: { ...d.invoice, docType: 'CREDIT_NOTE' } }, { ...base, whatsappQr: url })).lines), []);

  // a design with its own WhatsApp block: printed there, once
  const raw = { format: 'tiffin-receipt', version: 1, name: 'With WhatsApp', blocks: [
    { type: 'text', text: '{{outlet.name}}', align: 'center' }, { type: 'text', text: 'GSTIN: {{outlet.gstin}}' }, { type: 'doc-title' }, { type: 'field', label: 'Bill', value: '{{invoice.no}}' },
    { type: 'field', label: 'Date', value: '{{invoice.date}}' }, { type: 'qr', data: 'whatsapp', size: 4 }, { type: 'items', columns: [{ field: 'name' }, { field: 'qty' }, { field: 'amount' }] },
    { type: 'totals', rows: ['subtotal', 'gst', 'roundoff'] }, { type: 'grand-total' }, { type: 'footer' },
  ] };
  const v = parseTemplate(JSON.stringify(raw));
  assert.ok(v.ok, JSON.stringify(v));
  const placed = parseEscPos(buildReceipt(d, { ...base, template: v.ok ? v.template : null, whatsappQr: url })).lines;
  assert.deepEqual(qrLines(placed), ['Get this bill on WhatsApp', '[QR code]']);
  assert.ok(placed.findIndex((l) => l.includes('WhatsApp')) < placed.findIndex((l) => /TOTAL/.test(l)), 'where the design put it');
});

test('bills on WhatsApp: the QR needs the setting and the cloud link; the bill goes up with the sync; Send on WhatsApp', { skip: NO_HUB }, async () => {
  const env = makeEnv(), c = await cloud();
  try {
    startShift(env);
    const names = Object.keys(env.items);
    const a = quickBill(env, [[names[0]!, 2000], [names[1]!]], 'UPI');
    assert.equal(whatsappQrFor(env.ctx), null, 'off by default');
    setSetting(env.ctx, 'whatsapp_bill_qr', '1');
    assert.equal(whatsappQrFor(env.ctx), null, 'on, but not linked');
    assert.deepEqual(await whatsappStatus(env.ctx, env.cashier), { linked: false, bills: false });
    await assert.rejects(sendBillOnWhatsApp(env.ctx, env.cashier, { invoiceId: a.invoice.id, mobile: '9876543210' }), { code: 'NOT_LINKED' });

    setSetting(env.ctx, 'cloud_backup_url', c.url);
    setSetting(env.ctx, 'cloud_backup_key', c.key);
    const code = shareCode(env.ctx, a.invoice.id);
    assert.match(code, /^[A-HJ-NP-Z2-9]{12}$/);
    assert.equal(shareCode(env.ctx, a.invoice.id), code, 'the same every time');
    assert.ok(!JSON.stringify(allSettings(env.ctx)).includes('whatsapp_bill_secret'), 'the secret never leaves the backend');
    assert.equal(whatsappQrFor(env.ctx)!(a.invoice.id), `${c.url}/wa/bill/${code}`);
    assert.deepEqual(qrLines(receiptPreview(env.ctx, a.invoice.id, 80).lines), ['Get this bill on WhatsApp', '[QR code]']);

    // the bill goes up with bill.printed; the cloud keeps it for the QR
    const b = quickBill(env, [[names[0]!]], 'CASH');
    assert.equal(await syncSales(env.ctx), 2);
    const kept = c.hub.whatsapp.bill(shareCode(env.ctx, b.invoice.id)).doc;
    assert.equal(kept.billNo, b.invoice.invoiceNo);
    assert.equal(kept.totalPaise, b.invoice.grandTotal);
    assert.deepEqual(kept.payments, [{ mode: 'Cash', amountPaise: b.invoice.grandTotal }]);
    // prices include GST here: the tax lines say so, and subtotal - discount + round off is the total, as printed
    const added = kept.summary.filter((x: { label: string }) => !/included/.test(x.label)).reduce((s: number, x: { amountPaise: number }) => s + x.amountPaise, 0);
    assert.equal(added, kept.totalPaise, 'the printed figures add up');
    assert.ok(kept.summary.some((x: { label: string }) => /^CGST @.*\(included\)$/.test(x.label)));
    const page = await fetch(`${c.url}/b/${shareCode(env.ctx, b.invoice.id)}`);
    assert.match(await page.text(), new RegExp(b.invoice.invoiceNo.replace(/[/]/g, '\\/')));

    // Send on WhatsApp: refused until the cloud has a bill template; then sent with the PDF
    assert.deepEqual(await whatsappStatus(env.ctx, env.cashier), { linked: true, bills: false });
    await assert.rejects(sendBillOnWhatsApp(env.ctx, env.cashier, { invoiceId: a.invoice.id, mobile: '9876543210' }), (e: { code: string; message: string }) => e.code === 'WHATSAPP_FAILED' && /not set up/.test(e.message));
    c.hub.whatsapp.save(META);
    assert.deepEqual(await whatsappStatus(env.ctx, env.cashier), { linked: true, bills: true });
    await assert.rejects(sendBillOnWhatsApp(env.ctx, env.cashier, { invoiceId: a.invoice.id, mobile: '12345' }), { code: 'VALIDATION' });
    const r = await sendBillOnWhatsApp(env.ctx, env.cashier, { invoiceId: a.invoice.id, mobile: '+91 98765 43210' });
    assert.deepEqual(r, { sent: true, to: '98******10', invoiceNo: a.invoice.invoiceNo });
    const t = c.sent.at(-1) as { to: string; template: { name: string; components: Array<{ type: string; parameters: Array<Record<string, any>> }> } };
    assert.equal(t.to, '919876543210');
    assert.equal(t.template.name, 'bill_pdf');
    assert.match(t.template.components[0]!.parameters[0]!.document.link, new RegExp(`/b/${code}\\.pdf$`));
    assert.deepEqual(t.template.components[1]!.parameters.map((p) => p.text), [c.hub.whatsapp.bill(code).doc.store.name, a.invoice.invoiceNo, (a.invoice.grandTotal / 100).toFixed(2)]);

    // cancelled bills and credit notes are never sent
    cancelInvoice(env.ctx, env.owner, rid(), { invoiceId: b.invoice.id, reason: 'Wrong item' });
    await assert.rejects(sendBillOnWhatsApp(env.ctx, env.cashier, { invoiceId: b.invoice.id, mobile: '9876543210' }), { code: 'VALIDATION' });
    const cn = createCreditNote(env.ctx, env.owner, rid(), { invoiceId: a.invoice.id, lines: [{ invoiceLineId: a.lines[1]!.id, qtyMilli: 1000 }], reason: 'Returned', refunds: [{ mode: 'UPI', amount: a.lines[1]!.lineTotal }] });
    await assert.rejects(sendBillOnWhatsApp(env.ctx, env.cashier, { invoiceId: cn.invoice.id, mobile: '9876543210' }), { code: 'VALIDATION' });
    assert.equal(await syncSales(env.ctx), 2, 'the cancellation and the credit note go up as before');
  } finally { await c.close(); env.cleanup(); }
});

test('mobile numbers', () => {
  assert.equal(indianMobile('+91 98765 43210'), '9876543210');
  assert.equal(indianMobile('09876543210'), '9876543210');
  assert.equal(indianMobile('5876543210'), null);
  assert.equal(indianMobile('98765'), null);
});
