import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { all, get } from '../src/store/db.ts';
import { cancelInvoice, createCreditNote } from '../src/services/invoices.ts';
import { adjustStock, createPurchase, createStockItem, voidPurchase } from '../src/services/stock.ts';
import { getSetting, setSetting } from '../src/services/settings.ts';
import { salesSyncStatus, setSalesSync, syncSales } from '../src/services/salesSync.ts';
import { NO_HUB, loadCloudHub } from './cloudHub.ts';
import { makeEnv, quickBill, rid, startShift } from './helpers.ts';

// Sales sync (src/services/salesSync.ts) against the real PosiNext Cloud hub: bills go up once, in order, and the
// portal's analytics add them up; nothing is sent before the POS is linked, while it is off, or twice.

const { Hub, createHubServer } = await loadCloudHub();

async function cloud() {
  const dir = mkdtempSync(join(tmpdir(), 'hub-sales-'));
  const hub = new Hub({ dbPath: join(dir, 'hub.db') });
  const server: Server = createHubServer(hub, {});
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const store = hub.createStore('chai-point', 'Chai Point');
  const key = hub.pair(store.pairingCode, 'POS').deviceKey as string;
  const bills = () => hub.db.prepare('SELECT bill_id, kind, total, voided, terminal, order_type, channel, tax, lines_json, tenders_json FROM sale_bill ORDER BY at, bill_id').all() as Array<Record<string, unknown>>;
  const close = async () => { await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }); hub.close(); rmSync(dir, { recursive: true, force: true }); };
  return { hub, url, key, bills, close };
}

test('sales sync: nothing is sent until the POS is linked; then each bill goes up once with its items, payment and counter', { skip: NO_HUB }, async () => {
  const env = makeEnv(), c = await cloud();
  try {
    startShift(env);
    const names = Object.keys(env.items);
    const a = quickBill(env, [[names[0]!, 2000], [names[1]!]], 'UPI');
    assert.equal(await syncSales(env.ctx), 0, 'not linked: nothing leaves the POS');
    assert.deepEqual([salesSyncStatus(env.ctx).linked, salesSyncStatus(env.ctx).pending], [false, 1]);

    setSetting(env.ctx, 'cloud_backup_url', c.url);
    setSetting(env.ctx, 'cloud_backup_key', c.key);
    setSalesSync(env.ctx, false);
    assert.equal(await syncSales(env.ctx), 0, 'switched off');
    setSalesSync(env.ctx, true);
    assert.equal(await syncSales(env.ctx), 1);
    assert.equal(await syncSales(env.ctx), 0, 'nothing new');

    const up = c.bills();
    assert.equal(up.length, 1);
    const counter = get<{ name: string }>(env.ctx.db, 'SELECT name FROM device')!.name;
    assert.deepEqual([up[0]!.bill_id, up[0]!.total, up[0]!.terminal, up[0]!.order_type, up[0]!.channel], [a.invoice.id, a.invoice.grandTotal, counter, 'counter', 'pos']);
    assert.equal(up[0]!.tax, a.invoice.cgst + a.invoice.sgst + a.invoice.igst + a.invoice.cess);
    const lines = JSON.parse(up[0]!.lines_json as string) as Array<{ name: string; category: string; qtyMilli: number; amount: number }>;
    assert.deepEqual(lines.map((l) => [l.name, l.qtyMilli, l.amount]), a.lines.map((l) => [l.name, l.qtyMilli, l.lineTotal]));
    assert.ok(lines.every((l) => l.category.length > 0), 'each item carries its category');
    assert.deepEqual(JSON.parse(up[0]!.tenders_json as string), [{ mode: 'upi', amount: a.invoice.grandTotal }]);
    assert.doesNotMatch(JSON.stringify(c.hub.db.prepare('SELECT payload_json FROM sync_event').all()), /customer|phone|gstin/i, 'no customer details go up');

    // a cancelled bill and a credit note follow
    const b = quickBill(env, [[names[0]!]]);
    cancelInvoice(env.ctx, env.owner, rid(), { invoiceId: b.invoice.id, reason: 'Wrong item' });
    createCreditNote(env.ctx, env.owner, rid(), { invoiceId: a.invoice.id, lines: [{ invoiceLineId: a.lines[1]!.id, qtyMilli: 1000 }], reason: 'Item returned', refunds: [{ mode: 'UPI', amount: a.lines[1]!.lineTotal }] });
    assert.equal(await syncSales(env.ctx), 3);
    const after = c.bills();
    assert.deepEqual(after.map((x) => [x.kind, x.voided]).sort(), [['refund', 0], ['sale', 0], ['sale', 1]]);
    assert.deepEqual([salesSyncStatus(env.ctx).pending, salesSyncStatus(env.ctx).error, salesSyncStatus(env.ctx).lastAt !== null], [0, null, true]);
    assert.equal(all(env.ctx.db, 'SELECT 1 FROM outbox WHERE sent_at IS NOT NULL').length, 0, 'the outbox itself is never written to');
  } finally { await c.close(); env.cleanup(); }
});

test('sales sync: no internet keeps the bills for later; a lost answer or a restored POS never counts a bill twice', { skip: NO_HUB }, async () => {
  const env = makeEnv(), c = await cloud();
  try {
    startShift(env);
    const item = Object.keys(env.items)[0]!;
    setSetting(env.ctx, 'cloud_backup_url', c.url);
    setSetting(env.ctx, 'cloud_backup_key', c.key);
    quickBill(env, [[item]]);

    // the internet is down
    assert.equal(await syncSales(env.ctx, { fetch: async () => { throw new TypeError('fetch failed'); } }), 0);
    assert.match(salesSyncStatus(env.ctx).error!, /internet/);
    assert.equal(salesSyncStatus(env.ctx).pending, 1);

    // the cloud stores the batch but its answer is lost: the next run sends the same batch and it is stored once
    assert.equal(await syncSales(env.ctx, { fetch: async (u, i) => { await fetch(u, i); throw new TypeError('connection reset'); } }), 0);
    assert.equal(c.bills().length, 1);
    assert.equal(await syncSales(env.ctx), 1);
    assert.equal(c.hub.db.prepare('SELECT count(*) AS n FROM sync_event').get().n, 2, 'one printed and one settled record');
    assert.equal(salesSyncStatus(env.ctx).error, null);

    // the POS was restored from an older backup: its place is behind the cloud and later bills differ
    const place = getSetting(env.ctx, 'sales_sync_state');
    quickBill(env, [[item, 2000]]);
    await syncSales(env.ctx);
    setSetting(env.ctx, 'sales_sync_state', place);
    env.ctx.db.exec("DELETE FROM outbox WHERE seq = (SELECT max(seq) FROM outbox WHERE entity = 'invoice')"); // that bill is not in the restored copy
    quickBill(env, [[item, 3000]]);
    await syncSales(env.ctx);
    assert.equal(salesSyncStatus(env.ctx).pending, 0);
    const ids = c.bills().map((b) => b.bill_id);
    assert.equal(new Set(ids).size, ids.length, 'each bill is counted once');
    assert.equal(ids.length, 3);
    assert.notEqual(JSON.parse(getSetting(env.ctx, 'sales_sync_state')).stream, JSON.parse(place).stream, 'a new stream was started');

    // the link was removed in the cloud (a revoked device)
    c.hub.db.exec('UPDATE device SET revoked_at = 1');
    quickBill(env, [[item]]);
    assert.equal(await syncSales(env.ctx), 0);
    assert.match(salesSyncStatus(env.ctx).error!, /no longer linked/);
  } finally { await c.close(); env.cleanup(); }
});

test('sales sync: purchases go up once with supplier and materials (voids too), and the stock list whenever it changed', { skip: NO_HUB }, async () => {
  const env = makeEnv(), c = await cloud();
  try {
    const paneer = createStockItem(env.ctx, env.manager, rid(), { name: 'Paneer', unit: 'kg', reorderLevelMilli: 2000, openingQtyMilli: 1000, openingUnitCost: 30_000 });
    const oil = createStockItem(env.ctx, env.manager, rid(), { name: 'Oil', unit: 'l' });
    const buy = (supplierName: string) => createPurchase(env.ctx, env.manager, rid(), { supplierName, supplierGstin: '29ABCDE1234F1Z5', billNo: 'FD-101', lines: [{ stockItemId: paneer.id, qtyMilli: 2500, unitCost: 32_000 }, { stockItemId: oil.id, qtyMilli: 1000, unitCost: 15_000 }] });
    const kept = buy('Fresh Dairy'), wrong = buy('Wrong Supplier');
    voidPurchase(env.ctx, env.manager, rid(), { purchaseId: wrong.purchase.id, reason: 'Entered twice' });
    adjustStock(env.ctx, env.manager, rid(), { stockItemId: paneer.id, kind: 'WASTAGE', qtyMilli: 500, reason: 'Spoiled' });
    setSetting(env.ctx, 'cloud_backup_url', c.url);
    setSetting(env.ctx, 'cloud_backup_key', c.key);

    assert.equal(await syncSales(env.ctx, { stockEveryMs: 0 }), 3, 'two purchases and one void');
    const q = (sql: string) => c.hub.db.prepare(sql).all() as Array<Record<string, unknown>>;
    const up = q('SELECT purchase_id, supplier, bill_no, total, voided, lines_json FROM inv_purchase ORDER BY voided');
    assert.deepEqual(up.map((p) => [p.purchase_id, p.supplier, p.bill_no, p.total, p.voided]), [[kept.purchase.id, 'Fresh Dairy', 'FD-101', 95_000, 0], [wrong.purchase.id, 'Wrong Supplier', 'FD-101', 95_000, 1]]);
    assert.deepEqual(JSON.parse(up[0]!.lines_json as string), [{ name: 'Paneer', unit: 'kg', qtyMilli: 2500, amount: 80_000 }, { name: 'Oil', unit: 'l', qtyMilli: 1000, amount: 15_000 }]);
    assert.doesNotMatch(JSON.stringify(q('SELECT payload_json FROM sync_event')), /29ABCDE1234F1Z5/, "the supplier's GSTIN stays in the POS");

    // the stock list: 1 + 2.5 - 0.5 kg of paneer at the last cost, and today's wastage valued at it
    assert.deepEqual(q('SELECT name, unit, on_hand_milli, reorder_milli, unit_cost FROM inv_stock ORDER BY name').map((s) => Object.values(s)), [['Oil', 'l', 1000, 0, 15_000], ['Paneer', 'kg', 3000, 2000, 32_000]]);
    assert.deepEqual(q('SELECT used, waste FROM inv_usage').map((u) => Object.values(u)), [[0, 16_000]]);
    const lists = () => (q('SELECT received_at FROM inv_stock_at')[0]!.received_at as number);
    const first = lists();
    env.clock.advance(60_000);
    await syncSales(env.ctx, { stockEveryMs: 0 });
    assert.equal(lists(), first, 'unchanged: not sent again');
    adjustStock(env.ctx, env.manager, rid(), { stockItemId: oil.id, kind: 'WASTAGE', qtyMilli: 250, reason: 'Spilt' });
    await syncSales(env.ctx, { stockEveryMs: 0 });
    assert.equal(q("SELECT on_hand_milli FROM inv_stock WHERE name = 'Oil'")[0]!.on_hand_milli, 750);
  } finally { await c.close(); env.cleanup(); }
});
