import { EventEmitter } from 'node:events';
import { randomBytes, randomInt, randomUUID, createHash } from 'node:crypto';
import { exec, hash, many, one, openHubDb, tx } from './db.ts';
import type { Db } from './db.ts';
import { canTransition, label, needsRefund } from '../../contract/src/order.ts';
import type { OrderFacts, OrderState } from '../../contract/src/order.ts';
import { REJECT_REASONS } from '../../contract/src/types.ts';
import type { CustomerEvent, Order, PosEvent, RejectReason, Rider } from '../../contract/src/types.ts';
import { checkPlaceOrder, MOBILE_RE, normaliseMobile } from '../../contract/src/validate.ts';
import { checkServiceability, isOpen, quote } from '../../contract/src/serviceability.ts';
import { priceOrder } from '../../contract/src/menu.ts';
import type { PublishedMenu } from '../../contract/src/menu.ts';

/**
 * The online order hub: stores and their paired POS devices, published menus, customer orders, and the numbered event
 * log each POS reads over its event stream. Every order change follows contract/src/order.ts; anything else is refused.
 * Prices are always recomputed here from the published menu (contract/src/menu.ts); the POS bill stays the legal record.
 */

export class HubError extends Error {
  code: string; status: number; details?: unknown;
  constructor(code: string, message: string, status = 400, details?: unknown) { super(message); this.code = code; this.status = status; this.details = details; }
}

export interface HubOptions {
  dbPath: string;
  now?: () => number;
  /** Return OTP codes in the API response (development and the demo page only). */
  devOtp?: boolean;
  sendSms?: (mobile: string, text: string) => Promise<void>;
  /** Road distance in km from a routing service, or null to use the store's road factor. */
  roadKm?: (from: { lat: number; lng: number }, to: { lat: number; lng: number }) => Promise<number | null>;
  /** Online payment (phase 3) is off until a payment gateway is set up. */
  onlinePayments?: boolean;
  /** A store is "offline" this long after its last POS event stream closed (F8). */
  offlineAfterMs?: number;
  log?: { info(m: string, d?: unknown): void; warn(m: string, d?: unknown): void };
}
export interface DeviceRef { deviceId: string; storeId: string; slug: string }

interface StoreRow { id: string; slug: string; name: string; menu_json: string | null; menu_version: number; accepting: number; accepting_reason: string | null; order_counter: number; last_seen_at: number | null }
interface OrderRow { id: string; store_id: string; number: string; state: OrderState; data_json: string; access_hash: string; accept_by: number | null }

const SLUG = /^[a-z0-9][a-z0-9-]{2,40}$/;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const OTP_TTL = 5 * 60_000, OTP_TOKEN_TTL = 30 * 86_400_000, PAYMENT_TTL = 15 * 60_000;

export class Hub {
  db: Db;
  now: () => number;
  bus = new EventEmitter();
  private opts: HubOptions;
  /** open POS event streams per store, and when the last one closed */
  private streams = new Map<string, number>();
  private closedAt = new Map<string, number>();

  constructor(opts: HubOptions) {
    this.opts = opts;
    this.db = openHubDb(opts.dbPath);
    this.now = opts.now ?? Date.now;
    this.bus.setMaxListeners(0);
  }
  close() { this.db.close(); }

  // ---------------------------------------------------------------- stores, pairing, devices

  createStore(slug: string, name: string) {
    if (!SLUG.test(slug)) throw new HubError('VALIDATION', 'The store address must be 3-41 lowercase letters, digits or dashes.');
    if (!name.trim() || name.length > 80) throw new HubError('VALIDATION', 'Enter the store name.');
    if (one(this.db, 'SELECT 1 FROM store WHERE slug = ?', slug)) throw new HubError('SLUG_TAKEN', 'That store address is already used.', 409);
    const id = randomUUID();
    exec(this.db, 'INSERT INTO store (id, slug, name, created_at) VALUES (?,?,?,?)', id, slug, name.trim(), this.now());
    return { storeId: id, slug, name: name.trim(), pairingCode: this.newPairingCode(id) };
  }

  /** A one-time code (valid 30 minutes) the store types into its POS to connect it. */
  newPairingCode(storeId: string): string {
    if (!one(this.db, 'SELECT 1 FROM store WHERE id = ?', storeId)) throw new HubError('NOT_FOUND', 'No such store.', 404);
    const raw = Array.from({ length: 8 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');
    exec(this.db, 'INSERT INTO pairing_code (code_hash, store_id, expires_at) VALUES (?,?,?)', hash(raw), storeId, this.now() + 30 * 60_000);
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  }

  pairingCodeForSlug(slug: string): string { return this.newPairingCode(this.store({ slug }).id); }

  pair(code: string, deviceName: string) {
    const raw = String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return tx(this.db, () => {
      const p = one<{ store_id: string; expires_at: number; used_at: number | null }>(this.db, 'SELECT store_id, expires_at, used_at FROM pairing_code WHERE code_hash = ?', hash(raw));
      if (!p || p.used_at !== null || p.expires_at < this.now()) throw new HubError('BAD_PAIRING_CODE', 'This pairing code is wrong, already used or expired. Ask for a new one.', 400);
      exec(this.db, 'UPDATE pairing_code SET used_at = ? WHERE code_hash = ?', this.now(), hash(raw));
      const key = `tpk_${randomBytes(32).toString('base64url')}`;
      const deviceId = randomUUID();
      exec(this.db, 'INSERT INTO device (id, store_id, name, key_hash, created_at) VALUES (?,?,?,?,?)', deviceId, p.store_id, String(deviceName ?? 'POS').slice(0, 60) || 'POS', hash(key), this.now());
      const s = one<StoreRow>(this.db, 'SELECT * FROM store WHERE id = ?', p.store_id)!;
      return { storeId: s.id, slug: s.slug, name: s.name, deviceKey: key };
    });
  }

  device(key: string | undefined): DeviceRef {
    const d = key ? one<{ id: string; store_id: string; slug: string }>(this.db, 'SELECT d.id, d.store_id, s.slug FROM device d JOIN store s ON s.id = d.store_id WHERE d.key_hash = ? AND d.revoked_at IS NULL', hash(key)) : undefined;
    if (!d) throw new HubError('UNAUTHENTICATED', 'This POS is not connected to the hub. Pair it again.', 401);
    return { deviceId: d.id, storeId: d.store_id, slug: d.slug };
  }

  revokeDevice(deviceId: string) { exec(this.db, 'UPDATE device SET revoked_at = ? WHERE id = ?', this.now(), deviceId); }

  private store(by: { id?: string; slug?: string }): StoreRow {
    const s = by.id ? one<StoreRow>(this.db, 'SELECT * FROM store WHERE id = ?', by.id) : one<StoreRow>(this.db, 'SELECT * FROM store WHERE slug = ?', by.slug ?? '');
    if (!s) throw new HubError('NOT_FOUND', 'No such store.', 404);
    return s;
  }
  private menu(s: StoreRow): PublishedMenu | null { return s.menu_json ? JSON.parse(s.menu_json) as PublishedMenu : null; }

  // ---------------------------------------------------------------- what a POS publishes

  publishMenu(dev: DeviceRef, m: PublishedMenu) {
    if (!m || typeof m !== 'object' || !Number.isSafeInteger(m.version) || m.version < 1) throw new HubError('VALIDATION', 'The menu needs a version number.');
    if (!Array.isArray(m.items) || !Array.isArray(m.categories) || !Array.isArray(m.modifierGroups) || !m.options || typeof m.roundToRupee !== 'boolean') throw new HubError('VALIDATION', 'The menu is incomplete.');
    for (const i of m.items) if (typeof i.id !== 'string' || typeof i.name !== 'string' || !Number.isSafeInteger(i.price) || i.price < 0 || !Number.isInteger(i.rateBp)) throw new HubError('VALIDATION', 'A menu item is not valid.');
    const svc = checkServiceability(m.serviceability);
    if (!svc.ok) throw new HubError('VALIDATION', 'The serviceability settings are not valid.', 400, { fields: svc.errors });
    const cur = this.store({ id: dev.storeId });
    if (m.version < cur.menu_version) return { version: cur.menu_version, stale: true }; // an older publish arriving late
    exec(this.db, 'UPDATE store SET menu_json = ?, menu_version = ?, name = ? WHERE id = ?', JSON.stringify({ ...m, serviceability: svc.value }), m.version, String(m.storeName || cur.name).slice(0, 80), dev.storeId);
    const keep = new Set(m.items.map((i) => i.image).filter((x): x is string => typeof x === 'string'));
    for (const r of many<{ name: string }>(this.db, 'SELECT name FROM image WHERE store_id = ?', dev.storeId)) if (!keep.has(r.name)) exec(this.db, 'DELETE FROM image WHERE store_id = ? AND name = ?', dev.storeId, r.name);
    return { version: m.version, stale: false };
  }

  // ---------------------------------------------------------------- menu photos

  /** Photos this store already has here (the POS sends only the missing ones). */
  imageNames(dev: DeviceRef): string[] {
    return many<{ name: string }>(this.db, 'SELECT name FROM image WHERE store_id = ?', dev.storeId).map((r) => r.name);
  }

  /** A menu photo from the POS. Its name is the SHA-256 of its bytes, so a wrong or damaged file is refused. */
  putImage(dev: DeviceRef, name: string, dataBase64: unknown) {
    const m = /^([0-9a-f]{64})\.(jpg|png|webp)$/.exec(name);
    if (!m) throw new HubError('VALIDATION', 'Unknown photo name.');
    if (typeof dataBase64 !== 'string' || dataBase64.length > 2_000_000) throw new HubError('TOO_LARGE', 'The photo is too large.', 413);
    const bytes = Buffer.from(dataBase64, 'base64');
    if (createHash('sha256').update(bytes).digest('hex') !== m[1]) throw new HubError('VALIDATION', 'The photo does not match its name.');
    const kind = bytes[0] === 0xff && bytes[1] === 0xd8 ? 'jpg' : bytes.readUInt32BE(0) === 0x89504e47 ? 'png' : bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP' ? 'webp' : null;
    if (kind !== m[2]) throw new HubError('VALIDATION', 'This is not a JPG, PNG or WebP photo.');
    if ((one<{ n: number }>(this.db, 'SELECT COUNT(*) AS n FROM image WHERE store_id = ?', dev.storeId)?.n ?? 0) >= 3000) throw new HubError('TOO_MANY', 'Too many photos for one store.', 409);
    exec(this.db, 'INSERT OR IGNORE INTO image(store_id, name, type, bytes, created_at) VALUES (?,?,?,?,?)', dev.storeId, name, { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[kind], bytes, this.now());
    return { ok: true };
  }

  /** A store's photo for the ordering page. */
  image(slug: string, name: string): { type: string; bytes: Uint8Array } {
    const s = this.store({ slug });
    const r = one<{ type: string; bytes: Uint8Array }>(this.db, 'SELECT type, bytes FROM image WHERE store_id = ? AND name = ?', s.id, name);
    if (!r) throw new HubError('NOT_FOUND', 'Photo not found.', 404);
    return r;
  }

  setStatus(dev: DeviceRef, s: { accepting: boolean; reason?: string | null }) {
    exec(this.db, 'UPDATE store SET accepting = ?, accepting_reason = ?, last_seen_at = ? WHERE id = ?', s.accepting ? 1 : 0, s.accepting ? null : String(s.reason ?? 'Not taking orders right now.').slice(0, 200), this.now(), dev.storeId);
    return { ok: true };
  }

  // ---------------------------------------------------------------- live streams (store online status)

  streamOpened(storeId: string) {
    this.streams.set(storeId, (this.streams.get(storeId) ?? 0) + 1);
    try { exec(this.db, 'UPDATE store SET last_seen_at = ? WHERE id = ?', this.now(), storeId); } catch { /* hub shutting down: last-seen is not essential */ }
  }
  streamClosed(storeId: string) {
    const n = (this.streams.get(storeId) ?? 1) - 1;
    if (n <= 0) { this.streams.delete(storeId); this.closedAt.set(storeId, this.now()); } else this.streams.set(storeId, n);
  }
  connected(storeId: string): boolean {
    if ((this.streams.get(storeId) ?? 0) > 0) return true;
    const closed = this.closedAt.get(storeId);
    return closed !== undefined && this.now() - closed < (this.opts.offlineAfterMs ?? 60_000);
  }

  /** Can this store take an order now (and why not)? */
  availability(s: StoreRow, m: PublishedMenu | null, o: { channel?: 'app' | 'website'; fulfilment?: 'PICKUP' | 'DELIVERY'; payment?: 'ONLINE' | 'COD' } = {}): { open: boolean; reason: string | null } {
    if (!m) return { open: false, reason: 'This store is not taking online orders yet.' };
    if (!this.connected(s.id)) return { open: false, reason: 'The store is offline right now. Please try again later.' };
    if (!s.accepting) return { open: false, reason: s.accepting_reason ?? 'The store is not taking orders right now.' };
    if (!isOpen(m.serviceability.hours, this.now())) return { open: false, reason: 'The store is closed now. See the opening hours.' };
    if (o.channel && !m.options.channels[o.channel]) return { open: false, reason: 'Online orders are not available here right now.' };
    if (o.fulfilment === 'PICKUP' && !m.options.fulfilment.pickup) return { open: false, reason: 'This store does not offer pickup right now.' };
    if (o.fulfilment === 'DELIVERY' && (!m.options.fulfilment.delivery || !m.serviceability.location || m.serviceability.zones.length === 0)) return { open: false, reason: 'This store does not deliver right now.' };
    if (o.payment === 'COD' && !m.options.payments.cod) return { open: false, reason: 'Cash on delivery is not available. Choose online payment.' };
    if (o.payment === 'ONLINE' && (!m.options.payments.online || !this.opts.onlinePayments)) return { open: false, reason: 'Online payment is not available yet. Choose cash on delivery.' };
    return { open: true, reason: null };
  }

  /** The store page for customer apps. */
  storePublic(slug: string) {
    const s = this.store({ slug });
    const m = this.menu(s);
    const a = this.availability(s, m);
    if (!m) return { slug: s.slug, name: s.name, open: false, reason: a.reason, menu: null };
    const sv = m.serviceability;
    return {
      slug: s.slug, name: s.name, open: a.open, reason: a.reason,
      menu: { version: m.version, categories: m.categories, items: m.items.filter((i) => i.available).map(({ rateBp: _r, cessBp: _c, priceIncludesTax: _p, ...i }) => i), modifierGroups: m.modifierGroups },
      fulfilment: m.options.fulfilment, payments: { cod: m.options.payments.cod, online: m.options.payments.online && Boolean(this.opts.onlinePayments) },
      delivery: { location: sv.location ? { lat: sv.location.lat, lng: sv.location.lng } : null, zones: sv.zones, packagingFee: sv.packagingFee },
      pickup: sv.pickup, hours: sv.hours, acceptMode: m.options.acceptMode,
    };
  }

  /** Prices a cart with fees (for the app before ordering, and when placing). */
  async quote(slug: string, body: { fulfilment: 'PICKUP' | 'DELIVERY'; location?: { lat: number; lng: number } | null; lines: Array<{ itemId: string; qtyMilli: number; modifierIds?: string[]; note?: string | null }> }) {
    const s = this.store({ slug });
    const m = this.menu(s);
    if (!m) throw new HubError('STORE_CLOSED', 'This store is not taking online orders yet.', 409);
    return this.priceWithFees(m, body);
  }

  private async priceWithFees(m: PublishedMenu, body: { fulfilment: 'PICKUP' | 'DELIVERY'; location?: { lat: number; lng: number } | null; lines: Array<{ itemId: string; qtyMilli: number; modifierIds?: string[]; note?: string | null }> }) {
    const items = priceOrder(m, body.lines);
    if (!items.ok) throw new HubError(items.reason, items.message, 409, { itemId: items.itemId });
    let measured: number | null = null;
    if (body.fulfilment === 'DELIVERY' && body.location && m.serviceability.location && this.opts.roadKm) {
      measured = await this.opts.roadKm(m.serviceability.location, body.location).catch(() => null);
    }
    const q = quote(m.serviceability, { fulfilment: body.fulfilment, to: body.location ?? undefined, itemsTotal: items.itemsTotal, measuredRoadKm: measured });
    if (!q.ok) {
      if (q.reason === 'BELOW_MINIMUM') throw new HubError('BELOW_MINIMUM', `Add items worth Rs ${(q.shortBy! / 100).toFixed(2)} more (minimum order Rs ${(q.minOrder! / 100).toFixed(2)}).`, 409, q);
      if (q.reason === 'OUT_OF_AREA') throw new HubError('OUT_OF_AREA', `Sorry, this address is outside the delivery area (up to ${q.maxKm} km).`, 409, q);
      throw new HubError('NO_DELIVERY', 'This store does not deliver right now.', 409, q);
    }
    const priced = priceOrder(m, body.lines, { delivery: q.deliveryFee, packaging: q.packagingFee });
    if (!priced.ok) throw new HubError(priced.reason, priced.message, 409);
    return { ...priced, distanceKm: q.distanceKm, etaMinutes: q.etaMinutes, minOrder: q.minOrder, menuVersion: m.version };
  }

  // ---------------------------------------------------------------- customer: OTP

  async otpSend(mobileIn: string) {
    const mobile = normaliseMobile(String(mobileIn ?? ''));
    if (!MOBILE_RE.test(mobile)) throw new HubError('VALIDATION', 'Enter a 10-digit mobile number.');
    const now = this.now();
    const row = one<{ sends: number; window_start: number }>(this.db, 'SELECT sends, window_start FROM otp WHERE mobile = ?', mobile);
    const inWindow = row && now - row.window_start < 10 * 60_000;
    if (inWindow && row.sends >= 3) throw new HubError('OTP_LIMIT', 'Too many codes asked for. Try again in 10 minutes.', 429);
    const code = String(randomInt(100000, 1000000));
    exec(this.db, `INSERT INTO otp (mobile, code_hash, expires_at, attempts, sends, window_start) VALUES (?,?,?,0,1,?)
      ON CONFLICT(mobile) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0,
        sends = CASE WHEN ? THEN otp.sends + 1 ELSE 1 END, window_start = CASE WHEN ? THEN otp.window_start ELSE excluded.window_start END`,
      mobile, hash(mobile + code), now + OTP_TTL, now, inWindow ? 1 : 0, inWindow ? 1 : 0);
    await (this.opts.sendSms ?? (async (m, t) => this.opts.log?.info('OTP (no SMS provider set up)', { mobile: m.slice(0, 2) + '******' + m.slice(-2), text: t.replace(/\d{6}/, '******') })))(mobile, `${code} is your code to confirm your order. It expires in 5 minutes.`);
    return { sent: true, ...(this.opts.devOtp ? { devCode: code } : {}) };
  }

  otpVerify(mobileIn: string, code: string) {
    const mobile = normaliseMobile(String(mobileIn ?? ''));
    const row = one<{ code_hash: string; expires_at: number; attempts: number }>(this.db, 'SELECT code_hash, expires_at, attempts FROM otp WHERE mobile = ?', mobile);
    if (!row || row.expires_at < this.now()) throw new HubError('OTP_EXPIRED', 'The code has expired. Ask for a new one.');
    if (row.attempts >= 5) throw new HubError('OTP_LOCKED', 'Too many wrong codes. Ask for a new one.', 429);
    if (hash(mobile + String(code ?? '').trim()) !== row.code_hash) {
      exec(this.db, 'UPDATE otp SET attempts = attempts + 1 WHERE mobile = ?', mobile);
      throw new HubError('OTP_WRONG', 'That code is not right.');
    }
    exec(this.db, 'DELETE FROM otp WHERE mobile = ?', mobile);
    const token = `otp_${randomBytes(24).toString('base64url')}`;
    exec(this.db, 'INSERT INTO otp_token (token_hash, mobile, expires_at) VALUES (?,?,?)', hash(token), mobile, this.now() + OTP_TOKEN_TTL);
    return { otpToken: token, mobile };
  }

  private verifiedMobile(token: string | null | undefined): string | null {
    if (!token) return null;
    const r = one<{ mobile: string; expires_at: number }>(this.db, 'SELECT mobile, expires_at FROM otp_token WHERE token_hash = ?', hash(token));
    return r && r.expires_at > this.now() ? r.mobile : null;
  }

  // ---------------------------------------------------------------- customer: orders

  async placeOrder(slug: string, body: unknown, idemKey: string | undefined) {
    const scope = `place:${slug}`;
    const done = idemKey ? this.idemGet(scope, idemKey) : null;
    if (done) return done as { order: Order; accessToken: string };
    const c = checkPlaceOrder(body);
    if (!c.ok) throw new HubError('VALIDATION', Object.values(c.errors)[0]!, 400, { fields: c.errors });
    const req = c.value;
    const s = this.store({ slug });
    const m = this.menu(s);
    const channel = req.channel ?? 'website';
    const a = this.availability(s, m, { channel, fulfilment: req.fulfilment, payment: req.payment });
    if (!a.open) throw new HubError(req.payment === 'ONLINE' && /payment/i.test(a.reason ?? '') ? 'PAYMENT_NOT_AVAILABLE' : 'STORE_CLOSED', a.reason!, 409);
    const verified = this.verifiedMobile(req.otpToken);
    if (req.payment === 'COD' && verified !== req.customer.mobile) throw new HubError('OTP_REQUIRED', 'Verify your mobile number with the OTP to pay cash on delivery.', 400);
    const priced = await this.priceWithFees(m!, { fulfilment: req.fulfilment, location: req.location, lines: req.lines });
    if (priced.total !== req.expectedTotal) throw new HubError('PRICE_CHANGED', `The total is now Rs ${(priced.total / 100).toFixed(2)}. Please check and order again.`, 409, { total: priced.total, menuVersion: priced.menuVersion });

    const now = this.now();
    const result = tx(this.db, () => {
      const n = one<{ order_counter: number }>(this.db, 'UPDATE store SET order_counter = order_counter + 1 WHERE id = ? RETURNING order_counter', s.id)!.order_counter;
      const id = randomUUID();
      const accessToken = `ord_${randomBytes(24).toString('base64url')}`;
      const manual = m!.options.acceptMode === 'manual';
      const state: OrderState = req.payment === 'COD' ? 'SENT_TO_STORE' : 'PAYMENT_PENDING';
      const order: Order = {
        id, number: `${channel === 'app' ? 'A' : 'W'}-${n}`, storeId: s.id, channel, state, fulfilment: req.fulfilment, payment: req.payment, paid: false,
        customer: { name: req.customer.name ?? null, mobile: req.customer.mobile, verified: verified === req.customer.mobile },
        address: req.address ?? null, lines: priced.lines, note: req.note ?? null,
        itemsTotal: priced.itemsTotal, deliveryFee: priced.deliveryFee, packagingFee: priced.packagingFee, total: priced.total,
        distanceKm: priced.distanceKm, location: req.location ?? null, prepMinutes: null, etaAt: null,
        menuVersion: m!.version, placedAt: now, acceptBy: state === 'SENT_TO_STORE' && manual ? now + m!.options.acceptTimeoutMin * 60_000 : null,
        rider: null, posBillNo: null, rejectReason: null, reasonText: null,
      };
      exec(this.db, 'INSERT INTO orders (id, store_id, number, state, data_json, access_hash, accept_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
        id, s.id, order.number, state, JSON.stringify(order), hash(accessToken), order.acceptBy, now, now);
      const evs = state === 'SENT_TO_STORE' ? [this.addEvent(s.id, id, 'order.created', { order })] : [];
      const out = { order, accessToken };
      if (idemKey) this.idemPut(scope, idemKey, 201, out);
      return { out, evs };
    });
    for (const ev of result.evs) this.bus.emit('pos', s.id, ev);
    this.emitCustomer(result.out.order);
    return result.out;
  }

  orderForCustomer(id: string, token: string | undefined): Order {
    const r = one<OrderRow>(this.db, 'SELECT * FROM orders WHERE id = ?', id);
    if (!r || !token || hash(token) !== r.access_hash) throw new HubError('NOT_FOUND', 'Order not found.', 404);
    return JSON.parse(r.data_json) as Order;
  }

  cancelByCustomer(id: string, token: string | undefined, reasonText?: string | null) {
    const o = this.orderForCustomer(id, token);
    return this.move(o.storeId, id, 'CANCELLED', 'customer', { reasonText: reasonText ? String(reasonText).slice(0, 200) : 'Cancelled by the customer' });
  }

  // ---------------------------------------------------------------- POS actions

  eventsSince(storeId: string, afterSeq: number): PosEvent[] {
    return many<{ seq: number; data_json: string }>(this.db, 'SELECT seq, data_json FROM event WHERE store_id = ? AND seq > ? ORDER BY seq LIMIT 500', storeId, afterSeq)
      .map((r) => ({ ...JSON.parse(r.data_json), seq: r.seq }) as PosEvent);
  }

  openOrders(dev: DeviceRef): Order[] {
    return many<{ data_json: string }>(this.db, "SELECT data_json FROM orders WHERE store_id = ? AND state NOT IN ('REJECTED','AUTO_REJECTED','CANCELLED','DELIVERED','PICKED_UP','PLACED','PAYMENT_PENDING','PAYMENT_FAILED') ORDER BY created_at", dev.storeId)
      .map((r) => JSON.parse(r.data_json) as Order);
  }

  posAction(dev: DeviceRef, orderId: string, action: 'received' | 'accept' | 'reject' | 'state', body: Record<string, unknown>, idemKey: string | undefined) {
    if (!idemKey) throw new HubError('IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key with every change.', 400);
    const scope = `pos:${dev.storeId}`;
    const done = this.idemGet(scope, idemKey);
    if (done) return done;
    const r = one<OrderRow>(this.db, 'SELECT * FROM orders WHERE id = ? AND store_id = ?', orderId, dev.storeId);
    if (!r) throw new HubError('NOT_FOUND', 'Order not found.', 404);
    let out: unknown;
    if (action === 'received') {
      // several counters may confirm; only the first moves the order
      out = r.state === 'SENT_TO_STORE' ? this.move(dev.storeId, orderId, 'RECEIVED', 'pos', {}) : { orderId, state: r.state };
    } else if (action === 'accept') {
      const prep = Number(body.prepMinutes), bill = String(body.posBillNo ?? '');
      if (!Number.isInteger(prep) || prep < 1 || prep > 180) throw new HubError('VALIDATION', 'Preparation time must be 1 to 180 minutes.');
      if (!bill || bill.length > 40) throw new HubError('VALIDATION', 'The POS bill number is missing.');
      out = this.move(dev.storeId, orderId, 'ACCEPTED', 'pos', { prepMinutes: prep, posBillNo: bill });
    } else if (action === 'reject') {
      const reason = String(body.reason ?? '') as RejectReason;
      if (!(REJECT_REASONS as readonly string[]).includes(reason)) throw new HubError('VALIDATION', 'Choose a reason.');
      out = this.move(dev.storeId, orderId, 'REJECTED', 'pos', { rejectReason: reason, reasonText: body.reasonText ? String(body.reasonText).slice(0, 200) : null });
    } else {
      const to = String(body.to ?? '') as OrderState;
      if (!['PREPARING', 'READY', 'OUT_FOR_DELIVERY', 'DELIVERED', 'PICKED_UP', 'CANCELLED'].includes(to)) throw new HubError('VALIDATION', 'Unknown order step.');
      let rider: Rider | null = null;
      if (to === 'OUT_FOR_DELIVERY') {
        const rd = (body.rider ?? {}) as Record<string, unknown>;
        if (typeof rd.name !== 'string' || !rd.name.trim() || rd.name.length > 60) throw new HubError('VALIDATION', 'Enter the rider name.');
        rider = { name: rd.name.trim(), phone: typeof rd.phone === 'string' && rd.phone.trim() ? rd.phone.trim().slice(0, 15) : null };
      }
      if (to === 'CANCELLED' && !(typeof body.reasonText === 'string' && body.reasonText.trim())) throw new HubError('VALIDATION', 'Give a reason for cancelling.');
      out = this.move(dev.storeId, orderId, to, 'pos', { ...(rider ? { rider } : {}), ...(to === 'CANCELLED' ? { reasonText: String(body.reasonText).slice(0, 200) } : {}) });
    }
    this.idemPut(scope, idemKey, 200, out);
    return out;
  }

  /** One state change, checked against the contract, saved with its events in one transaction, then pushed live. */
  private move(storeId: string, orderId: string, to: OrderState, by: 'pos' | 'customer' | 'hub', patch: Partial<Order>) {
    const res = tx(this.db, () => {
      const r = one<OrderRow>(this.db, 'SELECT * FROM orders WHERE id = ? AND store_id = ?', orderId, storeId);
      if (!r) throw new HubError('NOT_FOUND', 'Order not found.', 404);
      const o = JSON.parse(r.data_json) as Order;
      const facts: OrderFacts = { fulfilment: o.fulfilment, payment: o.payment };
      const ok = canTransition(facts, r.state, to, by);
      if (!ok.ok) throw new HubError('BAD_TRANSITION', ok.reason, 409, { state: r.state });
      const now = this.now();
      const next: Order = { ...o, ...patch, state: to };
      if (to === 'ACCEPTED' && typeof patch.prepMinutes === 'number') next.etaAt = now + patch.prepMinutes * 60_000;
      const keepTimer = to === 'RECEIVED';
      next.acceptBy = keepTimer ? o.acceptBy : null;
      if (needsRefund({ ...facts, paid: o.paid }, to)) this.opts.log?.warn('refund needed (online payments: phase 3)', { order: o.number });
      exec(this.db, 'UPDATE orders SET state = ?, data_json = ?, accept_by = ?, updated_at = ? WHERE id = ?', to, JSON.stringify(next), next.acceptBy, now, orderId);
      const type = to === 'AUTO_REJECTED' ? 'order.auto_rejected' : by === 'customer' && to === 'CANCELLED' ? 'order.cancelled' : 'order.updated';
      const data = type === 'order.cancelled' ? { orderId, by: 'customer', reasonText: next.reasonText } : type === 'order.auto_rejected' ? { orderId } : { orderId, state: to, by: 'pos' };
      const ev = this.addEvent(storeId, orderId, type, data);
      return { next, ev };
    });
    this.bus.emit('pos', storeId, res.ev);
    this.emitCustomer(res.next);
    return { orderId, state: res.next.state, order: res.next };
  }

  /** Timers: unanswered orders are auto-rejected (manual mode, F7); unpaid online orders expire. */
  sweep(): number {
    const now = this.now();
    let n = 0;
    for (const r of many<{ id: string; store_id: string }>(this.db, "SELECT id, store_id FROM orders WHERE state IN ('SENT_TO_STORE','RECEIVED') AND accept_by IS NOT NULL AND accept_by <= ?", now)) {
      try { this.move(r.store_id, r.id, 'AUTO_REJECTED', 'hub', { reasonText: 'The store did not answer in time.' }); n++; } catch { /* accepted meanwhile */ }
    }
    for (const r of many<{ id: string; store_id: string }>(this.db, "SELECT id, store_id FROM orders WHERE state = 'PAYMENT_PENDING' AND created_at <= ?", now - PAYMENT_TTL)) {
      try { this.move(r.store_id, r.id, 'PAYMENT_FAILED', 'hub', {}); n++; } catch { /* paid meanwhile */ }
    }
    return n;
  }

  // ---------------------------------------------------------------- helpers

  private addEvent(storeId: string, orderId: string | null, type: PosEvent['type'], data: Record<string, unknown>): PosEvent {
    const at = this.now();
    const body = { type, at, ...data };
    const seq = Number(exec(this.db, 'INSERT INTO event (store_id, order_id, type, data_json, at) VALUES (?,?,?,?,?)', storeId, orderId, type, JSON.stringify(body), at).lastInsertRowid);
    return { ...body, seq } as unknown as PosEvent;
  }
  private emitCustomer(o: Order) {
    const ev: CustomerEvent = { seq: Date.now(), type: 'order.state', at: this.now(), orderId: o.id, state: o.state, label: label(o.state), etaMinutes: o.etaAt ? Math.max(0, Math.round((o.etaAt - this.now()) / 60_000)) : null, rider: o.rider };
    this.bus.emit('customer', o.id, ev);
  }
  private idemGet(scope: string, key: string): unknown | null {
    const r = one<{ response_json: string }>(this.db, 'SELECT response_json FROM idem WHERE scope = ? AND key = ?', scope, key);
    return r ? JSON.parse(r.response_json) : null;
  }
  private idemPut(scope: string, key: string, status: number, body: unknown) {
    exec(this.db, 'INSERT OR IGNORE INTO idem (scope, key, status, response_json, at) VALUES (?,?,?,?,?)', scope, key, status, JSON.stringify(body), this.now());
  }
}
