import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { get } from '../../../src/store/db.ts';
import { applyAddonMigrations, makeHost } from '../../../src/addons/host.ts';
import type { AddonRoute } from '../../../src/addons/host.ts';
import { makeEnv, rid, startShift } from '../../../test/helpers.ts';
import { Hub } from '../../../hub/src/hub.ts';
import { createHubServer } from '../../../hub/src/http.ts';
import { UrbanPiper } from '../../../hub/src/urbanpiper.ts';
import { register } from '../backend/index.ts';
import { saveOnlineConfig } from '../backend/onlineConfig.ts';
import { saveServiceability } from '../backend/serviceability.ts';
import { MIGRATIONS, getOrder, pendingOutbox, saveFeeTaxGroup, saveMenuSync } from '../backend/store.ts';
import { removeItemImage, setItemImage } from '../../../src/services/images.ts';
import { DEFAULT_SERVICEABILITY } from '../../../contract/src/serviceability.ts';
import type { Hours } from '../../../contract/src/serviceability.ts';

const allDay = Object.fromEntries(['0', '1', '2', '3', '4', '5', '6'].map((d) => [d, [{ open: '00:00', close: '23:59' }]])) as Hours;
const until = async (fn: () => boolean | Promise<boolean>, what: string, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await fn())) { if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`); await new Promise((r) => setTimeout(r, 25)); }
};

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'ods-conn-'));
  const hub = new Hub({ dbPath: join(dir, 'hub.db'), devOtp: true });
  // a stand-in UrbanPiper: the hub's calls to it are recorded, never sent
  const upCalls: Array<{ path: string; body: any }> = [];
  const up = new UrbanPiper(hub, { kick: false, fetch: async (url, init) => { upCalls.push({ path: url, body: init.body ? JSON.parse(init.body) : null }); return { status: 200, text: async () => '{"status":"success"}' }; } });
  const server: Server = createHubServer(hub, { adminKey: 'k', heartbeatMs: 100, urbanpiper: up });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const env = makeEnv();
  const sink = { routes: [] as AddonRoute[], migrations: [], stops: [] as Array<() => void | Promise<void>> };
  const host = makeHost(env.ctx, 'ods', '0.3.0', sink);
  applyAddonMigrations(env.ctx, 'ods', MIGRATIONS);
  const conn = register(host, { connector: { retryMs: [50, 100, 200], tickMs: 200 } });
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(base + path, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null) as any };
  };
  // the store on the hub, and the POS settings an owner would make
  const store = hub.createStore('demo', 'Demo');
  const five = get<{ id: string }>(env.ctx.db, 'SELECT id FROM tax_group WHERE rate_bp = 500 LIMIT 1')!.id;
  saveFeeTaxGroup(host, five);
  saveServiceability(host, env.owner, rid(), { ...DEFAULT_SERVICEABILITY, location: { lat: 13.0213, lng: 77.646, label: 'Store' }, hours: allDay, roadFactor: 1 });
  saveOnlineConfig(host, env.owner, rid(), { enabled: true, channels: { app: false, website: true, swiggy: false, zomato: false }, acceptMode: 'manual', acceptTimeoutMin: 5, fulfilment: { pickup: true, delivery: true }, payments: { online: false, cod: true } });
  await conn.pair(env.owner, base, store.pairingCode);
  startShift(env, 50000);
  const burger = get<{ id: string }>(env.ctx.db, "SELECT id FROM item WHERE name = 'Cheese Burger'")!.id;
  const order = async (mobile: string, o: { fulfilment?: 'PICKUP' | 'DELIVERY'; qty?: number } = {}) => {
    const code = (await call('POST', '/v1/otp/send', { mobile })).json.devCode;
    const { otpToken } = (await call('POST', '/v1/otp/verify', { mobile, otp: code })).json;
    const fulfilment = o.fulfilment ?? 'PICKUP';
    const lines = [{ itemId: burger, qtyMilli: (o.qty ?? 2) * 1000 }];
    const location = fulfilment === 'DELIVERY' ? { lat: 13.03, lng: 77.646 } : null;
    const q = (await call('POST', '/v1/stores/demo/quote', { fulfilment, location, lines })).json;
    const r = await call('POST', '/v1/stores/demo/orders', { fulfilment, payment: 'COD', customer: { name: 'Asha', mobile }, otpToken, lines, location, menuVersion: 1, expectedTotal: q.total,
      address: fulfilment === 'DELIVERY' ? { line1: '12, 4th Cross', city: 'Bengaluru', pincode: '560043' } : null }, { 'idempotency-key': rid() });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    return r.json as { order: { id: string; number: string; total: number }; accessToken: string };
  };
  const hubState = (id: string) => (hub.db.prepare('SELECT state FROM orders WHERE id = ?').get(id) as { state: string }).state;
  const close = async () => { await conn.stop(); for (const s of sink.stops) await s(); await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }); hub.close(); env.cleanup(); rmSync(dir, { recursive: true, force: true }); };
  return { env, host, conn, hub, call, order, hubState, close, burger, sink, base, up, upCalls };
}

test('ODS connector: pairs, publishes, receives orders live, bills on accept (GST bill + KOT), and moves them through to collected', async () => {
  const s = await setup();
  try {
    await until(() => s.conn.link().state === 'connected', 'connected');
    const page = (await s.call('GET', '/v1/stores/demo')).json;
    assert.deepEqual([page.open, page.name], [true, 'Demo Burger Hub']); // published menu, store name from the POS, accepting (shift open)
    const placed = await s.order('9000000101');
    await until(() => getOrder(s.host, placed.order.id) !== null, 'order arrives');
    await until(() => s.hubState(placed.order.id) === 'RECEIVED', 'received confirmed');
    const acc = s.conn.accept(s.env.cashier, placed.order.id, 12, rid());
    assert.equal(acc.billTotal, placed.order.total, 'POS bill = what the customer was charged');
    const inv = get<{ channel: string; external_id: string }>(s.env.ctx.db, 'SELECT o.channel, o.external_id FROM invoice i JOIN sale_order o ON o.id = i.order_id WHERE i.id = ?', acc.billInvoiceId!)!;
    assert.deepEqual({ ...inv }, { channel: 'WEBSITE', external_id: placed.order.number });
    assert.ok(get(s.env.ctx.db, "SELECT 1 FROM print_job WHERE ref_id = ? AND kind = 'KOT'", acc.billInvoiceId!), 'kitchen ticket queued');
    await until(() => s.hubState(placed.order.id) === 'ACCEPTED', 'hub knows it is accepted');
    for (const to of ['PREPARING', 'READY', 'PICKED_UP'] as const) s.conn.step(s.env.cashier, placed.order.id, to);
    await until(() => s.hubState(placed.order.id) === 'PICKED_UP', 'collected');
    const seen = (await s.call('GET', `/v1/orders/${placed.order.id}`, undefined, { 'x-order-token': placed.accessToken })).json;
    assert.equal(seen.posBillNo, acc.billNo);
  } finally { await s.close(); }
});

test('ODS connector: automatic accepting bills on arrival; orders placed while the POS was disconnected arrive when it reconnects', async () => {
  const s = await setup();
  try {
    await until(() => s.conn.link().state === 'connected', 'connected');
    saveOnlineConfig(s.host, s.env.owner, rid(), { enabled: true, channels: { app: false, website: true, swiggy: false, zomato: false }, acceptMode: 'auto', acceptTimeoutMin: 5, fulfilment: { pickup: true, delivery: true }, payments: { online: false, cod: true } });
    await s.conn.publish();
    const auto = await s.order('9000000201', { fulfilment: 'DELIVERY', qty: 1 });
    await until(() => getOrder(s.host, auto.order.id)?.billInvoiceId != null, 'auto-billed');
    await until(() => s.hubState(auto.order.id) === 'ACCEPTED', 'auto-accepted at the hub');
    const lines = s.env.ctx.db.prepare('SELECT name FROM invoice_line WHERE invoice_id = ? ORDER BY line_no').all(getOrder(s.host, auto.order.id)!.billInvoiceId!) as Array<{ name: string }>;
    assert.deepEqual(lines.map((l) => l.name), ['Cheese Burger', 'Delivery charge']); // delivery fee on the bill, with GST

    await s.conn.stop(); // the internet drops
    await until(() => s.conn.link().state !== 'connected', 'disconnected');
    const missed = await s.order('9000000202'); // the hub keeps the store online for 60 s
    assert.equal(getOrder(s.host, missed.order.id), null);
    s.conn.refresh();
    await until(() => getOrder(s.host, missed.order.id) !== null, 'missed order arrives after reconnecting');
  } finally { await s.close(); }
});

test('ODS connector: a customer cancel that beats the accept (F11) and a price change since ordering (F5) are flagged, not billed silently', async () => {
  const s = await setup();
  try {
    await until(() => s.conn.link().state === 'connected', 'connected');
    // F11: the cancel reaches the hub while this POS is offline, then the POS accepts
    const o1 = await s.order('9000000301');
    await until(() => getOrder(s.host, o1.order.id) !== null, 'arrives');
    await s.conn.stop();
    await until(() => s.conn.link().state !== 'connected', 'disconnected');
    assert.equal((await s.call('POST', `/v1/orders/${o1.order.id}/cancel`, {}, { 'x-order-token': o1.accessToken })).json.state, 'CANCELLED');
    const acc = s.conn.accept(s.env.cashier, o1.order.id, 10, rid()); // the POS did not hear yet
    assert.ok(acc.billInvoiceId);
    s.conn.refresh();
    await until(() => /Cancel bill/.test(getOrder(s.host, o1.order.id)?.alert ?? ''), 'alert to cancel the bill');
    assert.equal(getOrder(s.host, o1.order.id)!.state, 'CANCELLED');

    // F5: the price changed in the POS after the customer ordered
    const o2 = await s.order('9000000302');
    await until(() => getOrder(s.host, o2.order.id) !== null, 'arrives');
    s.env.ctx.db.prepare('UPDATE item SET price = 13900 WHERE id = ?').run(s.burger);
    assert.throws(() => s.conn.accept(s.env.cashier, o2.order.id, 10, rid()), /POS price is now Rs 278\.00; the customer was charged Rs 258\.00/);
    const billed = s.conn.accept(s.env.cashier, o2.order.id, 10, rid(), true);
    assert.equal(billed.billTotal, 27800);
    assert.match(billed.alert!, /Billed at the POS price/);
  } finally { await s.close(); }
});

test('ODS connector: pairing needs a secure (https) hub address, except a hub on this PC', async () => {
  const t = await setup();
  try {
    await assert.rejects(t.conn.pair(t.env.owner, 'http://orders.example.in', 'ABCD-EFGH'), /https:\/\//);
    await assert.rejects(t.conn.pair(t.env.owner, 'ftp://orders.example.in', 'ABCD-EFGH'), /hub address/);
    assert.equal(t.conn.link().paired, true); // the earlier pairing is untouched
  } finally { await t.close(); }
});

test('ODS connector: one connection link from the hub admin page (address + pairing code) connects the POS', async () => {
  const t = await setup();
  try {
    const code = t.hub.pairingCodeForSlug('demo');
    await assert.rejects(t.conn.pair(t.env.owner, 'http://orders.example.in/connect/ABCD-EFGH', ''), /https:\/\//); // the same https rule
    await assert.rejects(t.conn.pair(t.env.owner, `${t.base}/somewhere/else`, ''), /connection link/);
    const l = await t.conn.pair(t.env.owner, `  ${t.base}/connect/${code.toLowerCase()}/  `, '');
    assert.deepEqual([l.paired, l.hubUrl, l.store?.slug], [true, t.base, 'demo']);
  } finally { await t.close(); }
});

test('ODS connector: a POS that stops right after billing sends the accept on restart (F3); replayed events change nothing (F4); online orders cannot be switched off while orders are open (F15)', async () => {
  const s = await setup();
  let second: Awaited<ReturnType<typeof register>> | null = null;
  try {
    await until(() => s.conn.link().state === 'connected', 'connected');
    const o = await s.order('9000000401');
    await until(() => getOrder(s.host, o.order.id) !== null, 'arrives');
    await s.conn.stop(); // the POS "crashes" before the hub hears about the accept
    const acc = s.conn.accept(s.env.cashier, o.order.id, 10, rid());
    assert.ok(acc.billInvoiceId);
    assert.ok(pendingOutbox(s.host).some((x) => x.order_id === o.order.id && x.action === 'accept'), 'accept kept in the outbox');
    assert.equal(s.hubState(o.order.id), 'RECEIVED');

    // F15: refused while the order is open
    const config = s.sink.routes.find((r) => r.method === 'PUT' && r.path.endsWith('/config'))!;
    assert.throws(() => config.handler({ actor: s.env.owner, requestId: rid(), body: { enabled: false } } as never), /1 online order is still open \(W-\d+\)/);

    // restart: a new connector on the same database, made to replay every event from the start
    s.host.setSetting('ods_last_seq', '0');
    const sink2 = { routes: [] as AddonRoute[], migrations: [], stops: [] as Array<() => void | Promise<void>> };
    second = register(makeHost(s.env.ctx, 'ods', '0.3.0', sink2), { connector: { retryMs: [50, 100, 200], tickMs: 200 } });
    second.refresh();
    await until(() => s.hubState(o.order.id) === 'ACCEPTED', 'the accept reaches the hub after the restart');
    await until(() => Number(s.host.getSetting('ods_last_seq')) > 0, 'events replayed');
    assert.equal(getOrder(s.host, o.order.id)!.billInvoiceId, acc.billInvoiceId, 'same bill');
    assert.equal((s.env.ctx.db.prepare("SELECT COUNT(*) AS n FROM sale_order WHERE external_id = ?").get(o.order.number) as { n: number }).n, 1, 'billed once');
  } finally { await second?.stop(); await s.close(); }
});

test('ODS connector: menu photos go to the hub once (checked against their content name) and show on the ordering page; removed photos go away', async () => {
  const s = await setup();
  try {
    await until(() => s.conn.link().state === 'connected', 'connected');
    const PNG1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const { imageFile } = setItemImage(s.env.ctx, s.env.owner, rid(), s.burger, PNG1);
    await s.conn.publish();
    const page = (await s.call('GET', '/v1/stores/demo')).json;
    assert.equal(page.menu.items.find((i: { id: string }) => i.id === s.burger).image, imageFile);
    const r = await fetch(`${s.base}/v1/stores/demo/images/${imageFile}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), Buffer.from(PNG1, 'base64'));
    // a file that does not match its name, or no device key, is refused
    const key = s.host.getSetting('ods_hub_key');
    const fake = await s.call('PUT', `/v1/pos/images/${'0'.repeat(64)}.png`, { dataBase64: PNG1 }, { authorization: `Bearer ${key}` });
    assert.equal(fake.status, 400);
    assert.equal((await s.call('PUT', `/v1/pos/images/${imageFile}`, { dataBase64: PNG1 })).status, 401);
    // sent once: publishing again uploads nothing new
    assert.deepEqual((await s.call('GET', '/v1/pos/images', undefined, { authorization: `Bearer ${key}` })).json, { names: [imageFile] });
    removeItemImage(s.env.ctx, s.env.owner, rid(), s.burger);
    await s.conn.publish();
    assert.equal((await fetch(`${s.base}/v1/stores/demo/images/${imageFile}`)).status, 404);
  } finally { await s.close(); }
});

test('ODS menu sync: each channel lists its own items at its own prices; descriptions travel; orders are billed at the channel price', async () => {
  const s = await setup();
  try {
    await until(() => s.conn.link().state === 'connected', 'connected');
    const id = (name: string) => get<{ id: string }>(s.env.ctx.db, 'SELECT id FROM item WHERE name = ?', name)!.id;
    const brownie = id('Brownie');
    s.env.ctx.db.prepare("UPDATE item SET description = 'Warm, with chocolate sauce' WHERE id = ?").run(brownie);
    saveOnlineConfig(s.host, s.env.owner, rid(), { enabled: true, channels: { app: true, website: true, swiggy: false, zomato: false }, acceptMode: 'manual', acceptTimeoutMin: 5, fulfilment: { pickup: true, delivery: true }, payments: { online: false, cod: true } });
    // website: everything except the brownie; app: only burger and brownie, 10% dearer, brownie at its own price
    saveMenuSync(s.host, s.env.owner, 'website', { mode: 'exclude', items: [brownie] });
    saveMenuSync(s.host, s.env.owner, 'app', { mode: 'include', items: [s.burger, brownie], pricing: 'custom', markupBp: 1000, prices: { [brownie]: 9900 } });
    assert.throws(() => saveMenuSync(s.host, s.env.manager, 'app', { mode: 'all' }), /permission|allowed|owner/i);
    assert.throws(() => saveMenuSync(s.host, s.env.owner, 'app', { mode: 'include', items: [] }), /at least one/);
    await s.conn.publish(true);
    const web = (await s.call('GET', '/v1/stores/demo')).json.menu.items as Array<{ id: string; price: number; description?: string }>;
    const app = (await s.call('GET', '/v1/stores/demo?channel=app')).json.menu.items as Array<{ id: string; price: number; description?: string }>;
    assert.ok(!web.some((i) => i.id === brownie) && web.some((i) => i.id === s.burger));
    assert.deepEqual(app.map((i) => [i.id, i.price]).sort(), [[brownie, 9900], [s.burger, 14200]].sort()); // 129 + 10% = 141.90 -> 142
    assert.equal(app.find((i) => i.id === brownie)!.description, 'Warm, with chocolate sauce');
    assert.ok(!('prices' in app[0]!) && !('channels' in app[0]!), 'customers see only their price');
    // ordering the excluded brownie on the website is refused
    const q = await s.call('POST', '/v1/stores/demo/quote', { fulfilment: 'PICKUP', lines: [{ itemId: brownie, qtyMilli: 1000 }] });
    assert.equal(q.status, 409);
    // an app order is priced and billed at the app price
    const mobile = '9000000501';
    const code = (await s.call('POST', '/v1/otp/send', { mobile })).json.devCode;
    const { otpToken } = (await s.call('POST', '/v1/otp/verify', { mobile, otp: code })).json;
    const lines = [{ itemId: s.burger, qtyMilli: 2000 }];
    const aq = (await s.call('POST', '/v1/stores/demo/quote', { fulfilment: 'PICKUP', lines, channel: 'app' })).json;
    assert.equal(aq.itemsTotal, 28400);
    const placed = await s.call('POST', '/v1/stores/demo/orders', { fulfilment: 'PICKUP', payment: 'COD', customer: { name: 'Asha', mobile }, otpToken, lines, menuVersion: 1, expectedTotal: aq.total, channel: 'app' }, { 'idempotency-key': rid() });
    assert.equal(placed.status, 201, JSON.stringify(placed.json));
    await until(() => getOrder(s.host, placed.json.order.id) !== null, 'arrives');
    const acc = s.conn.accept(s.env.cashier, placed.json.order.id, 10, rid());
    assert.equal(acc.billTotal, aq.total, 'the GST bill equals what the app customer pays');
  } finally { await s.close(); }
});

test('ODS connector: a Swiggy order from UrbanPiper is billed at the Swiggy price with its packaging charge, paid by Swiggy; its rider and its cancellation reach the ODS', async () => {
  const s = await setup();
  try {
    await until(() => s.conn.link().state === 'connected', 'connected');
    saveOnlineConfig(s.host, s.env.owner, rid(), { enabled: true, channels: { app: false, website: true, swiggy: true, zomato: false }, acceptMode: 'manual', acceptTimeoutMin: 5, fulfilment: { pickup: true, delivery: true }, payments: { online: false, cod: true } });
    saveMenuSync(s.host, s.env.owner, 'swiggy', { mode: 'all', items: [], pricing: 'custom', markupBp: 1000, prices: {} });
    await s.conn.publish(true);
    s.up.saveLink('demo', { username: 'u', apiKey: 'secret-key-1', bizId: '42', locationRef: 'DEMO-1', city: 'Bengaluru', platforms: ['swiggy'] }, s.base);
    const token = (s.hub.db.prepare('SELECT webhook_token FROM up_link').get() as { webhook_token: string }).webhook_token;
    const hook = (event: string, body: unknown) => s.call('POST', '/v1/urbanpiper/42', body, { 'x-tiffin-token': token, 'x-upr-event-type': event });
    const relay = {
      customer: { name: 'Ravi', phone: '9876500000', address: { line_1: 'Flat 2', city: 'Bengaluru', pin: '560043', latitude: 13.03, longitude: 77.646 } },
      order: {
        details: { id: 777, channel: 'swiggy', order_type: 'delivery', order_total: 304, charges: [{ title: 'Packaging Charge', value: 20 }], ext_platforms: [{ id: 'SW-1', name: 'swiggy', delivery_type: 'partner', extras: { order_otp: '1234' }, discounts: [] }] },
        items: [{ title: 'Cheese Burger', merchant_id: s.burger, price: 135.24, quantity: 2, options_to_add: [] }],
        payment: [{ option: 'payment_gateway', amount: 304 }], store: { merchant_ref_id: 'DEMO-1' },
      },
    };
    const r = await hook('18', relay);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const hubOrder = s.hub.db.prepare('SELECT id FROM orders WHERE number = ?').get(r.json.order_ref_id) as { id: string };
    await until(() => getOrder(s.host, hubOrder.id) !== null, 'the Swiggy order reaches the POS');
    const lo = getOrder(s.host, hubOrder.id)!;
    assert.equal(lo.order.channel, 'swiggy');
    assert.equal(lo.order.external!.otp, '1234');
    assert.equal(s.conn.posPrice(lo.order).differs, false, 'the POS prices it the same (Swiggy price 129 + 10% = 142, packaging 20)');
    const acc = s.conn.accept(s.env.cashier, hubOrder.id, 15, rid());
    assert.equal(acc.billTotal, lo.order.total);
    assert.equal(lo.order.lines[0]!.unitPrice, 14200);
    assert.equal(lo.order.packagingFee, 2000);
    const inv = get<{ channel: string; mode: string }>(s.env.ctx.db, 'SELECT o.channel, p.mode FROM invoice i JOIN sale_order o ON o.id = i.order_id JOIN payment p ON p.invoice_id = i.id WHERE i.id = ?', acc.billInvoiceId!)!;
    assert.deepEqual({ ...inv }, { channel: 'SWIGGY', mode: 'OTHER' }, 'paid by Swiggy, not cash or UPI at the counter');
    await until(() => s.hubState(hubOrder.id) === 'ACCEPTED', 'the hub knows');
    await s.up.pump();
    assert.ok(s.upCalls.some((c) => c.path.endsWith('/external/api/v1/orders/777/status/') && c.body.new_status === 'Acknowledged'), 'Swiggy is told through UrbanPiper');
    // the cola... the burger ran out: Swiggy asks the customer to change the order; Swiggy's answer shows on the order
    assert.throws(() => s.conn.platformAction(s.env.cashier, hubOrder.id, { action: 'customer_phone' }, rid()), /Zomato request/);
    s.conn.platformAction(s.env.cashier, hubOrder.id, { action: 'items_out_of_stock', itemIds: [s.burger], allowEdit: true }, rid());
    await until(async () => { await s.up.pump(); return s.upCalls.some((c) => c.path.endsWith('/hub/api/v1/orders/items-oos/')); }, 'out-of-stock request reaches UrbanPiper');
    assert.deepEqual(s.upCalls.find((c) => c.path.endsWith('/hub/api/v1/orders/items-oos/'))!.body, { order_upipr_id: 777, order_ref_id: 'SW-1', allow_edit: true, items_oos: [{ ref_id: s.burger }] });
    await hook('60018', { success: true, platform: 'swiggy', upipr_order_id: 777, item_ids: [1], data: { message: 'Please call the customer.', customer_masked_number: '08040001111', pin: '4455' } });
    await until(() => getOrder(s.host, hubOrder.id)!.alert === 'Please call the customer. Customer: 08040001111 PIN: 4455', 'Swiggy answer on the order');
    // the Swiggy rider, then Swiggy cancels
    await hook('60012', { order_id: 777, delivery_info: { current_state: 'At store', delivery_person_details: { name: 'Kiran', phone: '9000000009' } } });
    await until(() => getOrder(s.host, hubOrder.id)!.order.external?.riderStatus === 'At store', 'rider shown');
    assert.deepEqual(getOrder(s.host, hubOrder.id)!.order.rider, { name: 'Kiran', phone: '9000000009' });
    await hook('60008', { order_id: 777, new_state: 'Cancelled', message: 'Rider could not find the customer' });
    await until(() => getOrder(s.host, hubOrder.id)!.state === 'CANCELLED', 'cancelled');
    assert.equal(getOrder(s.host, hubOrder.id)!.alert, `Swiggy cancelled it (Rider could not find the customer). Cancel bill ${acc.billNo} (manager approval).`);
  } finally { await s.close(); }
});
