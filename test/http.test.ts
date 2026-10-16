import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { Server } from 'node:http';
import { createServer, listen } from '../src/http/server.ts';
import { PrintQueue } from '../src/services/printing/queue.ts';
import { MemoryTransport } from '../src/services/printing/transports.ts';
import { makeEnv, rid } from './helpers.ts';
import type { Env } from './helpers.ts';

interface Api { base: string; call(method: string, path: string, o?: { body?: unknown; token?: string; key?: string | null; headers?: Record<string, string> }): Promise<{ status: number; json: any; text: string }>; login(name: string, pin: string): Promise<string>; close(): Promise<void>; env: Env; queue: PrintQueue }

async function start(): Promise<Api> {
  const env = makeEnv({ seed: true });
  const queue = new PrintQueue(env.ctx, { memory: new MemoryTransport() });
  const server: Server = createServer(env.ctx, { queue });
  const port = await listen(server, 0);
  const base = `http://127.0.0.1:${port}`;
  const call: Api['call'] = async (method, path, o = {}) => {
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    if (o.body !== undefined) headers['content-type'] ??= 'application/json';
    if (method !== 'GET' && o.key !== null) headers['idempotency-key'] = o.key ?? rid('http');
    const r = await fetch(base + path, { method, headers, body: o.body === undefined ? undefined : typeof o.body === 'string' ? o.body : JSON.stringify(o.body) });
    const text = await r.text();
    let json: unknown = null; try { json = JSON.parse(text); } catch { /* csv */ }
    return { status: r.status, json, text };
  };
  const login: Api['login'] = async (name, pin) => {
    const users = (await call('GET', '/api/login-users')).json as Array<{ id: string; name: string }>;
    const r = await call('POST', '/api/auth/login', { body: { userId: users.find((u) => u.name === name)!.id, pin } });
    assert.equal(r.status, 200, r.text);
    return r.json.token;
  };
  return { base, call, login, env, queue, close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); env.cleanup(); }) };
}

test('HTTP: a complete billing day through the API', async () => {
  const api = await start(); try {
    const { call } = api;
    const cashier = await api.login('Cashier', '1111');
    const manager = await api.login('Manager', '2345');
    const owner = await api.login('Owner', '1234');

    assert.equal((await call('GET', '/api/ping')).json.ok, true);
    assert.equal((await call('POST', '/api/shifts/open', { token: cashier, body: { openingCash: 50000 } })).status, 200);
    assert.equal((await call('POST', '/api/shifts/open', { token: cashier, body: { openingCash: 50000 } })).json.error.code, 'SHIFT_ALREADY_OPEN');

    const cat = (await call('GET', '/api/catalog', { token: cashier })).json;
    assert.equal(cat.items.length, 16);
    const find = (n: string) => cat.items.find((i: any) => i.name === n);
    const search = (await call('GET', '/api/items/search?q=cheese%20bur', { token: cashier })).json;
    assert.equal(search[0].name, 'Cheese Burger');
    assert.equal((await call('GET', '/api/items/by-barcode/8901234567890', { token: cashier })).json.name, 'Cola 300ml');

    const order = (await call('POST', '/api/orders', { token: cashier, body: {} })).json.order;
    const addKey = rid('add');
    const c1 = await call('POST', `/api/orders/${order.id}/lines`, { token: cashier, key: addKey, body: { itemId: find('Cheese Burger').id, qtyMilli: 2000 } });
    const c1b = await call('POST', `/api/orders/${order.id}/lines`, { token: cashier, key: addKey, body: { itemId: find('Cheese Burger').id, qtyMilli: 2000 } });
    assert.equal(c1.json.lines[0].qtyMilli, 2000);
    assert.equal(c1b.json.lines[0].qtyMilli, 2000); // retried request did not add twice
    const c2 = await call('POST', `/api/orders/${order.id}/lines`, { token: cashier, body: { itemId: find('Cola 300ml').id } });
    assert.equal(c2.json.totals.grandTotal, 2 * 12900 + 4000);
    const disc = await call('POST', `/api/orders/${order.id}/discount`, { token: cashier, body: { discount: { type: 'percent', value: 5000 } } });
    assert.equal(disc.status, 403); assert.equal(disc.json.error.code, 'APPROVAL_REQUIRED');
    const ok = await call('POST', `/api/orders/${order.id}/discount`, { token: cashier, body: { discount: { type: 'percent', value: 500 } } });
    assert.equal(ok.json.totals.discountTotal, 1490);

    const total = ok.json.totals.grandTotal;
    const finKey = rid('fin');
    const fin = await call('POST', `/api/orders/${order.id}/finalize`, { token: cashier, key: finKey, body: { payments: [{ mode: 'CASH', amount: total, tendered: total + 500 }] } });
    assert.equal(fin.status, 200, fin.text);
    assert.equal(fin.json.invoice.invoiceNo, 'A1/26-27/000001');
    assert.equal(fin.json.changeDue, 500);
    const again = await call('POST', `/api/orders/${order.id}/finalize`, { token: cashier, key: finKey, body: { payments: [{ mode: 'CASH', amount: total, tendered: total + 500 }] } });
    assert.equal(again.json.invoice.id, fin.json.invoice.id); // network retry returns the same bill

    const inv = (await call('GET', `/api/invoices/${fin.json.invoice.id}`, { token: cashier })).json;
    assert.equal(inv.lines.length, 2);
    const rp = await call('POST', `/api/invoices/${fin.json.invoice.id}/reprint`, { token: cashier, body: {} });
    assert.equal(rp.json.error.code, 'APPROVAL_REQUIRED');
    assert.equal((await call('POST', `/api/invoices/${fin.json.invoice.id}/reprint`, { token: cashier, body: { override: { userId: (await call('GET', '/api/me', { token: manager })).json.userId, pin: '2345' } } })).json.copyNo, 2);

    assert.equal((await api.queue.processDue()).printed, 4); // receipt + 2 kitchen tickets + duplicate receipt
    const jobs = (await call('GET', '/api/print/jobs', { token: cashier })).json;
    assert.equal(jobs.counts.PRINTED, 4);

    assert.equal((await call('POST', '/api/shifts/close', { token: cashier, body: { countedCash: 50000 + total } })).json.cash.difference, 0);
    const day = '2026-10-12';
    assert.equal((await call('GET', `/api/reports/daily?from=${day}&to=${day}`, { token: cashier })).status, 403);
    const daily = (await call('GET', `/api/reports/daily?from=${day}&to=${day}`, { token: manager })).json;
    assert.deepEqual([daily[0].invoices, daily[0].salesTotal], [1, total]);
    const csv = await call('GET', `/api/reports/invoice-register.csv?from=${day}&to=${day}`, { token: manager });
    assert.ok(csv.text.includes('A1/26-27/000001,TAX_INVOICE,ISSUED'));
    assert.equal((await call('GET', '/api/reports/tax?from=2026-10-12&to=2026-10-12', { token: manager })).json.length, 2); // 5% and 12%
    const catalog = (await call('GET', '/api/reports/catalog', { token: manager })).json;
    assert.ok(catalog.some((r: { key: string }) => r.key === 'gst-rates'));
    const view = (await call('GET', `/api/reports/view/sales-summary?from=${day}&to=${day}`, { token: manager })).json;
    assert.equal(view.totals.netSales, total);
    assert.equal((await call('GET', `/api/reports/view/sales-summary?from=${day}&to=${day}`, { token: cashier })).status, 403);
    assert.equal((await call('GET', `/api/reports/view/nope?from=${day}&to=${day}`, { token: manager })).status, 404);
    const dl = await fetch(`${api.base}/api/reports/csv/payments?from=${day}&to=${day}`, { headers: { authorization: `Bearer ${manager}` } });
    assert.equal(dl.headers.get('content-disposition'), 'attachment; filename="payments_2026-10-12_to_2026-10-12.csv"');
    assert.ok((await dl.text()).includes('Payment mode,Payments'));

    const health = (await call('GET', '/api/health?deep=1', { token: owner })).json;
    assert.equal(health.integrity.auditChain.ok, true);
    assert.equal((await call('GET', '/api/health', { token: manager })).status, 403);
    assert.equal((await call('GET', '/api/audit/verify', { token: owner })).json.ok, true);
    const bk = await call('POST', '/api/backup', { token: owner, key: null, body: {} });
    assert.equal(bk.json.verified, true);
    assert.equal((await call('PUT', '/api/settings', { token: owner, body: { receipt_footer: 'See you soon' } })).json.receipt_footer, 'See you soon');
    assert.equal((await call('PUT', '/api/settings', { token: manager, body: { receipt_footer: 'x' } })).status, 403);
  } finally { await api.close(); }
});

test('HTTP: rejects unauthenticated, malformed, oversized, cross-site and rebinding requests', async () => {
  const api = await start(); try {
    const { call } = api;
    const cashier = await api.login('Cashier', '1111');
    assert.equal((await call('GET', '/api/catalog')).status, 401);
    assert.equal((await call('GET', '/api/catalog', { token: 'bogus' })).status, 401);
    assert.equal((await call('POST', '/api/orders', { token: cashier, body: {}, key: null })).json.error.code, 'REQUEST_ID_REQUIRED');
    assert.equal((await call('POST', '/api/orders', { token: cashier, body: '{"x":', headers: { 'content-type': 'application/json' } })).json.error.code, 'BAD_JSON');
    assert.equal((await call('POST', '/api/orders', { token: cashier, body: 'channel=OTHER', headers: { 'content-type': 'text/plain' } })).status, 415); // "simple" cross-site form posts are refused
    assert.equal((await call('POST', '/api/orders', { token: cashier, body: { surprise: 1 } })).json.error.code, 'VALIDATION'); // unknown fields rejected
    assert.equal((await call('POST', '/api/orders', { token: cashier, body: { channel: 5 } })).status, 400);
    assert.equal((await call('POST', '/api/auth/login', { body: { userId: 'x', pin: '1' } })).json.error.code, 'BAD_PIN');
    const byMobile = await call('POST', '/api/auth/login', { body: { mobile: '9000000003', pin: '1111' } }); // the demo cashier
    assert.equal(byMobile.json.user.name, 'Cashier');
    assert.equal((await call('POST', '/api/auth/login', { body: { mobile: '9000000003', pin: '9999' } })).json.error.message, 'Incorrect mobile number or PIN.');
    assert.equal((await call('POST', '/api/auth/login', { body: { pin: '1111' } })).json.error.code, 'VALIDATION');
    assert.equal((await call('GET', '/api/nope', { token: cashier })).status, 404);
    assert.equal((await call('DELETE', '/api/catalog', { token: cashier })).status, 405);
    assert.equal((await call('POST', '/api/orders', { token: cashier, body: 'x'.repeat(2_100_000), headers: { 'content-type': 'application/json' } }).catch(() => ({ status: 413 }))).status, 413);
    // a response never contains a stack trace or SQL
    const bad = await call('GET', '/api/orders/does-not-exist', { token: cashier });
    assert.equal(bad.status, 404); assert.ok(!/at |SELECT|node:/.test(bad.text));
    // DNS rebinding: a hostile Host header is refused even though the TCP connection is local
    const status = await new Promise<number>((resolve, reject) => {
      const u = new URL(api.base);
      const req = http.request({ host: u.hostname, port: u.port, path: '/api/ping', headers: { host: 'evil.example.com' } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject); req.end();
    });
    assert.equal(status, 403);
    // expired/locked sessions are told apart from never-logged-in
    api.env.clock.advance(301_000);
    assert.equal((await call('GET', '/api/catalog', { token: cashier })).json.error.code, 'SESSION_LOCKED');
  } finally { await api.close(); }
});

test('HTTP: live events stream announces invoices and print results', async () => {
  const api = await start(); try {
    const cashier = await api.login('Cashier', '1111');
    await api.call('POST', '/api/shifts/open', { token: cashier, body: { openingCash: 0 } });
    const ctrl = new AbortController();
    const res = await fetch(api.base + '/api/events', { headers: { authorization: `Bearer ${cashier}` }, signal: ctrl.signal });
    assert.equal(res.status, 200);
    assert.ok((res.headers.get('content-type') ?? '').startsWith('text/event-stream'));
    const reader = res.body!.getReader(); const dec = new TextDecoder(); let seen = '';
    const order = (await api.call('POST', '/api/orders', { token: cashier, body: {} })).json.order;
    const item = (await api.call('GET', '/api/catalog', { token: cashier })).json.items[0];
    const cart = (await api.call('POST', `/api/orders/${order.id}/lines`, { token: cashier, body: { itemId: item.id } })).json;
    await api.call('POST', `/api/orders/${order.id}/finalize`, { token: cashier, body: { payments: [{ mode: 'UPI', amount: cart.totals.grandTotal }] } });
    await api.queue.processDue();
    const deadline = Date.now() + 3000;
    while (!(seen.includes('event: invoice') && seen.includes('event: print')) && Date.now() < deadline) {
      const { value, done } = await reader.read(); if (done) break; seen += dec.decode(value);
    }
    ctrl.abort();
    assert.ok(seen.includes('event: invoice') && seen.includes('event: print'), seen);
  } finally { await api.close(); }
});
