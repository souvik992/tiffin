import type { HostApi } from '../../../src/addons/host.ts';
import type { Order } from '../../../contract/src/types.ts';
import type { OrderState } from '../../../contract/src/order.ts';

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
const FEE_TAX = 'ods_fee_tax_group', MAP = 'ods_map_provider';
export interface MapProvider { kind: 'osm' | 'custom'; url: string | null; attribution: string | null }
export const readFeeTaxGroup = (host: HostApi): string | null => host.getSetting(FEE_TAX) || null;
export function saveFeeTaxGroup(host: HostApi, taxGroupId: string | null) {
  if (taxGroupId !== null && !host.db.get('SELECT 1 FROM tax_group WHERE id = ? AND deleted_at IS NULL', taxGroupId)) throw new host.AppError('VALIDATION', 'Choose a GST rate from the list.');
  host.setSetting(FEE_TAX, taxGroupId ?? '');
}
export function readMapProvider(host: HostApi): MapProvider {
  try { const m = JSON.parse(host.getSetting(MAP) || 'null') as MapProvider | null; if (m && (m.kind === 'osm' || m.kind === 'custom')) return m; } catch { /* default */ }
  return { kind: 'osm', url: null, attribution: null };
}
export function saveMapProvider(host: HostApi, m: MapProvider) {
  if (m.kind === 'custom') {
    const ok = typeof m.url === 'string' && /^https:\/\/[^\s]+$/.test(m.url) && ['{z}', '{x}', '{y}'].every((p) => m.url!.includes(p)) && m.url.length <= 400;
    if (!ok) throw new host.AppError('VALIDATION', 'Enter the tile address from your map provider: it starts with https:// and contains {z}, {x} and {y} (for example https://api.maptiler.com/maps/streets/{z}/{x}/{y}.png?key=YOUR_KEY).');
    if (!m.attribution || !m.attribution.trim() || m.attribution.length > 200) throw new host.AppError('VALIDATION', 'Enter the map credit line your provider requires (for example "© MapTiler © OpenStreetMap contributors").');
    host.setSetting(MAP, JSON.stringify({ kind: 'custom', url: m.url, attribution: m.attribution.trim() }));
  } else host.setSetting(MAP, JSON.stringify({ kind: 'osm', url: null, attribution: null }));
}
