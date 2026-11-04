import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { Hub, HubError } from './hub.ts';
import { UrbanPiper } from './urbanpiper.ts';
import type { PublishedMenu } from '../../contract/src/menu.ts';

/**
 * The hub's HTTP API (contract/openapi.yaml). Three kinds of callers:
 *   admin    X-Admin-Key header          stores, pairing codes, devices, pause, hub settings (the /admin page)
 *   POS      Authorization: Bearer <device key>   publish menu/status, event stream (SSE), order actions
 *   customer open (CORS), rate limited   store page, quote, OTP, place/track/cancel orders, demo page
 *   UrbanPiper  x-tiffin-token header   Swiggy / Zomato orders and callbacks (src/urbanpiper.ts)
 */

export interface HttpOptions {
  adminKey?: string; heartbeatMs?: number; publicDir?: string;
  /** The hub's address as shops reach it (HUB_PUBLIC_URL), for connection links. Not set: taken from the admin's request. */
  publicUrl?: string;
  /** Swiggy / Zomato through UrbanPiper. Not given: one is made here (it listens to the hub; make only one per hub). */
  urbanpiper?: UrbanPiper;
}

interface Ctx { req: IncomingMessage; res: ServerResponse; params: Record<string, string>; query: URLSearchParams; body: unknown; ip: string }
type Handler = (c: Ctx) => unknown | Promise<unknown>;
interface Route { method: string; re: RegExp; keys: string[]; cors: boolean; maxBody: number; raw: boolean; handler: Handler }

const json = (res: ServerResponse, status: number, body: unknown, cors = false) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(cors ? CORS : {}) });
  res.end(text);
};
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key, X-Order-Token, X-Site-Token', 'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS', 'Access-Control-Max-Age': '600' };

/** Requests per minute per IP and kind (simple fixed window). The limit is read on each request (admin settings). */
function limiter(perMinute: () => number) {
  const seen = new Map<string, { n: number; start: number }>();
  return (ip: string) => {
    const now = Date.now(), s = seen.get(ip);
    if (!s || now - s.start > 60_000) { seen.set(ip, { n: 1, start: now }); return; }
    if (++s.n > perMinute()) throw new HubError('TOO_MANY_REQUESTS', 'Too many requests. Wait a minute and try again.', 429);
  };
}

const PAGE_HEADERS = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' };

export function createHubServer(hub: Hub, o: HttpOptions = {}): http.Server {
  const routes: Route[] = [];
  const add = (method: string, path: string, handler: Handler, opt: { cors?: boolean; maxBody?: number; raw?: boolean } = {}) => {
    const keys: string[] = [];
    const re = new RegExp('^' + path.replace(/:([a-zA-Z]+)/g, (_, k: string) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, cors: opt.cors ?? false, maxBody: opt.maxBody ?? 64 * 1024, raw: opt.raw ?? false, handler });
  };
  // wrong admin keys: 10 per minute per IP, then refused for the rest of the minute (guessing is slowed down)
  const adminFails = new Map<string, { n: number; start: number }>();
  const admin = (c: Ctx) => {
    const now = Date.now(), f = adminFails.get(c.ip);
    if (f && now - f.start <= 60_000 && f.n >= 10) throw new HubError('TOO_MANY_REQUESTS', 'Too many wrong admin keys. Wait a minute and try again.', 429);
    const got = Buffer.from(String(c.req.headers['x-admin-key'] ?? ''));
    const want = Buffer.from(o.adminKey ?? '');
    if (!o.adminKey || got.length !== want.length || !timingSafeEqual(got, want)) {
      if (!f || now - f.start > 60_000) adminFails.set(c.ip, { n: 1, start: now }); else f.n++;
      throw new HubError('FORBIDDEN', o.adminKey ? 'Admin key required.' : 'Admin over the internet is off: start the hub with HUB_ADMIN_KEY set.', 403);
    }
  };
  const device = (c: Ctx) => hub.device(/^Bearer (.+)$/.exec(String(c.req.headers.authorization ?? ''))?.[1]);
  const idem = (c: Ctx) => (typeof c.req.headers['idempotency-key'] === 'string' ? c.req.headers['idempotency-key'] : undefined);
  const orderToken = (c: Ctx) => (typeof c.req.headers['x-order-token'] === 'string' ? c.req.headers['x-order-token'] : c.query.get('token') ?? undefined);
  const otpLimit = limiter(() => hub.settings().otpPerMinute), orderLimit = limiter(() => hub.settings().ordersPerMinute), pairLimit = limiter(() => hub.settings().pairPerMinute);
  const heartbeat = o.heartbeatMs ?? 15_000;

  const up = o.urbanpiper ?? new UrbanPiper(hub);
  add('GET', '/health', () => ({ ok: true }));

  // ---- website builder (the ordering website's /admin page): one store's editor password, then a token (X-Site-Token)
  const siteLoginLimit = limiter(() => 10);
  const siteToken = (c: Ctx) => (typeof c.req.headers['x-site-token'] === 'string' ? c.req.headers['x-site-token'] : undefined);
  add('POST', '/v1/site/:slug/login', (c) => { siteLoginLimit(c.ip); return hub.siteLogin(c.params.slug!, (c.body as { password?: unknown } | null)?.password); }, { cors: true });
  add('POST', '/v1/site/:slug/logout', (c) => hub.siteLogout(c.params.slug!, siteToken(c)), { cors: true });
  add('GET', '/v1/site/:slug', (c) => hub.siteForEditor(c.params.slug!, siteToken(c)), { cors: true });
  add('PUT', '/v1/site/:slug/draft', (c) => hub.saveSiteDraft(c.params.slug!, siteToken(c), (c.body as { site?: unknown } | null)?.site), { cors: true, maxBody: 256 * 1024 });
  add('POST', '/v1/site/:slug/publish', (c) => hub.publishSite(c.params.slug!, siteToken(c)), { cors: true });
  add('POST', '/v1/site/:slug/discard', (c) => hub.discardSiteDraft(c.params.slug!, siteToken(c)), { cors: true });
  add('PUT', '/v1/site/:slug/images/:name', (c) => hub.putSiteImage(c.params.slug!, siteToken(c), c.params.name!, (c.body as { dataBase64?: unknown } | null)?.dataBase64), { cors: true, maxBody: 2_100_000 });

  // ---- admin
  // A connection link carries the hub address and a one-use pairing code: the shop pastes only this into its POS.
  const base = (c: Ctx) => (o.publicUrl ?? `${String(c.req.headers['x-forwarded-proto'] ?? 'http').split(',')[0]!.trim()}://${String(c.req.headers['x-forwarded-host'] ?? c.req.headers.host ?? 'localhost')}`).replace(/\/+$/, '');
  const withLink = <T extends { pairingCode: string }>(c: Ctx, r: T) => ({ ...r, connectUrl: `${base(c)}/connect/${r.pairingCode}` });
  add('POST', '/v1/admin/stores', (c) => { admin(c); const b = c.body as { slug?: string; name?: string }; return withLink(c, hub.createStore(String(b?.slug ?? ''), String(b?.name ?? ''))); });
  add('POST', '/v1/admin/stores/:slug/pairing-code', (c) => { admin(c); return withLink(c, hub.pairingCodeWithExpiry(c.params.slug!)); });
  add('GET', '/v1/admin/stores/:slug', (c) => { admin(c); return hub.adminStore(c.params.slug!); });
  add('GET', '/v1/admin/orders', (c) => { admin(c); return hub.adminOrders({ slug: c.query.get('store') || undefined, status: c.query.get('status') ?? 'all', limit: Number(c.query.get('limit') ?? 100) }); });
  add('GET', '/v1/admin/overview', (c) => { admin(c); return hub.adminOverview(); });
  add('PUT', '/v1/admin/settings', (c) => { admin(c); return { settings: hub.saveSettings(c.body) }; });
  add('PUT', '/v1/admin/stores/:slug/pause', (c) => { admin(c); const b = (c.body ?? {}) as { paused?: unknown; reason?: unknown }; return hub.pauseStore(c.params.slug!, b.paused === true, b.reason); });
  add('GET', '/v1/admin/stores/:slug/sales', (c) => { admin(c); return hub.sync.sales(hub.store({ slug: c.params.slug! }).id, Number(c.query.get('days') ?? 14)); });
  add('GET', '/v1/admin/stores/:slug/licence', (c) => { admin(c); return hub.sync.licenceInfo(hub.store({ slug: c.params.slug! }).id); });
  add('PUT', '/v1/admin/stores/:slug/licence', (c) => { admin(c); return hub.sync.setLicence(hub.store({ slug: c.params.slug! }).id, (c.body as { key?: unknown } | null)?.key); });
  add('POST', '/v1/admin/stores/:slug/site-password', (c) => { admin(c); return hub.newSitePassword(c.params.slug!); });
  add('GET', '/v1/admin/stores/:slug/orders', (c) => { admin(c); return hub.adminOrders({ slug: c.params.slug!, limit: Number(c.query.get('limit') ?? 50) }); });
  add('POST', '/v1/admin/devices/:id/revoke', (c) => { admin(c); hub.revokeDevice(c.params.id!); return { ok: true }; });

  // ---- Swiggy / Zomato through UrbanPiper: the store's details (admin), and UrbanPiper's webhooks
  // the one UrbanPiper account (Hub settings)
  add('GET', '/v1/admin/urbanpiper', (c) => { admin(c); return up.accountView(base(c)); });
  add('PUT', '/v1/admin/urbanpiper', (c) => { admin(c); return up.saveAccount(c.body, base(c)); });
  add('DELETE', '/v1/admin/urbanpiper', (c) => { admin(c); return up.removeAccount(); });
  add('POST', '/v1/admin/urbanpiper/test', (c) => { admin(c); return up.test(); });
  add('POST', '/v1/admin/urbanpiper/webhooks', (c) => { admin(c); return up.setupWebhooks(base(c)); });
  // each store at UrbanPiper (store page)
  add('GET', '/v1/admin/stores/:slug/urbanpiper', (c) => { admin(c); return up.view(c.params.slug!); });
  add('PUT', '/v1/admin/stores/:slug/urbanpiper', (c) => { admin(c); return up.saveLink(c.params.slug!, c.body); });
  add('DELETE', '/v1/admin/stores/:slug/urbanpiper', (c) => { admin(c); return up.removeLink(c.params.slug!); });
  add('POST', '/v1/admin/stores/:slug/urbanpiper/store', (c) => { admin(c); return up.pushStore(c.params.slug!); });
  add('POST', '/v1/admin/stores/:slug/urbanpiper/menu', (c) => { admin(c); return up.pushMenu(c.params.slug!, base(c)); });
  add('POST', '/v1/urbanpiper/:bizId', (c) => up.webhook(c.params.bizId!, c.req.headers, c.body), { maxBody: 2 * 1024 * 1024 });

  // ---- POS
  add('POST', '/v1/pos/pair', (c) => { pairLimit(c.ip); const b = c.body as { code?: string; deviceName?: string }; return hub.pair(String(b?.code ?? ''), String(b?.deviceName ?? 'POS')); });
  add('PUT', '/v1/pos/menu', (c) => hub.publishMenu(device(c), c.body as PublishedMenu), { maxBody: 4 * 1024 * 1024 });
  add('PUT', '/v1/pos/status', (c) => hub.setStatus(device(c), c.body as { accepting: boolean; reason?: string }));
  add('GET', '/v1/pos/orders', (c) => hub.openOrders(device(c)));
  add('POST', '/v1/pos/sync/batches', (c) => hub.sync.receive(device(c), c.body), { maxBody: 4 * 1024 * 1024 }); // DinePOS sales sync
  add('GET', '/v1/pos/licence', (c) => hub.sync.licence(device(c)));
  add('GET', '/v1/pos/images', (c) => ({ names: hub.imageNames(device(c)) }));
  add('PUT', '/v1/pos/images/:name', (c) => hub.putImage(device(c), c.params.name!, (c.body as { dataBase64?: unknown } | null)?.dataBase64), { maxBody: 2_100_000 });
  add('POST', '/v1/pos/orders/:id/platform-action', (c) => up.platformAction(device(c), c.params.id!, c.body, idem(c))); // Swiggy / Zomato requests
  for (const action of ['received', 'accept', 'reject', 'state'] as const) {
    add('POST', `/v1/pos/orders/:id/${action}`, (c) => hub.posAction(device(c), c.params.id!, action, (c.body ?? {}) as Record<string, unknown>, idem(c)));
  }
  // online backups (src/backups.ts): binary bodies, streamed to and from disk
  const readRaw = async (c: Ctx, max: number) => {
    const chunks: Buffer[] = []; let size = 0;
    for await (const ch of c.req) { size += (ch as Buffer).length; if (size > max) throw new HubError('TOO_LARGE', 'Request too large.', 413); chunks.push(ch as Buffer); }
    return Buffer.concat(chunks);
  };
  const sendFile = (c: Ctx, type: string, bytes: number, stream: NodeJS.ReadableStream, extra: Record<string, string> = {}) => {
    c.res.writeHead(200, { 'Content-Type': type, 'Content-Length': bytes, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
    stream.pipe(c.res);
    return Symbol.for('handled');
  };
  add('GET', '/v1/pos/backups', (c) => ({ backups: hub.backups.list(device(c)) }));
  add('PUT', '/v1/pos/backups/:name', (c) => hub.backups.put(device(c), c.params.name!, c.req, String(c.req.headers['x-content-sha256'] ?? '').toLowerCase(), c.req.headers['content-length'] ? Number(c.req.headers['content-length']) : undefined), { raw: true });
  add('GET', '/v1/pos/backups/:name', (c) => { const f = hub.backups.open(device(c), c.params.name!); return sendFile(c, 'application/gzip', f.bytes, f.stream, f.sha256 ? { 'X-Content-SHA256': f.sha256 } : {}); });
  add('GET', '/v1/pos/backup-images', (c) => ({ names: hub.backups.imageNames(device(c)) }));
  add('PUT', '/v1/pos/backup-images/:name', async (c) => { const dev = device(c); return hub.backups.putImage(dev, c.params.name!, await readRaw(c, 2_000_000)); }, { raw: true });
  add('GET', '/v1/pos/backup-images/:name', (c) => { const b = hub.backups.image(device(c), c.params.name!); c.res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': b.length, 'Cache-Control': 'no-store' }); c.res.end(b); return Symbol.for('handled'); });
  add('GET', '/v1/pos/events', (c) => {
    const dev = device(c);
    const after = Number(c.req.headers['last-event-id'] ?? c.query.get('after') ?? 0) || 0;
    c.res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    c.res.write('retry: 3000\n\n');
    hub.streamOpened(dev.storeId);
    let last = after;
    const send = (ev: { seq: number; type: string }) => { if (ev.seq <= last) return; last = ev.seq; c.res.write(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`); };
    for (let batch = hub.eventsSince(dev.storeId, last); batch.length; batch = hub.eventsSince(dev.storeId, last)) for (const ev of batch) send(ev);
    const onEvent = (storeId: string, ev: { seq: number; type: string }) => { if (storeId === dev.storeId) send(ev); };
    hub.bus.on('pos', onEvent);
    const beat = setInterval(() => { try { c.res.write(': ping\n\n'); hub.streamOpened(dev.storeId); hub.streamClosed(dev.storeId); } catch { clearInterval(beat); } }, heartbeat);
    c.req.on('close', () => { clearInterval(beat); hub.bus.off('pos', onEvent); hub.streamClosed(dev.storeId); });
    return Symbol.for('handled');
  });

  // ---- customer
  add('GET', '/v1/stores/:slug', (c) => hub.storePublic(c.params.slug!, c.query.get('channel') === 'app' ? 'app' : 'website'), { cors: true });
  add('GET', '/v1/stores/:slug/images/:name', (c) => {
    const img = hub.image(c.params.slug!, c.params.name!);
    c.res.writeHead(200, { 'Content-Type': img.type, 'Content-Length': img.bytes.length, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', ...CORS });
    c.res.end(Buffer.from(img.bytes));
    return Symbol.for('handled');
  }, { cors: true });
  add('POST', '/v1/stores/:slug/quote', (c) => hub.quote(c.params.slug!, c.body as Parameters<Hub['quote']>[1]), { cors: true });
  add('POST', '/v1/stores/:slug/orders', async (c) => { orderLimit(c.ip); return hub.placeOrder(c.params.slug!, c.body, idem(c)); }, { cors: true });
  add('POST', '/v1/otp/send', (c) => { otpLimit(c.ip); return hub.otpSend(String((c.body as { mobile?: string })?.mobile ?? '')); }, { cors: true });
  add('POST', '/v1/otp/verify', (c) => { const b = c.body as { mobile?: string; otp?: string }; return hub.otpVerify(String(b?.mobile ?? ''), String(b?.otp ?? '')); }, { cors: true });
  add('GET', '/v1/orders/:id', (c) => hub.orderForCustomer(c.params.id!, orderToken(c)), { cors: true });
  add('POST', '/v1/orders/:id/cancel', (c) => hub.cancelByCustomer(c.params.id!, orderToken(c), (c.body as { reasonText?: string } | null)?.reasonText), { cors: true });
  add('GET', '/v1/orders/:id/events', (c) => {
    const order = hub.orderForCustomer(c.params.id!, orderToken(c));
    c.res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', ...CORS });
    c.res.write(`event: order.state\ndata: ${JSON.stringify({ type: 'order.state', orderId: order.id, state: order.state, order })}\n\n`);
    const on = (id: string, ev: unknown) => { if (id === order.id) c.res.write(`event: order.state\ndata: ${JSON.stringify({ ...(ev as object), order: hub.orderForCustomer(order.id, orderToken(c)) })}\n\n`); };
    hub.bus.on('customer', on);
    const beat = setInterval(() => c.res.write(': ping\n\n'), heartbeat);
    c.req.on('close', () => { clearInterval(beat); hub.bus.off('customer', on); });
    return Symbol.for('handled');
  }, { cors: true });

  const pub = o.publicDir ?? join(import.meta.dirname, '..', 'public');

  // ---- admin page (no secrets inside: it asks for the admin key and sends it with each call)
  add('GET', '/admin', (c) => {
    c.res.writeHead(200, { ...PAGE_HEADERS, 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; form-action 'none'" });
    c.res.end(readFileSync(join(pub, 'admin.html')));
    return Symbol.for('handled');
  });

  // ---- a connection link opened in a browser: says where to paste it (the code is not used up here)
  add('GET', '/connect/:code', (c) => {
    const code = c.params.code!.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 9);
    c.res.writeHead(200, { ...PAGE_HEADERS, 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
    c.res.end(readFileSync(join(pub, 'connect.html'), 'utf8').replace('__CODE__', code));
    return Symbol.for('handled');
  });

  // ---- demo ordering page (phase 2 replaces it with the store apps)
  add('GET', '/order/:slug', (c) => {
    const html = readFileSync(join(pub, 'order.html'), 'utf8').replace('__STORE__', JSON.stringify(decodeURIComponent(c.params.slug!)));
    c.res.writeHead(200, { ...PAGE_HEADERS, 'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:" });
    c.res.end(html);
    return Symbol.for('handled');
  });

  return http.createServer(async (req, res) => {
    let route: Route | undefined;
    try {
      const url = new URL(req.url ?? '/', 'http://hub');
      let params: Record<string, string> = {};
      let pathOk = false;
      for (const r of routes) {
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        pathOk = true;
        if (req.method === 'OPTIONS' && r.cors) { res.writeHead(204, CORS); res.end(); return; }
        if (r.method !== req.method) continue;
        route = r; params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)]));
        break;
      }
      if (!route) throw new HubError(pathOk ? 'METHOD_NOT_ALLOWED' : 'NOT_FOUND', pathOk ? 'Method not allowed.' : 'Not found.', pathOk ? 405 : 404);
      let body: unknown = null;
      if (req.method !== 'GET' && !route.raw) {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const ch of req) { size += (ch as Buffer).length; if (size > route.maxBody) throw new HubError('TOO_LARGE', 'Request too large.', 413); chunks.push(ch as Buffer); }
        const text = Buffer.concat(chunks).toString('utf8');
        if (text) { if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HubError('UNSUPPORTED_MEDIA_TYPE', 'Send JSON.', 415); try { body = JSON.parse(text); } catch { throw new HubError('BAD_JSON', 'The request is not valid JSON.', 400); } }
      }
      const out = await route.handler({ req, res, params, query: url.searchParams, body, ip: req.socket.remoteAddress ?? '?' });
      if (out === Symbol.for('handled')) return;
      json(res, req.method === 'POST' && /\/orders$/.test(url.pathname) ? 201 : 200, out ?? { ok: true }, route.cors);
    } catch (e) {
      if (res.headersSent) { res.end(); return; }
      if (e instanceof HubError) return json(res, e.status, { error: { code: e.code, message: e.message, details: e.details } }, route?.cors);
      console.error('hub error', e);
      json(res, 500, { error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.' } }, route?.cors);
    }
  });
}
