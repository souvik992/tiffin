import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { Hub, HubError } from './hub.ts';
import type { PublishedMenu } from '../../contract/src/menu.ts';

/**
 * The hub's HTTP API (contract/openapi.yaml). Three kinds of callers:
 *   admin    X-Admin-Key header          create stores, pairing codes
 *   POS      Authorization: Bearer <device key>   publish menu/status, event stream (SSE), order actions
 *   customer open (CORS), rate limited   store page, quote, OTP, place/track/cancel orders, demo page
 */

export interface HttpOptions { adminKey?: string; heartbeatMs?: number; publicDir?: string }

interface Ctx { req: IncomingMessage; res: ServerResponse; params: Record<string, string>; query: URLSearchParams; body: unknown; ip: string }
type Handler = (c: Ctx) => unknown | Promise<unknown>;
interface Route { method: string; re: RegExp; keys: string[]; cors: boolean; maxBody: number; handler: Handler }

const json = (res: ServerResponse, status: number, body: unknown, cors = false) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(cors ? CORS : {}) });
  res.end(text);
};
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key, X-Order-Token', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Max-Age': '600' };

/** Requests per minute per IP and kind (simple fixed window). */
function limiter(perMinute: number) {
  const seen = new Map<string, { n: number; start: number }>();
  return (ip: string) => {
    const now = Date.now(), s = seen.get(ip);
    if (!s || now - s.start > 60_000) { seen.set(ip, { n: 1, start: now }); return; }
    if (++s.n > perMinute) throw new HubError('TOO_MANY_REQUESTS', 'Too many requests. Wait a minute and try again.', 429);
  };
}

export function createHubServer(hub: Hub, o: HttpOptions = {}): http.Server {
  const routes: Route[] = [];
  const add = (method: string, path: string, handler: Handler, opt: { cors?: boolean; maxBody?: number } = {}) => {
    const keys: string[] = [];
    const re = new RegExp('^' + path.replace(/:([a-zA-Z]+)/g, (_, k: string) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, cors: opt.cors ?? false, maxBody: opt.maxBody ?? 64 * 1024, handler });
  };
  const admin = (c: Ctx) => {
    const got = Buffer.from(String(c.req.headers['x-admin-key'] ?? ''));
    const want = Buffer.from(o.adminKey ?? '');
    if (!o.adminKey || got.length !== want.length || !timingSafeEqual(got, want)) throw new HubError('FORBIDDEN', 'Admin key required.', 403);
  };
  const device = (c: Ctx) => hub.device(/^Bearer (.+)$/.exec(String(c.req.headers.authorization ?? ''))?.[1]);
  const idem = (c: Ctx) => (typeof c.req.headers['idempotency-key'] === 'string' ? c.req.headers['idempotency-key'] : undefined);
  const orderToken = (c: Ctx) => (typeof c.req.headers['x-order-token'] === 'string' ? c.req.headers['x-order-token'] : c.query.get('token') ?? undefined);
  const otpLimit = limiter(5), orderLimit = limiter(20), pairLimit = limiter(10);
  const heartbeat = o.heartbeatMs ?? 15_000;

  add('GET', '/health', () => ({ ok: true }));

  // ---- admin
  add('POST', '/v1/admin/stores', (c) => { admin(c); const b = c.body as { slug?: string; name?: string }; return hub.createStore(String(b?.slug ?? ''), String(b?.name ?? '')); });
  add('POST', '/v1/admin/stores/:slug/pairing-code', (c) => { admin(c); return { pairingCode: hub.pairingCodeForSlug(c.params.slug!) }; });

  // ---- POS
  add('POST', '/v1/pos/pair', (c) => { pairLimit(c.ip); const b = c.body as { code?: string; deviceName?: string }; return hub.pair(String(b?.code ?? ''), String(b?.deviceName ?? 'POS')); });
  add('PUT', '/v1/pos/menu', (c) => hub.publishMenu(device(c), c.body as PublishedMenu), { maxBody: 4 * 1024 * 1024 });
  add('PUT', '/v1/pos/status', (c) => hub.setStatus(device(c), c.body as { accepting: boolean; reason?: string }));
  add('GET', '/v1/pos/orders', (c) => hub.openOrders(device(c)));
  for (const action of ['received', 'accept', 'reject', 'state'] as const) {
    add('POST', `/v1/pos/orders/:id/${action}`, (c) => hub.posAction(device(c), c.params.id!, action, (c.body ?? {}) as Record<string, unknown>, idem(c)));
  }
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
  add('GET', '/v1/stores/:slug', (c) => hub.storePublic(c.params.slug!), { cors: true });
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

  // ---- demo ordering page (phase 2 replaces it with the store apps)
  const pub = o.publicDir ?? join(import.meta.dirname, '..', 'public');
  add('GET', '/order/:slug', (c) => {
    const html = readFileSync(join(pub, 'order.html'), 'utf8').replace('__STORE__', JSON.stringify(decodeURIComponent(c.params.slug!)));
    c.res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:" });
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
      if (req.method !== 'GET') {
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
