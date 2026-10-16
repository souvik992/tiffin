// Drives the UI's API client against a real backend (in-process, temporary database).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createServer, listen } from '../../src/http/server.ts';
import { PrintQueue } from '../../src/services/printing/queue.ts';
import { MemoryTransport } from '../../src/services/printing/transports.ts';
import { all, get } from '../../src/store/db.ts';
import { makeEnv } from '../../test/helpers.ts';
import { ApiError, createApi, newKey } from '../src/lib/api.ts';
import { TEMPLATE } from '../src/lib/menuTemplate.ts';

async function start() {
  const env = makeEnv({ seed: true });
  env.clock.t = Date.now(); // real time, so "today" filters match
  const server: Server = createServer(env.ctx, { queue: new PrintQueue(env.ctx, { memory: new MemoryTransport() }) });
  const port = await listen(server, 0);
  let token: string | null = null;
  const lost: string[] = [];
  const api = createApi({ baseUrl: `http://127.0.0.1:${port}`, getToken: () => token, onAuthLost: (c) => lost.push(c), retryDelayMs: 1 });
  const signIn = async (name: string, pin: string) => {
    const u = (await api.loginUsers()).find((x) => x.name === name)!;
    token = (await api.login(u.id, pin)).token;
    return u;
  };
  const close = () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); env.cleanup(); });
  return { env, api, port, signIn, lost, setToken: (t: string | null) => { token = t; }, close };
}
const is = (code: string) => (e: unknown) => e instanceof ApiError && e.code === code;

test('UI client: a cashier bills a day end to end; totals and change come from the backend', async () => {
  const s = await start(); try {
    await s.signIn('Cashier', '1111');
    assert.equal(await s.api.currentShift(), null);
    await s.api.openShift(50000); // the billing screen asks for this first when currentShift() is null

    const cat = await s.api.catalog();
    const burger = cat.items.find((i) => i.name === 'Cheese Burger')!;
    const cola = cat.items.find((i) => i.name === 'Cola 300ml')!;
    const extraCheese = cat.modifierGroups.find((g) => burger.modifierGroupIds.includes(g.id))!.modifiers.find((m) => m.name === 'Extra cheese')!;

    let cart = await s.api.createOrder();
    cart = await s.api.addLine(cart.order.id, burger.id, [extraCheese.id]);
    cart = await s.api.addLine(cart.order.id, cola.id);
    cart = await s.api.addLine(cart.order.id, cola.id); // identical lines merge on the server
    assert.equal(cart.lines.length, 2);
    const colaLine = cart.lines.find((l) => l.itemId === cola.id)!;
    assert.equal(colaLine.qtyMilli, 2000);
    cart = await s.api.setLineQty(colaLine.id, 1000);
    assert.equal(cart.totals.grandTotal, 12900 + 2000 + 4000);

    // 25% is above the cashier's 10% limit: refused, then approved by the manager with the same key
    const key = newKey();
    await assert.rejects(s.api.billDiscount(cart.order.id, { type: 'percent', value: 2500 }, undefined, key), is('APPROVAL_REQUIRED'));
    const manager = (await s.api.loginUsers()).find((u) => u.name === 'Manager')!;
    await assert.rejects(s.api.billDiscount(cart.order.id, { type: 'percent', value: 2500 }, { userId: manager.id, pin: '0000' }, key), is('BAD_PIN'));
    cart = await s.api.billDiscount(cart.order.id, { type: 'percent', value: 2500 }, { userId: manager.id, pin: '2345' }, key);
    assert.ok(cart.totals.discountTotal > 0);
    assert.equal(cart.totals.grossTotal - cart.totals.discountTotal + cart.totals.roundOff, cart.totals.grandTotal);

    const total = cart.totals.grandTotal;
    const payKey = newKey();
    const done = await s.api.finalize(cart.order.id, [{ mode: 'CASH', amount: total, tendered: 50000 }], payKey);
    assert.match(done.invoice.invoiceNo, /^A1\/\d\d-\d\d\/000001$/);
    assert.equal(done.changeDue, 50000 - total);
    // a repeated click / retry with the same key returns the same bill and bills nothing twice
    const again = await s.api.finalize(cart.order.id, [{ mode: 'CASH', amount: total, tendered: 50000 }], payKey);
    assert.equal(again.invoice.id, done.invoice.id);
    assert.equal(get<{ n: number }>(s.env.ctx.db, 'SELECT count(*) n FROM invoice')!.n, 1);

    const list = await s.api.invoices({ limit: 10 });
    assert.equal(list.length, 1);
    const detail = await s.api.invoice(list[0]!.id);
    assert.equal(detail.payments[0]!.mode, 'CASH');
    assert.equal(detail.lines.length, 2);
    await assert.rejects(s.api.reprint(list[0]!.id), is('APPROVAL_REQUIRED'));
    await s.api.reprint(list[0]!.id, { userId: manager.id, pin: '2345' });

    const z = await s.api.closeShift(100000, false);
    assert.equal(z.cash.expected, 50000 + total);
    assert.equal(z.cash.difference, 100000 - 50000 - total);
  } finally { await s.close(); }
});

test('UI client: menu creation needs a manager; items appear in the catalog and can be removed', async () => {
  const s = await start(); try {
    await s.signIn('Cashier', '1111');
    const cat = await s.api.catalog();
    const gst5 = cat.taxGroups.find((t) => t.rateBp === 500)!;
    await assert.rejects(s.api.createItem({ name: 'Masala Dosa', categoryId: null, taxGroupId: gst5.id, price: 9000, isVeg: true }), is('FORBIDDEN'));
    await s.signIn('Manager', '2345');
    const item = await s.api.createItem({ name: 'Masala Dosa', categoryId: cat.categories[0]!.id, taxGroupId: gst5.id, price: 9000, isVeg: true });
    assert.ok((await s.api.catalog()).items.some((i) => i.id === item.id));
    await s.api.deleteItem(item.id);
    assert.ok(!(await s.api.catalog()).items.some((i) => i.id === item.id));
  } finally { await s.close(); }
});

test('UI client: network failures retry with the same key, so a lost response never double-bills', async () => {
  const s = await start(); try {
    await s.signIn('Cashier', '1111');
    await s.api.openShift(0);
    const cola = (await s.api.catalog()).items.find((i) => i.name === 'Cola 300ml')!;
    let cart = await s.api.createOrder();
    cart = await s.api.addLine(cart.order.id, cola.id);

    // The first finalize reaches the server, but its response is "lost"; the client retries with the same key.
    const keys: string[] = [];
    let calls = 0;
    const flaky: typeof fetch = async (input, init) => {
      calls++;
      keys.push(new Headers(init?.headers).get('Idempotency-Key') ?? '');
      const res = await fetch(input, init);
      if (calls === 1) { await res.text(); throw new TypeError('network dropped'); }
      return res;
    };
    const u = (await s.api.loginUsers()).find((x) => x.name === 'Cashier')!;
    const token = (await s.api.login(u.id, '1111')).token;
    const api2 = createApi({ baseUrl: `http://127.0.0.1:${s.port}`, getToken: () => token, fetchImpl: flaky, retryDelayMs: 1 });
    const done = await api2.finalize(cart.order.id, [{ mode: 'UPI', amount: cart.totals.grandTotal }]);
    assert.equal(calls, 2);
    assert.equal(keys[0], keys[1]);
    assert.equal(done.invoice.grandTotal, cart.totals.grandTotal);
    assert.equal(all(s.env.ctx.db, 'SELECT id FROM invoice').length, 1);

    const down = createApi({ baseUrl: 'http://127.0.0.1:1', getToken: () => null, retries: 1, retryDelayMs: 1 });
    await assert.rejects(down.ping(), (e: unknown) => e instanceof ApiError && e.code === 'NETWORK' && /Cannot reach/.test(e.message));
  } finally { await s.close(); }
});

test('UI client: a lost session is reported so the app can return to the PIN screen', async () => {
  const s = await start(); try {
    s.setToken('not-a-real-token');
    await assert.rejects(s.api.catalog(), (e: unknown) => e instanceof ApiError && e.code === 'UNAUTHENTICATED' && e.status === 401);
    assert.deepEqual(s.lost, ['UNAUTHENTICATED']);
  } finally { await s.close(); }
});

test('UI client: inventory over HTTP — materials, purchase with backend totals, recipe deduction on a bill, adjustments, void', async () => {
  const s = await start(); try {
    await s.signIn('Cashier', '1111');
    await assert.rejects(s.api.createStockItem({ name: 'Milk', unit: 'l', reorderLevelMilli: 0, openingQtyMilli: 0, openingUnitCost: null }), is('FORBIDDEN'));
    assert.deepEqual(await s.api.stockItems(), []); // cashiers can read stock

    await s.signIn('Manager', '2345');
    const milk = await s.api.createStockItem({ name: 'Milk', unit: 'l', reorderLevelMilli: 10_000, openingQtyMilli: 4_000, openingUnitCost: 5_600 });
    assert.equal(milk.low, true);
    const tea = await s.api.createStockItem({ name: 'Tea leaves', unit: 'kg', reorderLevelMilli: 500, openingQtyMilli: 0, openingUnitCost: null });
    await assert.rejects(s.api.createStockItem({ name: 'Ghee', unit: 'tin' as 'kg', reorderLevelMilli: 0, openingQtyMilli: 0, openingUnitCost: null }), is('VALIDATION'));

    const lines = [{ stockItemId: milk.id, qtyMilli: 20_000, unitCost: 5_650 }, { stockItemId: tea.id, qtyMilli: 1_250, unitCost: 48_000 }];
    const preview = await s.api.previewPurchase(lines);
    assert.deepEqual(preview.lines.map((l) => l.amount), [113_000, 60_000]);
    assert.equal(preview.total, 173_000);
    const p = await s.api.createPurchase({ supplierName: 'Nandini Dairy', supplierGstin: null, billNo: 'ND-7', billDate: '2026-10-15', note: null, lines });
    assert.equal(p.purchase.total, 173_000);
    assert.equal((await s.api.purchases()).length, 1);

    // Masala Chai uses 150 ml milk and 5 g tea
    const chai = (await s.api.catalog()).items.find((i) => i.name === 'Masala Chai')!;
    await s.api.setRecipe(chai.id, [{ stockItemId: milk.id, qtyMilli: 150 }, { stockItemId: tea.id, qtyMilli: 5 }]);
    assert.equal((await s.api.recipes()).find((r) => r.itemId === chai.id)?.lines, 2);
    await s.api.openShift(0);
    let cart = await s.api.createOrder();
    cart = await s.api.addLine(cart.order.id, chai.id);
    cart = await s.api.setLineQty(cart.lines[0]!.id, 4000);
    await s.api.finalize(cart.order.id, [{ mode: 'CASH', amount: cart.totals.grandTotal }]);
    const after = await s.api.stockItems();
    assert.equal(after.find((x) => x.id === milk.id)!.onHandMilli, 4_000 + 20_000 - 600);
    assert.equal(after.find((x) => x.id === tea.id)!.onHandMilli, 1_250 - 20);

    await s.api.adjustStock(milk.id, { kind: 'WASTAGE', qtyMilli: 400, reason: 'Spoiled' });
    await assert.rejects(s.api.adjustStock(milk.id, { kind: 'WASTAGE', qtyMilli: 400, reason: null }), is('VALIDATION'));
    const counted = await s.api.adjustStock(milk.id, { kind: 'COUNT', qtyMilli: 22_500, reason: null });
    assert.equal(counted.onHandMilli, 22_500);
    const moves = await s.api.movements(milk.id);
    assert.deepEqual(moves.map((m) => m.kind), ['COUNT', 'WASTAGE', 'SALE', 'PURCHASE', 'OPENING']);
    assert.match(moves[2]!.refNo ?? '', /^A1\//); // the sale links to its bill number

    await s.api.voidPurchase(p.purchase.id, 'Wrong supplier');
    assert.equal((await s.api.purchase(p.purchase.id)).purchase.status, 'VOIDED');
    await assert.rejects(s.api.voidPurchase(p.purchase.id, 'again'), is('ALREADY_VOIDED'));
    await assert.rejects(s.api.deleteStockItem(milk.id), is('IN_USE'));
  } finally { await s.close(); }
});

test('UI client: menu module over HTTP — categories, veg / non-veg items, edits, and the bulk-upload template', async () => {
  const s = await start(); try {
    await s.signIn('Cashier', '1111');
    await assert.rejects(s.api.createCategory({ name: 'Starters', kitchenStation: 'kitchen' }), is('FORBIDDEN'));
    await s.signIn('Manager', '2345');

    const { id: starters } = await s.api.createCategory({ name: 'Starters', kitchenStation: 'kitchen' });
    await assert.rejects(s.api.createCategory({ name: 'starters', kitchenStation: null }), is('DUPLICATE'));
    let cat = await s.api.catalog();
    const order = [starters, ...cat.categories.map((c) => c.id).filter((x) => x !== starters)];
    await s.api.reorderCategories(order);
    cat = await s.api.catalog();
    assert.equal(cat.categories[0]!.name, 'Starters');
    assert.equal(cat.categories[0]!.itemCount, 0);

    const gst5 = cat.taxGroups.find((t) => t.rateBp === 500)!.id;
    const { id: kebab } = await s.api.createItem({ name: 'Seekh Kebab', categoryId: starters, taxGroupId: gst5, price: 22000, isVeg: false, unit: 'plate', hsnCode: '2106' });
    const { id: tikka } = await s.api.createItem({ name: 'Paneer 65', categoryId: starters, taxGroupId: gst5, price: 19900, isVeg: true });
    await assert.rejects(s.api.createItem({ name: 'paneer 65', categoryId: starters, taxGroupId: gst5, price: 1, isVeg: true }), is('DUPLICATE'));
    await s.api.updateItem(tikka, { price: 20900, shortName: 'P65', isVeg: true });
    cat = await s.api.catalog();
    const k = cat.items.find((i) => i.id === kebab)!, t = cat.items.find((i) => i.id === tikka)!;
    assert.deepEqual([k.isVeg, k.unit, k.hsnCode, t.isVeg, t.price, t.shortName], [0, 'plate', '2106', 1, 20900, 'P65']);
    assert.equal(cat.categories.find((c) => c.id === starters)!.itemCount, 2);
    await assert.rejects(s.api.deleteCategory(starters), is('IN_USE'));

    // the template offered for download previews cleanly and imports in one go
    const p = await s.api.previewImport(TEMPLATE);
    assert.deepEqual(p.errors, []);
    assert.deepEqual(p.items.map((i) => i.isVeg), [true, false, true, null]);
    const r = await s.api.importItems(TEMPLATE);
    assert.deepEqual(r, { imported: 4, categoriesCreated: 1 }); // only South Indian is new: Starters and Beverages exist
    await assert.rejects(s.api.importItems(TEMPLATE), is('IMPORT_ERRORS')); // a second upload would duplicate everything
  } finally { await s.close(); }
});

test('UI client: menu photos — upload, show by URL without sign-in, replace, remove', async () => {
  const s = await start(); try {
    await s.signIn('Manager', '2345');
    const item = (await s.api.catalog()).items.find((i) => i.name === 'Brownie')!;
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 9)]);
    const r = await s.api.setItemImage(item.id, png.toString('base64'));
    assert.equal((await s.api.catalog()).items.find((i) => i.id === item.id)!.imageFile, r.imageFile);
    const res = await fetch(s.api.imageUrl(r.imageFile)); // no Authorization header, like an <img> tag
    assert.equal(res.status, 200);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), png);
    await assert.rejects(s.api.setItemImage(item.id, Buffer.from('<svg onload="x()"/>').toString('base64')), is('UNSUPPORTED_IMAGE'));
    await s.api.removeItemImage(item.id);
    assert.equal((await s.api.catalog()).items.find((i) => i.id === item.id)!.imageFile, null);
    await s.signIn('Cashier', '1111');
    await assert.rejects(s.api.setItemImage(item.id, png.toString('base64')), is('FORBIDDEN'));
  } finally { await s.close(); }
});

test('reports: the client shows a report and downloads the same report as CSV; a cashier is refused', async () => {
  const s = await start(); try {
    await s.signIn('Manager', '2345');
    const catalog = await s.api.reportCatalog();
    assert.ok(catalog.length >= 16 && catalog.every((r) => r.title && r.group));
    const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    const t = await s.api.report('payments', today, today);
    assert.equal(t.columns[0]!.label, 'Payment mode');
    const { filename, csv } = await s.api.reportCsv('payments', today, today);
    assert.equal(filename, `payments_${today}_to_${today}.csv`);
    assert.ok(csv.includes('Payment mode,Payments,Received,Refunded,Net'));
    await assert.rejects(s.api.report('payments', today, '2000-01-01'), is('VALIDATION'));
    await s.signIn('Cashier', '1111');
    await assert.rejects(s.api.reportCsv('payments', today, today), is('FORBIDDEN'));
  } finally { await s.close(); }
});

test('receipt design: the owner previews and uploads a .tiffinreceipt file; a broken file comes back with reasons', async () => {
  const s = await start(); try {
    const { readFileSync } = await import('node:fs');
    const content = readFileSync(new URL('../../templates/receipt/restaurant-gst-table.tiffinreceipt', import.meta.url), 'utf8');
    await s.signIn('Owner', '1234');
    assert.equal((await s.api.receiptDesign()).active, null);
    const p = await s.api.previewReceiptDesign('shop.tiffinreceipt', content, 58);
    assert.ok(p.lines.some((l) => l.includes('NET PAYABLE')));
    const err = await s.api.previewReceiptDesign('shop.tiffinreceipt', '{"format":"tiffin-receipt","version":1,"name":"x","blocks":[{"type":"doc-title"}]}', 80).catch((e: unknown) => e);
    assert.ok(err instanceof ApiError && err.code === 'VALIDATION');
    assert.match(((err as ApiError).details as { errors: string[] }).errors.join(' '), /A GST bill must show/);
    assert.equal((await s.api.setReceiptDesign('shop.tiffinreceipt', content)).active.name, 'Restaurant with GST table');
    assert.ok((await s.api.sampleReceipt(80)).lines.some((l) => l.includes('NET PAYABLE')));
    await s.api.clearReceiptDesign();
    assert.equal((await s.api.receiptDesign()).active, null);
    await s.signIn('Manager', '2345');
    await assert.rejects(s.api.setReceiptDesign('shop.tiffinreceipt', content), is('FORBIDDEN'));
  } finally { await s.close(); }
});

test('users: the owner adds a cashier with a PIN, resets it, changes the role and deactivates; managers cannot', async () => {
  const s = await start(); try {
    await s.signIn('Owner', '1234');
    const u = await s.api.createUser({ name: 'Ravi K', role: 'cashier', pin: '4821' });
    await assert.rejects(s.api.createUser({ name: 'ravi k', role: 'cashier', pin: '1357' }), is('NAME_TAKEN'));
    assert.ok((await s.api.users()).some((x) => x.id === u.id && x.active && x.role === 'cashier'));
    await s.api.resetPin(u.id, '9753');
    await s.api.updateUser(u.id, { name: 'Ravi K', role: 'manager' });
    await s.signIn('Ravi K', '9753');
    await assert.rejects(s.api.users(), is('FORBIDDEN'));
    await s.signIn('Owner', '1234');
    await s.api.deactivateUser(u.id);
    assert.ok(!(await s.api.loginUsers()).some((x) => x.id === u.id));
    await s.api.reactivateUser(u.id);
    assert.ok((await s.api.loginUsers()).some((x) => x.id === u.id));
  } finally { await s.close(); }
});

