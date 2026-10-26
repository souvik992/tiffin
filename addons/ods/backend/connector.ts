import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Actor } from '../../../src/services/ctx.ts';
import type { HostApi } from '../../../src/addons/host.ts';
import type { Order, PlatformAction, PosEvent, RejectReason, Rider } from '../../../contract/src/types.ts';
import type { OrderState } from '../../../contract/src/order.ts';
import { priceOrder , channelPrice } from '../../../contract/src/menu.ts';
import type { PublishedMenu } from '../../../contract/src/menu.ts';
import { quote } from '../../../contract/src/serviceability.ts';
import { readOnlineConfig } from './onlineConfig.ts';
import { readServiceability } from './serviceability.ts';
import { listsItem, readMenuSync, savePublishedAt, SYNC_CHANNELS } from './store.ts';
import type { MenuSync, SyncChannel } from './store.ts';
import { readPrintOnAccept } from './store.ts';
import { enqueue, getOrder, listOrders, outboxDone, outboxFailed, pendingOutbox, readFeeTaxGroup, saveOrder, setState } from './store.ts';
import type { LocalOrder } from './store.ts';

/**
 * The POS side of online orders. While online orders are on and the POS is paired with a hub:
 *  - keeps one outgoing event stream (SSE) to the hub, resuming from the last event number after any drop (F1, F13);
 *  - stores every order locally before confirming it (received), so nothing is lost if the POS stops (F3);
 *  - sends every change through the outbox, retried with the same idempotency key until the hub answers (F2);
 *  - publishes the menu, options, serviceability and fee GST when they change, and "accepting" = a shift is open;
 *  - bills accepted orders through the POS billing code (HostApi.billing): GST bill + kitchen ticket.
 */

const KEY = 'ods_hub_key', URL_KEY = 'ods_hub_url', STORE = 'ods_hub_store', SEQ = 'ods_last_seq', MENU_HASH = 'ods_menu_hash', MENU_VER = 'ods_menu_version', IMAGES_SIG = 'ods_images_sig';
export type ConnState = 'off' | 'not-paired' | 'connecting' | 'connected' | 'retrying';
export interface ConnectorOptions { fetcher?: typeof fetch; retryMs?: number[]; tickMs?: number; prepDefault?: number }
export interface HubLink { paired: boolean; hubUrl: string | null; store: { slug: string; name: string } | null; state: ConnState; lastError: string | null; lastEventAt: number | null; accepting: boolean }

const CHANNEL: Record<Order['channel'], 'APP' | 'WEBSITE' | 'SWIGGY' | 'ZOMATO'> = { app: 'APP', website: 'WEBSITE', swiggy: 'SWIGGY', zomato: 'ZOMATO' };

/** Each item gets the channels that list it (only channels switched on); the hub shows a channel only its items. */
export function withChannels<T extends { id: string; price: number }>(items: T[], on: Record<SyncChannel, boolean>, sync: MenuSync): Array<T & { channels: SyncChannel[]; prices?: Partial<Record<SyncChannel, number>> }> {
  return items.map((i) => {
    const channels = SYNC_CHANNELS.filter((c) => on[c] && listsItem(sync[c], i.id));
    const own = channels.filter((c) => sync[c].pricing === 'custom').map((c) => [c, channelPrice(i.id, i.price, sync[c])] as const).filter(([, p]) => p !== i.price);
    return { ...i, channels, ...(own.length ? { prices: Object.fromEntries(own) } : {}) };
  });
}

export class Connector {
  host: HostApi;
  bus = new EventEmitter();
  private f: typeof fetch;
  private retry: number[];
  private tickMs: number;
  private prepDefault: number;
  private state: ConnState = 'off';
  private lastError: string | null = null;
  private lastEventAt: number | null = null;
  private abort: AbortController | null = null;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private wake: (() => void) | null = null;
  private flushing: Promise<void> | null = null;
  private loopDone: Promise<void> | null = null;

  constructor(host: HostApi, o: ConnectorOptions = {}) {
    this.host = host;
    this.f = o.fetcher ?? fetch;
    this.retry = o.retryMs ?? [1000, 2000, 5000, 10_000, 30_000];
    this.tickMs = o.tickMs ?? 15_000;
    this.prepDefault = o.prepDefault ?? 20;
  }

  // ---------------------------------------------------------------- pairing and status

  link(): HubLink {
    const store = this.host.getSetting(STORE);
    return {
      paired: Boolean(this.host.getSetting(KEY)), hubUrl: this.host.getSetting(URL_KEY) || null, store: store ? JSON.parse(store) as { slug: string; name: string } : null,
      state: this.state, lastError: this.lastError, lastEventAt: this.lastEventAt, accepting: this.host.billing.shiftActor(this.host.ctx) !== null,
    };
  }

  /** Pairs with the hub: a connection link from the hub admin page (<hub address>/connect/<code>), or an address and a code. */
  async pair(actor: Actor, hubUrlIn: string, codeIn: string) {
    this.host.assertPerm(actor, 'settings.write');
    let hubUrl = String(hubUrlIn ?? '').trim().replace(/\/+$/, '');
    let code = String(codeIn ?? '').trim();
    if (!code) {
      const m = /^(.+?)\/connect\/([A-Za-z0-9]{4}-?[A-Za-z0-9]{4})$/.exec(hubUrl);
      if (!m) throw new this.host.AppError('VALIDATION', 'Paste the whole connection link from the order hub, for example https://orders.example.in/connect/ABCD-EFGH');
      hubUrl = m[1]!; code = m[2]!.toUpperCase();
    }
    if (!/^https?:\/\/[^\s/]+(:\d+)?(\/[^\s]*)?$/.test(hubUrl)) throw new this.host.AppError('VALIDATION', 'Enter the hub address, for example https://orders.example.in');
    // the device key travels on this connection: plain http only to a hub on this same PC (testing)
    if (/^http:/.test(hubUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(hubUrl)) throw new this.host.AppError('VALIDATION', 'The hub address must start with https:// (a secure connection).');
    const outlet = this.host.db.get<{ name: string }>('SELECT name FROM outlet LIMIT 1');
    let r: Response;
    try {
      r = await this.f(`${hubUrl}/v1/pos/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, deviceName: `${outlet?.name ?? 'POS'} counter` }), signal: AbortSignal.timeout(10_000) });
    } catch { throw new this.host.AppError('HUB_UNREACHABLE', 'The order hub could not be reached. Check the address and the internet connection.', 503); }
    const j = await r.json().catch(() => null) as { deviceKey?: string; slug?: string; name?: string; error?: { message?: string } } | null;
    if (!r.ok || !j?.deviceKey) throw new this.host.AppError('PAIRING_FAILED', j?.error?.message ?? 'The hub did not accept the pairing code.', 400);
    this.host.setSetting(URL_KEY, hubUrl);
    this.host.setSetting(KEY, j.deviceKey);
    this.host.setSetting(STORE, JSON.stringify({ slug: j.slug, name: j.name }));
    this.host.setSetting(SEQ, '0');
    this.host.setSetting(MENU_HASH, '');
    this.host.audit(this.host.ctx, actor.userId, 'ods.hub.pair', 'settings', URL_KEY, { hubUrl, store: j.slug });
    this.refresh();
    return this.link();
  }

  unpair(actor: Actor) {
    this.host.assertPerm(actor, 'settings.write');
    for (const k of [KEY, URL_KEY, STORE]) this.host.setSetting(k, '');
    this.host.audit(this.host.ctx, actor.userId, 'ods.hub.unpair', 'settings', URL_KEY);
    this.refresh();
    return this.link();
  }

  // ---------------------------------------------------------------- run loop

  /** Start, stop or restart according to the settings (online orders on + paired). */
  refresh() {
    const should = readOnlineConfig(this.host).enabled && Boolean(this.host.getSetting(KEY));
    if (should && !this.running) { this.running = true; this.loopDone = this.loop().catch((e) => this.host.log.warn('order hub connection stopped', String(e))); this.startTimer(); }
    else if (!should && this.running) void this.stop();
    else if (should) { void this.publish().catch(() => {}); this.wake?.(); }
    if (!should) this.setConn(this.host.getSetting(KEY) ? 'off' : 'not-paired');
  }

  /** Stops and waits until nothing of the connector is still running (the POS closes the database right after). */
  async stop() {
    this.running = false;
    this.abort?.abort();
    this.wake?.();
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    await this.loopDone;
    await this.flushing;
    this.loopDone = null;
  }

  private setConn(s: ConnState, err: string | null = this.lastError) {
    this.state = s; this.lastError = err;
    this.bus.emit('change');
  }

  private startTimer() {
    this.timer = setInterval(() => { if (!this.running) return; void this.publish().catch(() => {}); void this.flush(); }, this.tickMs);
    this.timer.unref?.();
  }

  private async loop() {
    let attempt = 0;
    while (this.running) {
      this.setConn('connecting');
      try {
        await this.publish();
        await this.flush();
        await this.stream(() => { attempt = 0; this.setConn('connected', null); });
        if (!this.running) break;
        throw new Error('the hub closed the connection');
      } catch (e) {
        if (!this.running) break;
        const msg = (e as Error).name === 'AbortError' ? 'connection lost' : (e as Error).message;
        this.setConn('retrying', msg);
        const wait = this.retry[Math.min(attempt++, this.retry.length - 1)]!;
        await new Promise<void>((r) => { const t = setTimeout(r, wait); this.wake = () => { clearTimeout(t); r(); }; });
        this.wake = null;
      }
    }
    this.state = 'off'; // no database access here: the POS may be closing it
    this.bus.emit('change');
  }

  private headers(extra: Record<string, string> = {}) { return { authorization: `Bearer ${this.host.getSetting(KEY)}`, ...extra }; }
  private url(p: string) { return `${this.host.getSetting(URL_KEY)}${p}`; }

  private async stream(onOpen: () => void) {
    this.abort = new AbortController();
    if (!this.running) return; // stop() came while publishing: do not connect
    const last = Number(this.host.getSetting(SEQ) || 0);
    const r = await this.f(this.url('/v1/pos/events'), { headers: this.headers({ 'last-event-id': String(last), accept: 'text/event-stream' }), signal: this.abort.signal });
    if (r.status === 401) { this.running = false; throw new Error('This POS is no longer connected to the hub. Pair it again.'); }
    if (!r.ok || !r.body) throw new Error(`the hub answered ${r.status}`);
    onOpen();
    // silence for 3 heartbeats (45 s) means the line is dead: reconnect
    let silence: NodeJS.Timeout | null = null;
    const arm = () => { if (silence) clearTimeout(silence); silence = setTimeout(() => this.abort?.abort(), this.tickMs * 3); };
    arm();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
        if (!this.running) break;
        arm();
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
          if (data) this.handle(JSON.parse(data) as PosEvent);
        }
      }
    } finally { if (silence) clearTimeout(silence); }
  }

  /** One hub event, applied once (events at or below the stored number are ignored: F4). */
  handle(ev: PosEvent) {
    if (ev.seq <= Number(this.host.getSetting(SEQ) || 0)) return;
    let autoAccept: string | null = null;
    this.host.db.tx(() => {
      if (ev.type === 'order.created') {
        if (!getOrder(this.host, ev.order.id)) {
          saveOrder(this.host, ev.order);
          enqueue(this.host, ev.order.id, 'received', {}, `rcv-${ev.order.id}`);
          if (readOnlineConfig(this.host).acceptMode === 'auto') autoAccept = ev.order.id;
        }
      } else if (ev.type === 'order.cancelled') {
        const o = getOrder(this.host, ev.orderId);
        const who = ev.by === 'aggregator' ? `${o?.order.channel === 'zomato' ? 'Zomato' : 'Swiggy'} cancelled it${ev.reasonText ? ` (${ev.reasonText})` : ''}` : 'The customer cancelled';
        if (o) setState(this.host, ev.orderId, 'CANCELLED', { alert: o.billInvoiceId ? `${who}. Cancel bill ${o.billNo} (manager approval).` : `${who}.`, patch: { reasonText: ev.reasonText } });
      } else if (ev.type === 'order.rider') {
        // Swiggy / Zomato rider: who, and how far (assigned, at the store, out for delivery)
        const o = getOrder(this.host, ev.orderId);
        if (o) setState(this.host, ev.orderId, o.state, { patch: { rider: ev.rider, ...(o.order.external ? { external: { ...o.order.external, riderStatus: ev.riderStatus } } : {}) } });
      } else if (ev.type === 'order.notice') {
        // Swiggy / Zomato: the customer's number, a PIN to call, a request the platform did not take
        const o = getOrder(this.host, ev.orderId);
        if (o) setState(this.host, ev.orderId, o.state, { alert: ev.text });
      } else if (ev.type === 'order.auto_rejected') {
        if (getOrder(this.host, ev.orderId)) setState(this.host, ev.orderId, 'AUTO_REJECTED', { alert: 'Not accepted in time: the hub rejected it.' });
      } else if (ev.type === 'order.updated') {
        const o = getOrder(this.host, ev.orderId);
        if (o && o.state !== ev.state) setState(this.host, ev.orderId, ev.state, { alert: !o.billInvoiceId && ev.state === 'ACCEPTED' ? 'Accepted on another counter.' : o.alert }); // F12
      }
      this.host.setSetting(SEQ, String(ev.seq));
    });
    this.lastEventAt = this.host.ctx.clock.now();
    this.bus.emit('change');
    void this.flush();
    if (autoAccept) {
      const actor = this.host.billing.shiftActor(this.host.ctx);
      if (actor) { try { this.accept(actor, autoAccept, null, `auto-${autoAccept}`); } catch (e) { setState(this.host, autoAccept, getOrder(this.host, autoAccept)!.state, { alert: `Automatic accept failed: ${(e as Error).message} Accept or reject it by hand.` }); this.bus.emit('change'); } }
    }
  }

  // ---------------------------------------------------------------- what the POS publishes

  async publish(force = false) {
    if (!this.running || !this.host.getSetting(KEY)) return;
    const cfg = readOnlineConfig(this.host);
    const svc = readServiceability(this.host);
    const m = this.host.billing.menu(this.host.ctx);
    const feeGroup = readFeeTaxGroup(this.host);
    const t = feeGroup ? m.taxGroups.find((g) => g.id === feeGroup) : null;
    const outlet = this.host.db.get<{ name: string }>('SELECT name FROM outlet LIMIT 1');
    const { updatedAt: _u, ...serviceability } = svc;
    const body: Omit<PublishedMenu, 'version'> = {
      storeName: outlet?.name ?? 'Store', categories: m.categories, items: withChannels(m.items, cfg.channels, readMenuSync(this.host)), modifierGroups: m.modifierGroups, roundToRupee: m.roundToRupee,
      feeTax: t ? { rateBp: t.rateBp, cessBp: t.cessBp, priceIncludesTax: t.priceIncludesTax } : null,
      options: { acceptMode: cfg.acceptMode, acceptTimeoutMin: cfg.acceptTimeoutMin, channels: cfg.channels, fulfilment: cfg.fulfilment, payments: cfg.payments },
      serviceability,
    };
    const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    if (force || hash !== this.host.getSetting(MENU_HASH)) {
      const version = Number(this.host.getSetting(MENU_VER) || 0) + 1;
      const r = await this.f(this.url('/v1/pos/menu'), { method: 'PUT', headers: this.headers({ 'content-type': 'application/json' }), body: JSON.stringify({ ...body, version }), signal: AbortSignal.timeout(15_000) });
      if (!r.ok) throw new Error(`publishing the menu failed (${r.status})`);
      this.host.setSetting(MENU_VER, String(version));
      this.host.setSetting(MENU_HASH, hash);
      savePublishedAt(this.host, Date.now());
    }
    await this.syncImages(m.items);
    const actor = this.host.billing.shiftActor(this.host.ctx);
    await this.f(this.url('/v1/pos/status'), { method: 'PUT', headers: this.headers({ 'content-type': 'application/json' }), body: JSON.stringify(actor ? { accepting: true } : { accepting: false, reason: 'The store is not taking orders right now.' }), signal: AbortSignal.timeout(10_000) });
  }

  /** Menu photos: only the ones the hub does not have yet (each is checked there against its content-named file). */
  private async syncImages(items: Array<{ image?: string | null }>) {
    const readImage = (this.host.billing as { image?: (ctx: unknown, f: string) => { bytes: Buffer; type: string } | null }).image;
    if (!readImage) return; // a POS older than 0.3.3 cannot give the photos
    const want = [...new Set(items.map((i) => i.image).filter((x): x is string => typeof x === 'string'))];
    const sig = createHash('sha256').update(want.join(',')).digest('hex');
    if (sig === this.host.getSetting(IMAGES_SIG)) return;
    const r = await this.f(this.url('/v1/pos/images'), { headers: this.headers(), signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return;
    const have = new Set(((await r.json()) as { names?: string[] }).names ?? []);
    for (const name of want) {
      if (have.has(name) || !this.running) continue;
      const img = readImage(this.host.ctx, name);
      if (!img) continue;
      const up = await this.f(this.url(`/v1/pos/images/${encodeURIComponent(name)}`), { method: 'PUT', headers: this.headers({ 'content-type': 'application/json' }), body: JSON.stringify({ dataBase64: img.bytes.toString('base64') }), signal: AbortSignal.timeout(30_000) });
      if (!up.ok) return; // tried again on the next publish
    }
    this.host.setSetting(IMAGES_SIG, sig);
  }

  /** Sends waiting changes to the hub, in order. Network trouble: try again later. A refusal (409): resolved locally. */
  /** Sends waiting changes (only while connected; they wait safely in the outbox otherwise). */
  flush(): Promise<void> {
    if (this.flushing || !this.running || !this.host.getSetting(KEY)) return this.flushing ?? Promise.resolve();
    this.flushing = this.flushOnce().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  private async flushOnce() {
    {
      for (const row of pendingOutbox(this.host)) {
        if (!this.running) break;
        let r: Response;
        try {
          r = await this.f(this.url(`/v1/pos/orders/${encodeURIComponent(row.order_id)}/${row.action}`), { method: 'POST', headers: this.headers({ 'content-type': 'application/json', 'idempotency-key': row.idem_key }), body: row.body_json, signal: AbortSignal.timeout(10_000) });
        } catch (e) { outboxFailed(this.host, row.id, (e as Error).message); break; }
        const j = await r.json().catch(() => null) as { state?: OrderState; error?: { code?: string; message?: string; details?: { state?: OrderState } } } | null;
        if (r.ok) { outboxDone(this.host, row.id); continue; }
        if (r.status === 409 || r.status === 404 || r.status === 400) {
          outboxDone(this.host, row.id, j?.error?.message ?? String(r.status));
          const o = getOrder(this.host, row.order_id);
          if (o && row.action === 'accept') { // F11: the customer cancelled (or the hub auto-rejected) before the accept arrived
            setState(this.host, row.order_id, j?.error?.details?.state ?? 'CANCELLED', { alert: `The hub refused the accept (${j?.error?.message ?? 'order closed'}). Cancel bill ${o.billNo} (manager approval).` });
            this.bus.emit('change');
          }
          if (o && row.action === 'platform-action') { setState(this.host, row.order_id, o.state, { alert: `Not sent to ${o.order.channel === 'zomato' ? 'Zomato' : 'Swiggy'}: ${j?.error?.message ?? r.status}` }); this.bus.emit('change'); }
          continue;
        }
        outboxFailed(this.host, row.id, `hub answered ${r.status}`);
        break;
      }
    }
  }

  // ---------------------------------------------------------------- staff actions (ODS screen)

  orders() { return listOrders(this.host); }

  /** The POS's own price for the order now (menu and serviceability on this POS). Differs from the customer's total only if something changed since the order was placed (F5). */
  /** The channel's own price for an item when that channel does not use the POS price (worked out here from POS settings). */
  private billPrice(channel: string, itemId: string): { channelPrice?: number } {
    const sync = readMenuSync(this.host)[channel as SyncChannel];
    if (!sync || sync.pricing !== 'custom') return {};
    const item = this.host.billing.menu(this.host.ctx).items.find((i) => i.id === itemId);
    return item ? { channelPrice: channelPrice(item.id, item.price, sync) } : {};
  }

  posPrice(o: Order): { total: number; deliveryFee: number; packagingFee: number; differs: boolean; problem: string | null } {
    const m = this.host.billing.menu(this.host.ctx);
    const svc = readServiceability(this.host);
    const feeGroup = readFeeTaxGroup(this.host);
    const t = feeGroup ? m.taxGroups.find((g) => g.id === feeGroup) : null;
    const sync = readMenuSync(this.host)[o.channel as SyncChannel];
    const menu = { items: sync ? m.items.map((i) => ({ ...i, price: channelPrice(i.id, i.price, sync) })) : m.items, modifierGroups: m.modifierGroups as PublishedMenu['modifierGroups'], roundToRupee: m.roundToRupee, feeTax: t ? { rateBp: t.rateBp, cessBp: t.cessBp, priceIncludesTax: t.priceIncludesTax } : null };
    const cart = o.lines.map((l) => ({ itemId: l.itemId, qtyMilli: l.qtyMilli, modifierIds: l.modifiers.map((x) => x.id), note: l.note }));
    const items = priceOrder(menu, cart);
    if (!items.ok) return { total: o.total, deliveryFee: o.deliveryFee, packagingFee: o.packagingFee, differs: true, problem: items.message };
    let deliveryFee = 0, packagingFee = 0;
    if (o.external) { deliveryFee = o.deliveryFee; packagingFee = o.packagingFee; } // Swiggy / Zomato set their own charges
    else if (o.fulfilment === 'DELIVERY' && o.location) {
      const q = quote(svc, { fulfilment: 'DELIVERY', to: o.location, itemsTotal: items.itemsTotal, measuredRoadKm: o.distanceKm });
      deliveryFee = q.ok ? q.deliveryFee : o.deliveryFee; packagingFee = q.ok ? q.packagingFee : o.packagingFee;
    } else if (o.fulfilment === 'PICKUP') packagingFee = svc.packagingFee;
    const all = priceOrder(menu, cart, { delivery: deliveryFee, packaging: packagingFee });
    const total = all.ok ? all.total : o.total;
    return { total, deliveryFee, packagingFee, differs: total !== o.total, problem: all.ok ? null : all.message };
  }

  /** Accept = GST bill + kitchen ticket now, then tell the hub (outbox). Retry-safe: the hub order number identifies the bill. */
  accept(actor: Actor, orderId: string, prepMinutes: number | null, requestId: string, acceptPriceChange = false): LocalOrder {
    const lo = getOrder(this.host, orderId);
    if (!lo) throw new this.host.AppError('NOT_FOUND', 'Order not found.', 404);
    if (lo.billInvoiceId) return lo;
    if (lo.state !== 'SENT_TO_STORE' && lo.state !== 'RECEIVED') throw new this.host.AppError('ORDER_CLOSED', 'This order can no longer be accepted.', 409);
    const o = lo.order;
    const price = this.posPrice(o);
    if (price.differs && !acceptPriceChange) throw new this.host.AppError('PRICE_DIFFERS', price.problem ?? `The POS price is now Rs ${(price.total / 100).toFixed(2)}; the customer was charged Rs ${(o.total / 100).toFixed(2)}. Accept at the POS price, or reject.`, 409, { posTotal: price.total, customerTotal: o.total });
    const svc = readServiceability(this.host);
    const prep = prepMinutes ?? (o.fulfilment === 'PICKUP' ? svc.pickup.etaMinutes : this.prepDefault);
    if (!Number.isInteger(prep) || prep < 1 || prep > 180) throw new this.host.AppError('VALIDATION', 'Preparation time must be 1 to 180 minutes.');
    const printOnAccept = readPrintOnAccept(this.host);
    const who = o.customer.name ? `${o.customer.name} ` : '';
    const addr = o.address ? ` | ${o.address.line1}${o.address.landmark ? `, ${o.address.landmark}` : ''}, ${o.address.pincode}` : '';
    const bill = this.host.billing.bill(this.host.ctx, actor, `ods-${requestId}`.slice(0, 120), {
      channel: CHANNEL[o.channel], externalId: o.number, customerPhone: o.customer.mobile, customerName: o.customer.name?.slice(0, 60) ?? null,
      note: `${o.number} ${o.fulfilment === 'DELIVERY' ? 'DELIVERY' : 'PICKUP'} ${who}${o.customer.mobile}${addr}${o.note ? ` | ${o.note}` : ''}`.slice(0, 300),
      lines: o.lines.map((l) => ({ itemId: l.itemId, qtyMilli: l.qtyMilli, modifierIds: l.modifiers.map((m) => m.id), note: l.note, ...this.billPrice(o.channel, l.itemId) })),
      fees: { delivery: price.deliveryFee, packaging: price.packagingFee, taxGroupId: readFeeTaxGroup(this.host) },
      // Swiggy / Zomato pay the store later (OTHER), unless the store's own rider collects cash
      paymentMode: o.external ? (o.payment === 'COD' && o.external.deliveredBy === 'store' ? 'CASH' : 'OTHER') : o.payment === 'COD' ? 'CASH' : 'UPI',
      fulfilment: o.fulfilment,
      print: { receipt: printOnAccept.bill, kot: printOnAccept.kot }, // POS 0.3.11; older POS print both
    });
    this.host.db.tx(() => {
      setState(this.host, orderId, 'ACCEPTED', { billInvoiceId: bill.invoiceId, billNo: bill.invoiceNo, billTotal: bill.grandTotal, alert: price.differs ? `Billed at the POS price Rs ${(bill.grandTotal / 100).toFixed(2)} (customer was shown Rs ${(o.total / 100).toFixed(2)}).` : null, patch: { prepMinutes: prep, posBillNo: bill.invoiceNo } });
      enqueue(this.host, orderId, 'accept', { prepMinutes: prep, posBillNo: bill.invoiceNo }, `acc-${orderId}`);
    });
    this.bus.emit('change');
    void this.flush();
    return getOrder(this.host, orderId)!;
  }

  reject(actor: Actor, orderId: string, reason: RejectReason, reasonText: string | null) {
    this.host.assertPerm(actor, 'order.write');
    const lo = getOrder(this.host, orderId);
    if (!lo) throw new this.host.AppError('NOT_FOUND', 'Order not found.', 404);
    if (lo.state !== 'SENT_TO_STORE' && lo.state !== 'RECEIVED') throw new this.host.AppError('ORDER_CLOSED', 'This order can no longer be rejected; cancel it instead.', 409);
    this.host.db.tx(() => {
      setState(this.host, orderId, 'REJECTED', { patch: { rejectReason: reason, reasonText } });
      enqueue(this.host, orderId, 'reject', { reason, reasonText }, `rej-${orderId}`);
    });
    this.host.audit(this.host.ctx, actor.userId, 'ods.reject', 'ods_order', orderId, { reason });
    this.bus.emit('change');
    void this.flush();
    return getOrder(this.host, orderId)!;
  }

  /** Preparing, ready, out for delivery (rider), delivered, picked up; or cancel after accepting (cancels the bill). */
  step(actor: Actor, orderId: string, to: OrderState, extra: { rider?: Rider; reasonText?: string; override?: { userId: string; pin: string } } = {}) {
    this.host.assertPerm(actor, 'order.write');
    const lo = getOrder(this.host, orderId);
    if (!lo) throw new this.host.AppError('NOT_FOUND', 'Order not found.', 404);
    if (to === 'CANCELLED') {
      const reason = (extra.reasonText ?? '').trim();
      if (!reason) throw new this.host.AppError('VALIDATION', 'Give a reason for cancelling.');
      if (lo.billInvoiceId) this.host.billing.cancel(this.host.ctx, actor, `ods-cancel-${orderId}`, { invoiceId: lo.billInvoiceId, reason: `${lo.number}: ${reason}`, override: extra.override });
      this.host.db.tx(() => {
        setState(this.host, orderId, 'CANCELLED', { alert: null, patch: { reasonText: reason } });
        if (!['CANCELLED', 'REJECTED', 'AUTO_REJECTED'].includes(lo.state)) enqueue(this.host, orderId, 'state', { to: 'CANCELLED', reasonText: reason }, `st-${orderId}-CANCELLED`);
      });
    } else {
      if (to === 'OUT_FOR_DELIVERY' && !extra.rider?.name?.trim()) throw new this.host.AppError('VALIDATION', 'Enter the rider name.');
      this.host.db.tx(() => {
        setState(this.host, orderId, to, { patch: extra.rider ? { rider: extra.rider } : {} });
        enqueue(this.host, orderId, 'state', { to, ...(extra.rider ? { rider: extra.rider } : {}) }, `st-${orderId}-${to}`);
      });
    }
    this.bus.emit('change');
    void this.flush();
    return getOrder(this.host, orderId)!;
  }

  /** The ODS's Bill and KOT buttons: the first print needs no approval (printing on accepting may be off); a reprint needs a manager. */
  print(actor: Actor, orderId: string, what: 'bill' | 'kot', requestId: string, override?: { userId: string; pin: string }) {
    const lo = getOrder(this.host, orderId);
    if (!lo) throw new this.host.AppError('NOT_FOUND', 'Order not found.', 404);
    if (!lo.billInvoiceId) throw new this.host.AppError('NOT_BILLED', 'Accept the order first: it has no bill yet.', 409);
    if (!this.host.printing) throw new this.host.AppError('UPDATE_POS', 'Update the POS to print from the ODS (POS 0.3.11 or newer).', 409);
    const r = what === 'bill' ? this.host.printing.bill(actor, `ods-print-${requestId}`.slice(0, 120), lo.billInvoiceId, override) : this.host.printing.kot(actor, `ods-kot-${requestId}`.slice(0, 120), lo.billInvoiceId, override);
    this.host.audit(this.host.ctx, actor.userId, `ods.print_${what}`, 'ods_order', orderId);
    return r;
  }

  /** Swiggy / Zomato requests about one order (items out of stock, customer's number, extra rider, rider check). Checked
   * here for what the POS knows; the hub checks the rest and the platform's answer comes back as a notice on the order. */
  platformAction(actor: Actor, orderId: string, input: PlatformAction, requestId: string) {
    this.host.assertPerm(actor, 'order.write');
    const lo = getOrder(this.host, orderId);
    if (!lo) throw new this.host.AppError('NOT_FOUND', 'Order not found.', 404);
    const x = lo.order.external;
    if (!x) throw new this.host.AppError('NOT_PLATFORM_ORDER', 'This is not a Swiggy or Zomato order.', 409);
    if (['REJECTED', 'AUTO_REJECTED', 'CANCELLED', 'DELIVERED', 'PICKED_UP'].includes(lo.state)) throw new this.host.AppError('ORDER_CLOSED', 'This order is already finished.', 409);
    let body: PlatformAction;
    if (input.action === 'items_out_of_stock') {
      if (x.platform !== 'swiggy') throw new this.host.AppError('NOT_SUPPORTED', 'Only Swiggy takes out-of-stock items on an order. For Zomato, reject or cancel the order.', 409);
      const ids = [...new Set((Array.isArray(input.itemIds) ? input.itemIds : []).map(String))].filter((id) => lo.order.lines.some((l) => l.itemId === id));
      if (!ids.length) throw new this.host.AppError('VALIDATION', 'Choose the items that ran out.');
      body = { action: 'items_out_of_stock', itemIds: ids, allowEdit: input.allowEdit === true };
    } else if (input.action === 'extra_rider' || input.action === 'customer_phone') {
      if (x.platform !== 'zomato') throw new this.host.AppError('NOT_SUPPORTED', 'This is a Zomato request.', 409);
      body = { action: input.action };
    } else if (input.action === 'rider_check') {
      if (x.platform !== 'zomato') throw new this.host.AppError('NOT_SUPPORTED', 'This is a Zomato request.', 409);
      const temp = Number(input.temperatureF);
      if (!(temp >= 90 && temp <= 110)) throw new this.host.AppError('VALIDATION', "Enter the rider's temperature in °F (90 to 110).");
      body = { action: 'rider_check', temperatureF: temp, wearingMask: input.wearingMask === true, riderPhone: input.riderPhone ? String(input.riderPhone).replace(/\D/g, '').slice(-10) : null };
    } else throw new this.host.AppError('VALIDATION', 'Unknown request.');
    enqueue(this.host, orderId, 'platform-action', body, `pa-${requestId}`.slice(0, 120));
    this.host.audit(this.host.ctx, actor.userId, 'ods.platform_action', 'ods_order', orderId, { action: body.action });
    void this.flush();
    return getOrder(this.host, orderId)!;
  }

  newRequestId() { return randomUUID(); }
}
