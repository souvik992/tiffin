import type { HostApi } from '../../../src/addons/host.ts';
import type { Actor } from '../../../src/services/ctx.ts';
import type { Order } from '../../../contract/src/types.ts';
import type { OrderState } from '../../../contract/src/order.ts';
import type { ChannelPricing } from '../../../contract/src/menu.ts';

/** The add-on's own tables (prefix ods_, created by its numbered database steps) and small settings. */

export const MIGRATIONS = [
  {
    version: 1, name: 'orders_and_outbox', sql: `
CREATE TABLE ods_order (
  id TEXT PRIMARY KEY, number TEXT NOT NULL, state TEXT NOT NULL, data_json TEXT NOT NULL,
  bill_invoice_id TEXT, bill_no TEXT, bill_total INTEGER, alert TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX ods_order_state ON ods_order(state, updated_at);
CREATE TABLE ods_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL, action TEXT NOT NULL, body_json TEXT NOT NULL,
  idem_key TEXT NOT NULL UNIQUE, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at INTEGER NOT NULL, done_at INTEGER
);
CREATE INDEX ods_outbox_pending ON ods_outbox(done_at, id);
` },
];

export interface LocalOrder { id: string; number: string; state: OrderState; order: Order; billInvoiceId: string | null; billNo: string | null; billTotal: number | null; alert: string | null; updatedAt: number }
interface Row { id: string; number: string; state: OrderState; data_json: string; bill_invoice_id: string | null; bill_no: string | null; bill_total: number | null; alert: string | null; updated_at: number }
const toLocal = (r: Row): LocalOrder => ({ id: r.id, number: r.number, state: r.state, order: JSON.parse(r.data_json) as Order, billInvoiceId: r.bill_invoice_id, billNo: r.bill_no, billTotal: r.bill_total, alert: r.alert, updatedAt: r.updated_at });

export const getOrder = (host: HostApi, id: string) => { const r = host.db.get<Row>('SELECT * FROM ods_order WHERE id = ?', id); return r ? toLocal(r) : null; };
/** Open orders, and orders finished in the last 3 hours (for the "Done" list). */
export const listOrders = (host: HostApi) => host.db.all<Row>(`SELECT * FROM ods_order WHERE state NOT IN ('REJECTED','AUTO_REJECTED','CANCELLED','DELIVERED','PICKED_UP') OR updated_at > ? ORDER BY created_at`, host.ctx.clock.now() - 3 * 3_600_000).map(toLocal);

export function saveOrder(host: HostApi, o: Order, patch: { state?: OrderState; alert?: string | null } = {}) {
  const now = host.ctx.clock.now();
  const state = patch.state ?? o.state;
  const data = JSON.stringify({ ...o, state });
  host.db.run(`INSERT INTO ods_order (id, number, state, data_json, alert, created_at, updated_at) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET state = excluded.state, data_json = excluded.data_json, alert = coalesce(excluded.alert, ods_order.alert), updated_at = excluded.updated_at`,
  o.id, o.number, state, data, patch.alert ?? null, now, now);
}
export function setState(host: HostApi, id: string, state: OrderState, extra: { alert?: string | null; billInvoiceId?: string; billNo?: string; billTotal?: number; patch?: Partial<Order> } = {}) {
  const cur = getOrder(host, id);
  if (!cur) return;
  const order = { ...cur.order, ...(extra.patch ?? {}), state };
  host.db.run('UPDATE ods_order SET state = ?, data_json = ?, alert = ?, bill_invoice_id = coalesce(?, bill_invoice_id), bill_no = coalesce(?, bill_no), bill_total = coalesce(?, bill_total), updated_at = ? WHERE id = ?',
    state, JSON.stringify(order), extra.alert === undefined ? cur.alert : extra.alert, extra.billInvoiceId ?? null, extra.billNo ?? null, extra.billTotal ?? null, host.ctx.clock.now(), id);
}

// ---- outbox: every change for the hub is stored first, then sent until the hub confirms it (survives restarts)
export interface OutboxRow { id: number; order_id: string; action: 'received' | 'accept' | 'reject' | 'state'; body_json: string; idem_key: string; attempts: number }
export function enqueue(host: HostApi, orderId: string, action: OutboxRow['action'], body: unknown, idemKey: string) {
  host.db.run('INSERT OR IGNORE INTO ods_outbox (order_id, action, body_json, idem_key, created_at) VALUES (?,?,?,?,?)', orderId, action, JSON.stringify(body), idemKey, host.ctx.clock.now());
}
export const pendingOutbox = (host: HostApi) => host.db.all<OutboxRow>('SELECT id, order_id, action, body_json, idem_key, attempts FROM ods_outbox WHERE done_at IS NULL ORDER BY id LIMIT 50');
export const outboxDone = (host: HostApi, id: number, error?: string) => host.db.run('UPDATE ods_outbox SET done_at = ?, last_error = ? WHERE id = ?', host.ctx.clock.now(), error ?? null, id);
export const outboxFailed = (host: HostApi, id: number, error: string) => host.db.run('UPDATE ods_outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?', error.slice(0, 300), id);

// ---- small settings
const FEE_TAX = 'ods_fee_tax_group';
/** Settings ending in "_key" are secret: the POS never lists them (src/services/settings.ts). */
const GOOGLE_KEY = 'ods_google_maps_key';
export const readFeeTaxGroup = (host: HostApi): string | null => host.getSetting(FEE_TAX) || null;
export function saveFeeTaxGroup(host: HostApi, taxGroupId: string | null) {
  if (taxGroupId !== null && !host.db.get('SELECT 1 FROM tax_group WHERE id = ? AND deleted_at IS NULL', taxGroupId)) throw new host.AppError('VALIDATION', 'Choose a GST rate from the list.');
  host.setSetting(FEE_TAX, taxGroupId ?? '');
}

/** The owner's Google key (Settings > Serviceability > Map). Used only while a Google map is chosen: see googleKeyInUse. */
export const readGoogleKey = (host: HostApi): string | null => host.getSetting(GOOGLE_KEY) || null;

// ---- which map Settings > Serviceability shows (and which place search goes with it)
export type MapStyle = 'osm' | 'google-road' | 'google-satellite' | 'google-hybrid';
const MAP_STYLES: Array<{ id: MapStyle; label: string; google: boolean }> = [
  { id: 'osm', label: 'Free map (OpenStreetMap)', google: false },
  { id: 'google-road', label: 'Google Maps', google: true },
  { id: 'google-satellite', label: 'Google satellite', google: true },
  { id: 'google-hybrid', label: 'Google satellite with roads', google: true },
];
const MAP_STYLE = 'ods_map_style';
/** The chosen map; the free map when nothing is chosen, or a Google map was chosen and the key was removed since. */
export function readMapStyle(host: HostApi): MapStyle {
  const s = MAP_STYLES.find((m) => m.id === host.getSetting(MAP_STYLE));
  return s && (!s.google || readGoogleKey(host)) ? s.id : 'osm';
}
/** The key, while a Google map is chosen (Google map pictures and place search); null = the free map and free search. */
export const googleKeyInUse = (host: HostApi): string | null => (readMapStyle(host) === 'osm' ? null : readGoogleKey(host));
export interface MapView { style: MapStyle; styles: Array<{ id: MapStyle; label: string; google: boolean; available: boolean }>; google: ApiKeysView['google'] }
export function mapView(host: HostApi): MapView {
  const key = Boolean(readGoogleKey(host));
  return { style: readMapStyle(host), styles: MAP_STYLES.map((m) => ({ ...m, available: !m.google || key })), google: apiKeysView(host).google };
}
/** Owner only. A Google map needs the key first. */
export function saveMapStyle(host: HostApi, actor: Actor, style: unknown) {
  host.assertPerm(actor, 'settings.write');
  const s = MAP_STYLES.find((m) => m.id === style);
  if (!s) throw new host.AppError('VALIDATION', 'Choose a map from the list.');
  if (s.google && !readGoogleKey(host)) throw new host.AppError('VALIDATION', 'Save a Google Maps key first (below the map choice).');
  host.setSetting(MAP_STYLE, s.id);
  host.audit(host.ctx, actor.userId, 'ods.map_style', 'settings', MAP_STYLE, { style: s.id });
}
/** What screens see: never the key itself. */
export interface ApiKeysView { google: { set: boolean; hint: string | null } }
export function apiKeysView(host: HostApi): ApiKeysView {
  const k = readGoogleKey(host);
  return { google: { set: Boolean(k), hint: k ? `…${k.slice(-4)}` : null } };
}
/** Owner only. null removes the key (back to the free map). */
export function saveGoogleKey(host: HostApi, actor: Actor, key: unknown) {
  host.assertPerm(actor, 'settings.write');
  if (key === null || key === '') { host.setSetting(GOOGLE_KEY, ''); host.audit(host.ctx, actor.userId, 'ods.api_key.remove', 'settings', GOOGLE_KEY); return; }
  const k = typeof key === 'string' ? key.trim() : '';
  if (!/^AIza[0-9A-Za-z_-]{35}$/.test(k)) throw new host.AppError('VALIDATION', 'That is not a Google API key. It is 39 characters long and starts with AIza. Copy it again from the Google Cloud console.');
  host.setSetting(GOOGLE_KEY, k);
  host.audit(host.ctx, actor.userId, 'ods.api_key.set', 'settings', GOOGLE_KEY, { endsWith: k.slice(-4) }); // never the key itself
}

// ---- menu sync: which menu items each sales channel lists
export type SyncChannel = 'app' | 'website' | 'swiggy' | 'zomato';
export const SYNC_CHANNELS: SyncChannel[] = ['app', 'website', 'swiggy', 'zomato'];
/** all = the whole menu; exclude = all but these items; include = only these items. */
export interface ChannelSync extends ChannelPricing { mode: 'all' | 'exclude' | 'include'; items: string[] }
export type MenuSync = Record<SyncChannel, ChannelSync>;
const MENU_SYNC = 'ods_menu_sync', PUBLISHED_AT = 'ods_menu_published_at';
const ALL: ChannelSync = { mode: 'all', items: [], pricing: 'same', markupBp: 0, prices: {} };

export function readMenuSync(host: HostApi): MenuSync {
  let saved: Partial<MenuSync> = {};
  try { saved = JSON.parse(host.getSetting(MENU_SYNC) || '{}') as Partial<MenuSync>; } catch { /* defaults */ }
  return Object.fromEntries(SYNC_CHANNELS.map((c) => {
    const s = saved[c];
    if (!s || !['all', 'exclude', 'include'].includes(s.mode) || !Array.isArray(s.items)) return [c, ALL];
    const prices = Object.fromEntries(Object.entries(s.prices ?? {}).filter(([, v]) => Number.isSafeInteger(v) && v >= 0));
    return [c, { mode: s.mode, items: s.items.filter((x) => typeof x === 'string'), pricing: s.pricing === 'custom' ? 'custom' : 'same', markupBp: Number.isSafeInteger(s.markupBp) ? s.markupBp : 0, prices }];
  })) as MenuSync;
}

/** Saves one channel's choice. Items are checked against the menu; unknown ones are dropped. */
export function saveMenuSync(host: HostApi, actor: Actor, channel: unknown, input: { mode?: unknown; items?: unknown; pricing?: unknown; markupBp?: unknown; prices?: unknown }): MenuSync {
  host.assertPerm(actor, 'settings.write');
  if (!SYNC_CHANNELS.includes(channel as SyncChannel)) throw new host.AppError('VALIDATION', 'Unknown sales channel.');
  const mode = input.mode;
  if (mode !== 'all' && mode !== 'exclude' && mode !== 'include') throw new host.AppError('VALIDATION', 'Choose all items, all except some, or only some.');
  const want = Array.isArray(input.items) ? [...new Set(input.items.filter((x): x is string => typeof x === 'string'))] : [];
  if (want.length > 5000) throw new host.AppError('VALIDATION', 'Too many items selected.');
  const known = new Set(host.billing.menu(host.ctx).items.map((i) => i.id));
  const items = mode === 'all' ? [] : want.filter((id) => known.has(id));
  if (mode === 'include' && items.length === 0) throw new host.AppError('VALIDATION', 'Choose at least one item to list, or list all items.');
  const pricing = input.pricing === 'custom' ? 'custom' : 'same';
  const markupBp = pricing === 'custom' && input.markupBp !== undefined ? Number(input.markupBp) : 0;
  if (!Number.isSafeInteger(markupBp) || markupBp < -5000 || markupBp > 10000) throw new host.AppError('VALIDATION', 'The price change must be between -50% and +100%.');
  const prices: Record<string, number> = {};
  if (pricing === 'custom' && input.prices && typeof input.prices === 'object') {
    for (const [id, v] of Object.entries(input.prices as Record<string, unknown>)) {
      if (!known.has(id)) continue;
      if (!Number.isSafeInteger(v) || (v as number) < 0 || (v as number) > 100_000_000) throw new host.AppError('VALIDATION', 'A channel price is not a valid amount.');
      prices[id] = v as number;
    }
  }
  const all = readMenuSync(host);
  all[channel as SyncChannel] = { mode, items, pricing, markupBp, prices };
  host.setSetting(MENU_SYNC, JSON.stringify(all));
  host.audit(host.ctx, actor.userId, 'ods.menu_sync', 'settings', String(channel), { mode, count: items.length, pricing, markupBp, ownPrices: Object.keys(prices).length });
  return all;
}

/** Whether a channel lists an item. */
export function listsItem(sync: ChannelSync, itemId: string): boolean {
  return sync.mode === 'all' || (sync.mode === 'include' ? sync.items.includes(itemId) : !sync.items.includes(itemId));
}

export const readPublishedAt = (host: HostApi): number | null => Number(host.getSetting(PUBLISHED_AT)) || null;
export const savePublishedAt = (host: HostApi, at: number) => host.setSetting(PUBLISHED_AT, String(at));
