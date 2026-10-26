import { all, get, run, AppError } from '../../store/db.ts';
import type { Actor, Ctx } from '../ctx.ts';
import { runCommand } from '../commands.ts';
import { audit } from '../audit.ts';
import { assertPerm } from '../permissions.ts';
import { getSetting, setSetting } from '../settings.ts';
import { enqueueJob } from './jobs.ts';
import { colsFor } from './transports.ts';
import type { PrinterRow } from './transports.ts';
import { parseEscPos } from './virtual.ts';
import { KOT_TEMPLATE_EXT, parseKotTemplate, renderKot, sampleKot } from './kotTemplate.ts';
import type { KotTemplate, KotTicket } from './kotTemplate.ts';
import { DEFAULT_KOT_TEMPLATES } from './defaultKotTemplates.ts';

/**
 * Kitchen order tickets (KOT).
 *
 * What goes to the kitchen is kept per order in kot_line (signed quantities). A KOT prints the difference between the
 * order's lines and what was already sent: items added or increased, and CANCEL lines for items removed or reduced. So
 * a KOT sent from the cart, then billing, never prints an item twice, and a cart cleared after a KOT tells the kitchen.
 * Delivery and packaging charges never go to the kitchen.
 *
 * Settings > Store settings > Kitchen tickets:
 *   kot_mode  stations  (default) one ticket per prep station, on the printers that print that station ('*' = all;
 *                        items without a station go to '*' printers)
 *             with_bill  one ticket per prep station on the receipt printer, right after the bill
 *             off        no kitchen tickets
 *   designs   customer (with the bill), station (prep station printers), online (online orders, either mode);
 *             each an uploaded .tiffinkot file or the standard design (defaultKotTemplates.ts)
 */

export type KotMode = 'off' | 'with_bill' | 'stations';
export const KOT_MODES: KotMode[] = ['stations', 'with_bill', 'off'];
export type KotSlot = 'customer' | 'station' | 'online';
export const KOT_SLOTS: KotSlot[] = ['customer', 'station', 'online'];
const FEE_SKUS = ['SYS-DELIVERY', 'SYS-PACKAGING'];
const MODE_KEY = 'kot_mode';
const designKey = (s: KotSlot) => `kot_template_${s}`;
const metaKey = (s: KotSlot) => `kot_template_${s}_meta`;

export function kotMode(ctx: Ctx): KotMode {
  const v = getSetting(ctx, MODE_KEY);
  return v === 'off' || v === 'with_bill' ? v : 'stations';
}

// ---------------------------------------------------------------- what is wanted, what was sent

interface KLine { key: string; itemId: string; name: string; modifiersJson: string; note: string | null; qtyMilli: number; stationId: string | null }
const keyOf = (itemId: string, mods: string, note: string | null) => `${itemId}|${mods}|${note ?? ''}`;
const modNames = (json: string): Array<{ name: string }> => { try { return (JSON.parse(json) as Array<{ name: string }>).map((m) => ({ name: m.name })); } catch { return []; } };

function wanted(ctx: Ctx, orderId: string, status: string): Map<string, KLine> {
  const out = new Map<string, KLine>();
  if (status === 'CANCELLED') return out;
  for (const r of all<{ item_id: string; name: string; modifiers_json: string; note: string | null; qty_milli: number; station: string | null }>(ctx.db,
    `SELECT l.item_id, i.name, l.modifiers_json, l.note, l.qty_milli, coalesce(i.prep_station_id, c.prep_station_id) AS station
       FROM sale_order_line l JOIN item i ON i.id = l.item_id LEFT JOIN category c ON c.id = i.category_id
      WHERE l.order_id = ? AND ifnull(i.sku, '') NOT IN (${FEE_SKUS.map(() => '?').join(',')}) ORDER BY l.sort_no`, orderId, ...FEE_SKUS)) {
    const key = keyOf(r.item_id, r.modifiers_json, r.note);
    const cur = out.get(key);
    if (cur) cur.qtyMilli += r.qty_milli;
    else out.set(key, { key, itemId: r.item_id, name: r.name, modifiersJson: r.modifiers_json, note: r.note, qtyMilli: r.qty_milli, stationId: r.station });
  }
  return out;
}
function sent(ctx: Ctx, orderId: string): Map<string, KLine> {
  const out = new Map<string, KLine>();
  for (const r of all<{ item_id: string; name: string; modifiers_json: string; note: string | null; qty: number; station: string | null }>(ctx.db,
    `SELECT item_id, name, modifiers_json, note, sum(qty_milli) AS qty, max(prep_station_id) AS station FROM kot_line WHERE order_id = ?
      GROUP BY item_id, modifiers_json, ifnull(note, '') ORDER BY min(rowid)`, orderId)) {
    if (r.qty === 0) continue;
    const key = keyOf(r.item_id, r.modifiers_json, r.note);
    out.set(key, { key, itemId: r.item_id, name: r.name, modifiersJson: r.modifiers_json, note: r.note, qtyMilli: r.qty, stationId: r.station });
  }
  return out;
}
/** What the next KOT of an order would print: positive = new, negative = cancel. */
export function pendingKot(ctx: Ctx, orderId: string): KLine[] {
  const o = get<{ status: string }>(ctx.db, 'SELECT status FROM sale_order WHERE id = ?', orderId);
  if (!o) return [];
  const want = wanted(ctx, orderId, o.status), have = sent(ctx, orderId);
  const out: KLine[] = [];
  for (const w of want.values()) { const d = w.qtyMilli - (have.get(w.key)?.qtyMilli ?? 0); if (d !== 0) out.push({ ...w, qtyMilli: d }); }
  for (const h of have.values()) if (!want.has(h.key)) out.push({ ...h, qtyMilli: -h.qtyMilli });
  return out;
}

/** The KOT state of an open order, for the cart: tickets sent so far and lines waiting to be sent. */
export function kotStatus(ctx: Ctx, orderId: string) {
  const o = get<{ kot_count: number }>(ctx.db, 'SELECT kot_count FROM sale_order WHERE id = ?', orderId);
  return { mode: kotMode(ctx), sentTickets: o?.kot_count ?? 0, pending: pendingKot(ctx, orderId).length };
}

// ---------------------------------------------------------------- printing

interface OrderInfo { id: string; token_no: number | null; channel: string; external_id: string | null; fulfilment: 'DELIVERY' | 'PICKUP' | null; customer_name: string | null; customer_phone: string | null; note: string | null; kot_count: number; status: string }
const orderInfo = (ctx: Ctx, id: string) => {
  const o = get<OrderInfo>(ctx.db, 'SELECT id, token_no, channel, external_id, fulfilment, customer_name, customer_phone, note, kot_count, status FROM sale_order WHERE id = ?', id);
  if (!o) throw new AppError('NOT_FOUND', 'Order not found.', 404);
  return o;
};
const invoiceOf = (ctx: Ctx, orderId: string) => get<{ id: string; invoice_no: string }>(ctx.db, "SELECT id, invoice_no FROM invoice WHERE order_id = ? AND doc_type = 'TAX_INVOICE' ORDER BY issued_at LIMIT 1", orderId) ?? null;
const printersWhere = (ctx: Ctx, where: string) => all<PrinterRow>(ctx.db, `SELECT * FROM printer WHERE active = 1 AND ${where}`);

/** The design a ticket prints with: online orders use the online design; counter orders the customer or station one. */
export function kotDesign(ctx: Ctx, slot: KotSlot): KotTemplate {
  const text = getSetting(ctx, designKey(slot));
  if (text) {
    const r = parseKotTemplate(text);
    if (r.ok) return r.template;
    ctx.logger.warn('stored KOT design no longer valid; printing the standard one', { slot, errors: r.errors.slice(0, 3) });
  }
  return DEFAULT_KOT_TEMPLATES[slot];
}

export interface KotPrintResult { queued: number; kotNo: number | null; warnings: Array<'NO_KITCHEN_PRINTER' | 'NO_RECEIPT_PRINTER'> }

/** Queues tickets for these lines (one per prep station and printer). Inside the caller's transaction. */
function printTickets(ctx: Ctx, o: OrderInfo, lines: KLine[], t: { kotNo: number; reprint: boolean; tag: string; cashierName: string | null }): KotPrintResult {
  const mode = kotMode(ctx);
  const out: KotPrintResult = { queued: 0, kotNo: t.kotNo, warnings: [] };
  if (!lines.length || mode === 'off') return out;
  const outlet = get<{ name: string }>(ctx.db, 'SELECT name FROM outlet LIMIT 1')?.name ?? '';
  const names = new Map(all<{ id: string; name: string }>(ctx.db, 'SELECT id, name FROM prep_station').map((s) => [s.id, s.name]));
  const inv = invoiceOf(ctx, o.id);
  const slot: KotSlot = o.channel !== 'COUNTER' ? 'online' : mode === 'with_bill' ? 'customer' : 'station';
  const design = kotDesign(ctx, slot);
  const groups = new Map<string, KLine[]>();
  for (const l of lines) { const s = l.stationId && names.has(l.stationId) ? l.stationId : ''; groups.set(s, [...(groups.get(s) ?? []), l]); }
  const receipt = mode === 'with_bill' ? printersWhere(ctx, 'is_receipt = 1') : [];
  const kitchen = mode === 'stations' ? printersWhere(ctx, "stations <> '[]'") : [];
  if (mode === 'with_bill' && receipt.length === 0) out.warnings.push('NO_RECEIPT_PRINTER');
  for (const [station, group] of groups) {
    const targets = mode === 'with_bill' ? receipt : kitchen.filter((p) => { const list = JSON.parse(p.stations) as string[]; return list.includes('*') || (station !== '' && list.includes(station)); });
    if (mode === 'stations' && targets.length === 0 && !out.warnings.includes('NO_KITCHEN_PRINTER')) out.warnings.push('NO_KITCHEN_PRINTER');
    const ticket: KotTicket = {
      outletName: outlet, tokenNo: o.token_no, station: station ? names.get(station)! : null, kotNo: t.kotNo, reprint: t.reprint,
      channel: o.channel, fulfilment: o.fulfilment, orderNo: inv?.invoice_no ?? (o.channel !== 'COUNTER' ? o.external_id : null), onlineNo: o.external_id,
      createdAt: ctx.clock.now(), cashierName: t.cashierName, customerName: o.customer_name, customerPhone: o.customer_phone, orderNote: o.note,
      lines: group.map((l) => ({ name: l.name, qtyMilli: Math.abs(l.qtyMilli), modifiers: modNames(l.modifiersJson), note: l.note, cancel: l.qtyMilli < 0 })),
    };
    for (const pr of targets) {
      const bytes = renderKot(design, ticket, { cols: colsFor(pr.width_mm) });
      if (enqueueJob(ctx, { kind: 'KOT', refId: inv?.id ?? o.id, printerId: pr.id, payload: bytes, dedupeKey: `${t.tag}:${pr.id}:${station}` })) out.queued++;
    }
  }
  return out;
}

/**
 * Sends to the kitchen what was not sent yet (new and changed items, cancellations), as the order's next ticket.
 * Runs inside the caller's transaction (billing, cancelling an order, the cart's KOT button).
 */
export function queuePendingKot(ctx: Ctx, orderId: string, cashierName: string | null): KotPrintResult {
  if (kotMode(ctx) === 'off') return { queued: 0, kotNo: null, warnings: [] };
  const lines = pendingKot(ctx, orderId);
  if (!lines.length) return { queued: 0, kotNo: null, warnings: [] };
  const o = orderInfo(ctx, orderId);
  const kotNo = o.kot_count + 1;
  const now = ctx.clock.now();
  run(ctx.db, 'UPDATE sale_order SET kot_count = ? WHERE id = ?', kotNo, orderId);
  for (const l of lines) {
    run(ctx.db, 'INSERT INTO kot_line (id, order_id, kot_no, item_id, name, modifiers_json, note, qty_milli, prep_station_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      ctx.ids.next(), orderId, kotNo, l.itemId, l.name, l.modifiersJson, l.note, l.qtyMilli, l.stationId, now);
  }
  return printTickets(ctx, { ...o, kot_count: kotNo }, lines, { kotNo, reprint: false, tag: `kot:${orderId}:${kotNo}`, cashierName });
}

/** The cart's KOT button: send what is new to the kitchen now (before billing). */
export function sendKot(ctx: Ctx, actor: Actor, requestId: string, input: { orderId: string }) {
  return runCommand(ctx, requestId, 'kot.send', actor, () => {
    assertPerm(actor, 'order.write');
    const o = orderInfo(ctx, input.orderId);
    if (o.status !== 'DRAFT' && o.status !== 'HELD') throw new AppError('ORDER_CLOSED', 'This order is already billed or cancelled.', 409);
    if (kotMode(ctx) === 'off') throw new AppError('KOT_OFF', 'Kitchen tickets are switched off (Settings > Store settings > Kitchen tickets).', 409);
    const r = queuePendingKot(ctx, input.orderId, actor.name);
    if (r.kotNo === null) throw new AppError('NOTHING_TO_SEND', 'Everything on this bill is already with the kitchen.', 409);
    audit(ctx, actor.userId, 'kot.send', 'order', input.orderId, { kotNo: r.kotNo, tickets: r.queued });
    return { ...r, ...kotStatus(ctx, input.orderId) };
  });
}

/**
 * Prints all of an order's tickets again, marked REPRINT (the kitchen lost them). A manager approves, like a bill
 * reprint. Bills from before kitchen tickets were kept per order reprint from the bill's own items.
 */
export function reprintOrderKot(ctx: Ctx, actor: Actor, requestId: string, input: { orderId?: string; invoiceId?: string }, approve: (perm: 'invoice.reprint') => string) {
  return runCommand(ctx, requestId, 'kot.reprint', actor, () => {
    const approver = approve('invoice.reprint');
    if (kotMode(ctx) === 'off') throw new AppError('KOT_OFF', 'Kitchen tickets are switched off (Settings > Store settings > Kitchen tickets).', 409);
    const orderId = input.orderId ?? get<{ order_id: string }>(ctx.db, 'SELECT order_id FROM invoice WHERE id = ?', input.invoiceId ?? '')?.order_id;
    if (!orderId) throw new AppError('NOT_FOUND', 'Bill not found.', 404);
    const o = orderInfo(ctx, orderId);
    let lines = [...sent(ctx, orderId).values()];
    if (!lines.length && o.status === 'INVOICED') lines = [...wanted(ctx, orderId, 'DRAFT').values()]; // a bill from before KOTs were kept per order
    if (!lines.length) throw new AppError('NOTHING_TO_SEND', 'Nothing of this order went to the kitchen yet.', 409);
    const n = (get<{ n: number }>(ctx.db, "SELECT count(*) n FROM audit_log WHERE action = 'kot.reprint' AND entity_id = ?", orderId)?.n ?? 0) + 1;
    const r = printTickets(ctx, o, lines, { kotNo: Math.max(o.kot_count, 1), reprint: true, tag: `kot-reprint-${n}:${orderId}`, cashierName: actor.name });
    audit(ctx, actor.userId, 'kot.reprint', 'order', orderId, { approver, tickets: r.queued });
    return r;
  });
}

/** The ODS's KOT button: tickets of a bill that never went to the kitchen print now; otherwise a reprint (a manager approves). */
export function printOrReprintKot(ctx: Ctx, actor: Actor, requestId: string, input: { invoiceId: string }, approve: (perm: 'invoice.reprint') => string) {
  const orderId = get<{ order_id: string }>(ctx.db, 'SELECT order_id FROM invoice WHERE id = ?', input.invoiceId)?.order_id;
  if (!orderId) throw new AppError('NOT_FOUND', 'Bill not found.', 404);
  if (orderInfo(ctx, orderId).kot_count > 0) return reprintOrderKot(ctx, actor, requestId, { orderId }, approve);
  return runCommand(ctx, requestId, 'kot.print', actor, () => {
    assertPerm(actor, 'order.write');
    if (kotMode(ctx) === 'off') throw new AppError('KOT_OFF', 'Kitchen tickets are switched off (Settings > Store settings > Kitchen tickets).', 409);
    const r = queuePendingKot(ctx, orderId, actor.name);
    audit(ctx, actor.userId, 'kot.send', 'order', orderId, { kotNo: r.kotNo, tickets: r.queued });
    return r;
  });
}

// ---------------------------------------------------------------- settings: mode and designs

export interface KotDesignMeta { name: string; description: string | null; fileName: string; uploadedAt: number; uploadedBy: string }

export function getKotSettings(ctx: Ctx, actor: Actor) {
  assertPerm(actor, 'printer.manage');
  const slots = Object.fromEntries(KOT_SLOTS.map((s) => {
    const meta = getSetting(ctx, metaKey(s));
    const t = kotDesign(ctx, s);
    return [s, { custom: meta && t !== DEFAULT_KOT_TEMPLATES[s] ? JSON.parse(meta) as KotDesignMeta : null, name: t.name }];
  })) as Record<KotSlot, { custom: KotDesignMeta | null; name: string }>;
  return { mode: kotMode(ctx), slots, extension: KOT_TEMPLATE_EXT };
}

export function setKotMode(ctx: Ctx, actor: Actor, requestId: string, mode: string) {
  return runCommand(ctx, requestId, 'kot.mode', actor, () => {
    assertPerm(actor, 'settings.write');
    if (!KOT_MODES.includes(mode as KotMode)) throw new AppError('VALIDATION', 'Choose how kitchen tickets print.');
    setSetting(ctx, MODE_KEY, mode);
    audit(ctx, actor.userId, 'kot.mode', 'settings', MODE_KEY, { mode });
    return getKotSettings(ctx, actor);
  });
}

const checkSlot = (slot: string): KotSlot => { if (!KOT_SLOTS.includes(slot as KotSlot)) throw new AppError('NOT_FOUND', 'Unknown KOT design.', 404); return slot as KotSlot; };
function checkFile(fileName: string, content: string): KotTemplate {
  if (!fileName.toLowerCase().endsWith(KOT_TEMPLATE_EXT)) throw new AppError('VALIDATION', `Choose a KOT design file (its name ends in ${KOT_TEMPLATE_EXT}).`, 400, { errors: [`The file must end in ${KOT_TEMPLATE_EXT}.`] });
  const r = parseKotTemplate(content);
  if (!r.ok) throw new AppError('VALIDATION', 'This KOT design cannot be used.', 400, { errors: r.errors });
  return r.template;
}

/** A sample ticket in a design: the uploaded file being checked, or the design in use for that slot. Nothing is saved. */
export function previewKotDesign(ctx: Ctx, actor: Actor, slotIn: string, input: { fileName?: string; content?: string; widthMm: number }) {
  assertPerm(actor, 'printer.manage');
  const slot = checkSlot(slotIn);
  if (input.widthMm !== 58 && input.widthMm !== 80) throw new AppError('VALIDATION', 'Paper width must be 58 or 80 mm.');
  const t = input.content !== undefined ? checkFile(input.fileName ?? '', input.content) : kotDesign(ctx, slot);
  const outlet = get<{ name: string }>(ctx.db, 'SELECT name FROM outlet LIMIT 1')?.name;
  const k = sampleKot(ctx.clock.now(), outlet || undefined);
  const sample = slot === 'online' ? { ...k, channel: 'WEBSITE', fulfilment: 'DELIVERY' as const, onlineNo: 'W-1042', customerName: 'Asha' } : slot === 'station' ? k : { ...k };
  const cols = colsFor(input.widthMm);
  return { name: t.name, description: t.description ?? null, widthMm: input.widthMm, cols, lines: parseEscPos(renderKot(t, sample, { cols }), { widen: true }).lines };
}

export function setKotDesignFile(ctx: Ctx, actor: Actor, requestId: string, slotIn: string, input: { fileName: string; content: string }) {
  return runCommand(ctx, requestId, 'kot.design.set', actor, () => {
    assertPerm(actor, 'settings.write');
    const slot = checkSlot(slotIn);
    const t = checkFile(input.fileName, input.content);
    const meta: KotDesignMeta = { name: t.name, description: t.description ?? null, fileName: input.fileName.split(/[\\/]/).pop()!.slice(0, 120), uploadedAt: ctx.clock.now(), uploadedBy: actor.userId };
    setSetting(ctx, designKey(slot), input.content.replace(/^﻿/, ''));
    setSetting(ctx, metaKey(slot), JSON.stringify(meta));
    audit(ctx, actor.userId, 'kot.design.set', 'settings', designKey(slot), { name: t.name, fileName: meta.fileName });
    return getKotSettings(ctx, actor);
  });
}

export function clearKotDesign(ctx: Ctx, actor: Actor, requestId: string, slotIn: string) {
  return runCommand(ctx, requestId, 'kot.design.clear', actor, () => {
    assertPerm(actor, 'settings.write');
    const slot = checkSlot(slotIn);
    run(ctx.db, 'DELETE FROM settings WHERE key IN (?, ?)', designKey(slot), metaKey(slot));
    audit(ctx, actor.userId, 'kot.design.clear', 'settings', designKey(slot));
    return getKotSettings(ctx, actor);
  });
}
