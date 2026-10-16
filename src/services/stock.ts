import { all, get, run, AppError } from '../store/db.ts';
import { mulDivRound } from '../core/money.ts';
import type { Actor, Ctx } from './ctx.ts';
import { runCommand } from './commands.ts';
import { assertPerm } from './permissions.ts';
import { audit } from './audit.ts';
import { emit } from './outbox.ts';
import { appendJournal } from './journal.ts';

/**
 * Inventory of raw materials.
 *
 * Quantities are integer thousandths of the material's unit (1.5 kg = 1500, 3 buns = 3000).
 * Costs are integer paise per whole unit (Rs 123.45 per kg = 12345). Amounts use mulDivRound (half up).
 * Every change is a row in the append-only stock_movement ledger, in the same transaction as the cached
 * balance (stock_item.on_hand_milli) it updates. verifyStock() recomputes balances from the ledger.
 * Stock never blocks billing: balances may go negative, which the UI flags for a count.
 */

export const UNITS = ['kg', 'g', 'l', 'ml', 'pcs'] as const;
export type Unit = (typeof UNITS)[number];
export type MovementKind = 'OPENING' | 'PURCHASE' | 'PURCHASE_VOID' | 'SALE' | 'SALE_REVERSAL' | 'WASTAGE' | 'COUNT' | 'ADJUST';
export type AdjustKind = 'WASTAGE' | 'COUNT' | 'ADJUST';

const MAX_QTY = 1_000_000_000_000; // a million million thousandths: far above any shop, far below 2^53
const MAX_COST = 10_000_000_000; // Rs 10 crore per unit

export interface MovementRecord {
  id: string; stockItemId: string; deltaMilli: number; kind: MovementKind; refType: string | null; refId: string | null;
  reason: string | null; unitCost: number | null; createdBy: string | null; createdAt: number;
}
export interface StockItemSnapshot {
  id: string; name: string; unit: Unit; reorderLevelMilli: number; lastUnitCost: number | null;
  /** Bumped by every change to these fields; replay applies a snapshot only if it is newer. */
  version: number; createdAt: number; updatedAt: number; deletedAt: number | null;
}
export interface PurchaseRecord {
  id: string; supplierName: string; supplierGstin: string | null; billNo: string | null; billDate: string | null; note: string | null;
  total: number; status: 'POSTED' | 'VOIDED'; createdBy: string; createdAt: number; voidedAt: number | null; voidedBy: string | null; voidReason: string | null;
}
export interface PurchaseLineRecord { id: string; purchaseId: string; lineNo: number; stockItemId: string; qtyMilli: number; unitCost: number; amount: number }

interface ItemRow { id: string; name: string; unit: Unit; version: number; on_hand_milli: number; reorder_level_milli: number; last_unit_cost: number | null; created_at: number; updated_at: number; deleted_at: number | null }

function qtyOk(n: unknown, label: string, o: { allowZero?: boolean; allowNegative?: boolean } = {}): number {
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || Math.abs(n) > MAX_QTY) throw new AppError('VALIDATION', `${label} must be a whole number of thousandths.`);
  if (!o.allowNegative && n < 0) throw new AppError('VALIDATION', `${label} cannot be negative.`);
  if (!o.allowZero && n === 0) throw new AppError('VALIDATION', `${label} must not be zero.`);
  return n;
}
function costOk(n: unknown, label: string): number {
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0 || n > MAX_COST) throw new AppError('VALIDATION', `${label} must be a non-negative whole number of paise.`);
  return n;
}
function textOk(s: unknown, label: string, max: number, required: boolean): string | null {
  const t = typeof s === 'string' ? s.trim() : s === null || s === undefined ? '' : null;
  if (t === null) throw new AppError('VALIDATION', `${label} must be text.`);
  if (required && !t) throw new AppError('VALIDATION', `${label} is required.`);
  if (t.length > max) throw new AppError('VALIDATION', `${label} must be at most ${max} characters.`);
  return t || null;
}

function loadItem(ctx: Ctx, id: string): ItemRow {
  const r = get<ItemRow>(ctx.db, 'SELECT * FROM stock_item WHERE id = ? AND deleted_at IS NULL', id);
  if (!r) throw new AppError('NOT_FOUND', 'Stock item not found.', 404);
  return r;
}

function view(r: ItemRow) {
  return {
    id: r.id, name: r.name, unit: r.unit, onHandMilli: r.on_hand_milli, reorderLevelMilli: r.reorder_level_milli,
    lastUnitCost: r.last_unit_cost,
    // Value at the last purchase cost (display only; not an accounting valuation).
    valuePaise: r.last_unit_cost !== null && r.on_hand_milli > 0 ? mulDivRound(r.on_hand_milli, r.last_unit_cost, 1000) : 0,
    low: r.reorder_level_milli > 0 && r.on_hand_milli < r.reorder_level_milli,
    negative: r.on_hand_milli < 0,
    updatedAt: r.updated_at,
  };
}
export type StockItemView = ReturnType<typeof view>;

function snapshot(ctx: Ctx, id: string): StockItemSnapshot {
  const r = get<ItemRow>(ctx.db, 'SELECT * FROM stock_item WHERE id = ?', id)!;
  return { id: r.id, name: r.name, unit: r.unit, reorderLevelMilli: r.reorder_level_milli, lastUnitCost: r.last_unit_cost, version: r.version, createdAt: r.created_at, updatedAt: r.updated_at, deletedAt: r.deleted_at };
}

/** Writes one ledger row and moves the cached balance. Call inside a transaction. */
export function postMovement(ctx: Ctx, m: Omit<MovementRecord, 'id' | 'createdAt'> & { id?: string; createdAt?: number }): MovementRecord {
  const rec: MovementRecord = { ...m, id: m.id ?? ctx.ids.next(), createdAt: m.createdAt ?? ctx.clock.now() };
  run(ctx.db, 'INSERT INTO stock_movement(id, stock_item_id, delta_milli, kind, ref_type, ref_id, reason, unit_cost, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    rec.id, rec.stockItemId, rec.deltaMilli, rec.kind, rec.refType, rec.refId, rec.reason, rec.unitCost, rec.createdBy, rec.createdAt);
  run(ctx.db, 'UPDATE stock_item SET on_hand_milli = on_hand_milli + ?, updated_at = ? WHERE id = ?', rec.deltaMilli, rec.createdAt, rec.stockItemId);
  return rec;
}

function journalStock(ctx: Ctx, h: { after(cb: () => void): void }, at: number, part: { items?: string[]; movements?: MovementRecord[]; purchase?: { purchase: PurchaseRecord; lines: PurchaseLineRecord[] }; voidPurchase?: { purchaseId: string; voidedBy: string; reason: string } }) {
  const items = (part.items ?? []).map((id) => snapshot(ctx, id));
  h.after(() => appendJournal(ctx, { v: 1, type: 'stock', at, items, movements: part.movements ?? [], purchase: part.purchase, voidPurchase: part.voidPurchase }));
}

// ---------- stock items ----------

export function listStockItems(ctx: Ctx, o: { lowOnly?: boolean } = {}): StockItemView[] {
  const rows = all<ItemRow>(ctx.db, 'SELECT * FROM stock_item WHERE deleted_at IS NULL ORDER BY lower(name)').map(view);
  return o.lowOnly ? rows.filter((r) => r.low || r.negative) : rows;
}

export function createStockItem(ctx: Ctx, actor: Actor, requestId: string, input: { name: string; unit: Unit; reorderLevelMilli?: number; openingQtyMilli?: number; openingUnitCost?: number | null }): StockItemView {
  return runCommand(ctx, requestId, 'stock.item.create', actor, (h) => {
    assertPerm(actor, 'stock.write');
    const name = textOk(input.name, 'Name', 60, true)!;
    if (!(UNITS as readonly string[]).includes(input.unit)) throw new AppError('VALIDATION', `Unit must be one of ${UNITS.join(', ')}.`);
    const reorder = qtyOk(input.reorderLevelMilli ?? 0, 'Reorder level', { allowZero: true });
    const opening = qtyOk(input.openingQtyMilli ?? 0, 'Opening stock', { allowZero: true });
    const cost = input.openingUnitCost === undefined || input.openingUnitCost === null ? null : costOk(input.openingUnitCost, 'Opening cost');
    if (get(ctx.db, 'SELECT 1 FROM stock_item WHERE lower(name) = lower(?) AND deleted_at IS NULL', name)) throw new AppError('DUPLICATE', 'A stock item with this name already exists.', 409);
    const now = ctx.clock.now(); const id = ctx.ids.next();
    run(ctx.db, 'INSERT INTO stock_item(id, name, unit, reorder_level_milli, last_unit_cost, created_at, updated_at) VALUES (?,?,?,?,?,?,?)', id, name, input.unit, reorder, cost, now, now);
    const movements = opening > 0 ? [postMovement(ctx, { stockItemId: id, deltaMilli: opening, kind: 'OPENING', refType: null, refId: null, reason: 'Opening stock', unitCost: cost, createdBy: actor.userId })] : [];
    audit(ctx, actor.userId, 'stock.item.create', 'stock_item', id, { name, unit: input.unit, opening });
    emit(ctx, 'stock_item', id, 'create', { id, name });
    journalStock(ctx, h, now, { items: [id], movements });
    return view(loadItem(ctx, id));
  });
}

export function updateStockItem(ctx: Ctx, actor: Actor, requestId: string, id: string, input: { name?: string; reorderLevelMilli?: number }): StockItemView {
  return runCommand(ctx, requestId, 'stock.item.update', actor, (h) => {
    assertPerm(actor, 'stock.write');
    const cur = loadItem(ctx, id);
    const name = input.name === undefined ? cur.name : textOk(input.name, 'Name', 60, true)!;
    const reorder = input.reorderLevelMilli === undefined ? cur.reorder_level_milli : qtyOk(input.reorderLevelMilli, 'Reorder level', { allowZero: true });
    if (get(ctx.db, 'SELECT 1 FROM stock_item WHERE lower(name) = lower(?) AND deleted_at IS NULL AND id <> ?', name, id)) throw new AppError('DUPLICATE', 'A stock item with this name already exists.', 409);
    const now = ctx.clock.now();
    run(ctx.db, 'UPDATE stock_item SET name = ?, reorder_level_milli = ?, version = version + 1, updated_at = ? WHERE id = ?', name, reorder, now, id);
    audit(ctx, actor.userId, 'stock.item.update', 'stock_item', id, { name, reorder });
    journalStock(ctx, h, now, { items: [id] });
    return view(loadItem(ctx, id));
  });
}

export function deleteStockItem(ctx: Ctx, actor: Actor, requestId: string, id: string): { ok: true } {
  return runCommand(ctx, requestId, 'stock.item.delete', actor, (h) => {
    assertPerm(actor, 'stock.write');
    const cur = loadItem(ctx, id);
    const used = get<{ n: number }>(ctx.db, 'SELECT count(*) n FROM recipe_line r JOIN item i ON i.id = r.item_id AND i.deleted_at IS NULL WHERE r.stock_item_id = ?', id)!.n;
    if (used > 0) throw new AppError('IN_USE', `${cur.name} is used in ${used} recipe(s). Remove it from those recipes first.`, 409, { recipes: used });
    const now = ctx.clock.now();
    run(ctx.db, 'UPDATE stock_item SET deleted_at = ?, version = version + 1, updated_at = ? WHERE id = ?', now, now, id);
    audit(ctx, actor.userId, 'stock.item.delete', 'stock_item', id, { name: cur.name, onHand: cur.on_hand_milli });
    journalStock(ctx, h, now, { items: [id] });
    return { ok: true as const };
  });
}

// ---------- adjustments ----------

export function adjustStock(ctx: Ctx, actor: Actor, requestId: string, input: { stockItemId: string; kind: AdjustKind; qtyMilli: number; reason?: string | null }): StockItemView {
  return runCommand(ctx, requestId, 'stock.adjust', actor, (h) => {
    assertPerm(actor, 'stock.write');
    if (!['WASTAGE', 'COUNT', 'ADJUST'].includes(input.kind)) throw new AppError('VALIDATION', 'Adjustment kind must be WASTAGE, COUNT or ADJUST.');
    const cur = loadItem(ctx, input.stockItemId);
    let delta: number; let reason: string | null;
    if (input.kind === 'WASTAGE') {
      delta = -qtyOk(input.qtyMilli, 'Wasted quantity');
      reason = textOk(input.reason, 'Reason', 200, true);
    } else if (input.kind === 'COUNT') {
      delta = qtyOk(input.qtyMilli, 'Counted quantity', { allowZero: true }) - cur.on_hand_milli;
      reason = textOk(input.reason, 'Reason', 200, false) ?? 'Physical count';
    } else {
      delta = qtyOk(input.qtyMilli, 'Correction', { allowNegative: true });
      reason = textOk(input.reason, 'Reason', 200, true);
    }
    const now = ctx.clock.now();
    const movements = delta === 0 ? [] : [postMovement(ctx, { stockItemId: cur.id, deltaMilli: delta, kind: input.kind, refType: null, refId: null, reason, unitCost: null, createdBy: actor.userId })];
    audit(ctx, actor.userId, `stock.${input.kind.toLowerCase()}`, 'stock_item', cur.id, { delta, reason, before: cur.on_hand_milli });
    if (movements.length) journalStock(ctx, h, now, { movements });
    return view(loadItem(ctx, cur.id));
  });
}

export function listMovements(ctx: Ctx, stockItemId: string, limit = 100) {
  return all<{ id: string; kind: MovementKind; delta_milli: number; ref_type: string | null; ref_id: string | null; reason: string | null; unit_cost: number | null; created_at: number; user_name: string | null; ref_no: string | null }>(ctx.db,
    `SELECT m.id, m.kind, m.delta_milli, m.ref_type, m.ref_id, m.reason, m.unit_cost, m.created_at, u.name AS user_name,
       CASE m.ref_type WHEN 'invoice' THEN (SELECT invoice_no FROM invoice WHERE id = m.ref_id) WHEN 'purchase' THEN (SELECT coalesce(bill_no, supplier_name) FROM purchase WHERE id = m.ref_id) END AS ref_no
     FROM stock_movement m LEFT JOIN app_user u ON u.id = m.created_by WHERE m.stock_item_id = ? ORDER BY m.seq DESC LIMIT ?`, stockItemId, Math.min(Math.max(limit, 1), 500))
    .map((r) => ({ id: r.id, kind: r.kind, deltaMilli: r.delta_milli, refType: r.ref_type, refId: r.ref_id, refNo: r.ref_no, reason: r.reason, unitCost: r.unit_cost, createdAt: r.created_at, userName: r.user_name }));
}

// ---------- purchases ----------

export interface PurchaseLineInput { stockItemId: string; qtyMilli: number; unitCost: number }

/** Amounts for a purchase, computed here so the UI never does money arithmetic. */
export function previewPurchase(ctx: Ctx, lines: PurchaseLineInput[]) {
  if (!Array.isArray(lines) || lines.length === 0) throw new AppError('VALIDATION', 'Add at least one line.');
  if (lines.length > 200) throw new AppError('VALIDATION', 'At most 200 lines per purchase.');
  const out = lines.map((l, i) => {
    const item = loadItem(ctx, l.stockItemId);
    const qty = qtyOk(l.qtyMilli, `Line ${i + 1} quantity`);
    const unitCost = costOk(l.unitCost, `Line ${i + 1} rate`);
    return { stockItemId: item.id, name: item.name, unit: item.unit, qtyMilli: qty, unitCost, amount: mulDivRound(qty, unitCost, 1000) };
  });
  let total = 0;
  for (const l of out) total += l.amount;
  if (!Number.isSafeInteger(total)) throw new AppError('VALIDATION', 'Purchase total is too large.');
  return { lines: out, total };
}

const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export function createPurchase(ctx: Ctx, actor: Actor, requestId: string, input: { supplierName: string; supplierGstin?: string | null; billNo?: string | null; billDate?: string | null; note?: string | null; lines: PurchaseLineInput[] }) {
  return runCommand(ctx, requestId, 'purchase.create', actor, (h) => {
    assertPerm(actor, 'stock.write');
    const supplierName = textOk(input.supplierName, 'Supplier', 80, true)!;
    const gstin = textOk(input.supplierGstin, 'Supplier GSTIN', 15, false)?.toUpperCase() ?? null;
    if (gstin && !GSTIN.test(gstin)) throw new AppError('VALIDATION', 'Supplier GSTIN format is invalid.');
    const billNo = textOk(input.billNo, 'Bill number', 40, false);
    const billDate = textOk(input.billDate, 'Bill date', 10, false);
    if (billDate && (!/^\d{4}-\d{2}-\d{2}$/.test(billDate) || Number.isNaN(Date.parse(`${billDate}T00:00:00Z`)))) throw new AppError('VALIDATION', 'Bill date must be YYYY-MM-DD.');
    const note = textOk(input.note, 'Note', 200, false);
    const p = previewPurchase(ctx, input.lines);
    if (new Set(p.lines.map((l) => l.stockItemId)).size !== p.lines.length) throw new AppError('VALIDATION', 'A material appears twice. Combine the lines.');
    const now = ctx.clock.now(); const id = ctx.ids.next();
    const purchase: PurchaseRecord = { id, supplierName, supplierGstin: gstin, billNo, billDate, note, total: p.total, status: 'POSTED', createdBy: actor.userId, createdAt: now, voidedAt: null, voidedBy: null, voidReason: null };
    const lines: PurchaseLineRecord[] = p.lines.map((l, i) => ({ id: ctx.ids.next(), purchaseId: id, lineNo: i + 1, stockItemId: l.stockItemId, qtyMilli: l.qtyMilli, unitCost: l.unitCost, amount: l.amount }));
    insertPurchase(ctx, purchase, lines);
    const movements = lines.map((l) => {
      run(ctx.db, 'UPDATE stock_item SET last_unit_cost = ?, version = version + 1 WHERE id = ?', l.unitCost, l.stockItemId);
      return postMovement(ctx, { stockItemId: l.stockItemId, deltaMilli: l.qtyMilli, kind: 'PURCHASE', refType: 'purchase', refId: id, reason: null, unitCost: l.unitCost, createdBy: actor.userId, createdAt: now });
    });
    audit(ctx, actor.userId, 'purchase.create', 'purchase', id, { supplierName, billNo, total: p.total, lines: lines.length });
    emit(ctx, 'purchase', id, 'create', { purchase, lines });
    journalStock(ctx, h, now, { items: lines.map((l) => l.stockItemId), movements, purchase: { purchase, lines } });
    return getPurchase(ctx, id);
  }, { compact: (r) => ({ purchaseId: r.purchase.id }), expand: (s) => getPurchase(ctx, (s as { purchaseId: string }).purchaseId) });
}

export function insertPurchase(ctx: Ctx, p: PurchaseRecord, lines: PurchaseLineRecord[]): void {
  run(ctx.db, 'INSERT INTO purchase(id, supplier_name, supplier_gstin, bill_no, bill_date, note, total, status, created_by, created_at, voided_at, voided_by, void_reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    p.id, p.supplierName, p.supplierGstin, p.billNo, p.billDate, p.note, p.total, p.status, p.createdBy, p.createdAt, p.voidedAt, p.voidedBy, p.voidReason);
  for (const l of lines) {
    run(ctx.db, 'INSERT INTO purchase_line(id, purchase_id, line_no, stock_item_id, qty_milli, unit_cost, amount) VALUES (?,?,?,?,?,?,?)', l.id, l.purchaseId, l.lineNo, l.stockItemId, l.qtyMilli, l.unitCost, l.amount);
  }
}

export function voidPurchase(ctx: Ctx, actor: Actor, requestId: string, input: { purchaseId: string; reason: string }) {
  return runCommand(ctx, requestId, 'purchase.void', actor, (h) => {
    assertPerm(actor, 'stock.write');
    const reason = textOk(input.reason, 'Reason', 200, true)!;
    const cur = getPurchase(ctx, input.purchaseId);
    if (cur.purchase.status === 'VOIDED') throw new AppError('ALREADY_VOIDED', 'This purchase is already voided.', 409);
    const now = ctx.clock.now();
    run(ctx.db, "UPDATE purchase SET status = 'VOIDED', voided_at = ?, voided_by = ?, void_reason = ? WHERE id = ? AND status = 'POSTED'", now, actor.userId, reason, cur.purchase.id);
    const movements = cur.lines.map((l) => postMovement(ctx, { stockItemId: l.stockItemId, deltaMilli: -l.qtyMilli, kind: 'PURCHASE_VOID', refType: 'purchase', refId: cur.purchase.id, reason, unitCost: l.unitCost, createdBy: actor.userId, createdAt: now }));
    // A voided purchase's price is no longer the last cost: fall back to the latest posted purchase, else the opening cost.
    for (const l of cur.lines) {
      run(ctx.db, `UPDATE stock_item SET last_unit_cost = coalesce(
          (SELECT pl.unit_cost FROM purchase_line pl JOIN purchase p ON p.id = pl.purchase_id WHERE pl.stock_item_id = ?1 AND p.status = 'POSTED' ORDER BY p.created_at DESC, p.id DESC LIMIT 1),
          (SELECT unit_cost FROM stock_movement WHERE stock_item_id = ?1 AND kind = 'OPENING' ORDER BY seq DESC LIMIT 1)), version = version + 1 WHERE id = ?1`, l.stockItemId);
    }
    audit(ctx, actor.userId, 'purchase.void', 'purchase', cur.purchase.id, { reason, total: cur.purchase.total });
    emit(ctx, 'purchase', cur.purchase.id, 'void', { id: cur.purchase.id, reason });
    journalStock(ctx, h, now, { items: cur.lines.map((l) => l.stockItemId), movements, voidPurchase: { purchaseId: cur.purchase.id, voidedBy: actor.userId, reason } });
    return getPurchase(ctx, cur.purchase.id);
  }, { compact: (r) => ({ purchaseId: r.purchase.id }), expand: (s) => getPurchase(ctx, (s as { purchaseId: string }).purchaseId) });
}

const PURCHASE_COLS = `p.id, p.supplier_name AS supplierName, p.supplier_gstin AS supplierGstin, p.bill_no AS billNo, p.bill_date AS billDate, p.note,
  p.total, p.status, p.created_by AS createdBy, p.created_at AS createdAt, p.voided_at AS voidedAt, p.voided_by AS voidedBy, p.void_reason AS voidReason`;

export function getPurchase(ctx: Ctx, id: string) {
  const purchase = get<PurchaseRecord & { createdByName: string | null }>(ctx.db, `SELECT ${PURCHASE_COLS}, u.name AS createdByName FROM purchase p LEFT JOIN app_user u ON u.id = p.created_by WHERE p.id = ?`, id);
  if (!purchase) throw new AppError('NOT_FOUND', 'Purchase not found.', 404);
  const lines = all<PurchaseLineRecord & { name: string; unit: Unit }>(ctx.db,
    `SELECT l.id, l.purchase_id AS purchaseId, l.line_no AS lineNo, l.stock_item_id AS stockItemId, l.qty_milli AS qtyMilli, l.unit_cost AS unitCost, l.amount, s.name, s.unit
     FROM purchase_line l JOIN stock_item s ON s.id = l.stock_item_id WHERE l.purchase_id = ? ORDER BY l.line_no`, id);
  return { purchase, lines };
}

export function listPurchases(ctx: Ctx, o: { limit?: number; offset?: number } = {}) {
  return all<PurchaseRecord & { lineCount: number; items: string }>(ctx.db,
    `SELECT ${PURCHASE_COLS}, (SELECT count(*) FROM purchase_line WHERE purchase_id = p.id) AS lineCount,
       (SELECT group_concat(s.name, ', ') FROM purchase_line l JOIN stock_item s ON s.id = l.stock_item_id WHERE l.purchase_id = p.id) AS items
     FROM purchase p ORDER BY p.created_at DESC, p.id DESC LIMIT ? OFFSET ?`, Math.min(Math.max(o.limit ?? 50, 1), 200), o.offset ?? 0);
}

// ---------- recipes ----------

export function getRecipe(ctx: Ctx, itemId: string) {
  return all<{ stockItemId: string; name: string; unit: Unit; qtyMilli: number }>(ctx.db,
    'SELECT r.stock_item_id AS stockItemId, s.name, s.unit, r.qty_milli AS qtyMilli FROM recipe_line r JOIN stock_item s ON s.id = r.stock_item_id WHERE r.item_id = ? AND s.deleted_at IS NULL ORDER BY lower(s.name)', itemId);
}

/** Item ids that have a recipe, with ingredient counts (for the menu screen). */
export function listRecipes(ctx: Ctx) {
  return all<{ itemId: string; lines: number }>(ctx.db,
    'SELECT r.item_id AS itemId, count(*) AS lines FROM recipe_line r JOIN stock_item s ON s.id = r.stock_item_id AND s.deleted_at IS NULL GROUP BY r.item_id');
}

export function setRecipe(ctx: Ctx, actor: Actor, requestId: string, itemId: string, lines: Array<{ stockItemId: string; qtyMilli: number }>) {
  return runCommand(ctx, requestId, 'recipe.set', actor, () => {
    assertPerm(actor, 'stock.write');
    const item = get<{ name: string }>(ctx.db, 'SELECT name FROM item WHERE id = ? AND deleted_at IS NULL', itemId);
    if (!item) throw new AppError('NOT_FOUND', 'Menu item not found.', 404);
    if (!Array.isArray(lines) || lines.length > 50) throw new AppError('VALIDATION', 'A recipe has at most 50 ingredients.');
    if (new Set(lines.map((l) => l.stockItemId)).size !== lines.length) throw new AppError('VALIDATION', 'An ingredient appears twice.');
    for (const [i, l] of lines.entries()) { loadItem(ctx, l.stockItemId); qtyOk(l.qtyMilli, `Ingredient ${i + 1} quantity`); }
    run(ctx.db, 'DELETE FROM recipe_line WHERE item_id = ?', itemId);
    for (const l of lines) run(ctx.db, 'INSERT INTO recipe_line(item_id, stock_item_id, qty_milli) VALUES (?,?,?)', itemId, l.stockItemId, l.qtyMilli);
    audit(ctx, actor.userId, 'recipe.set', 'item', itemId, { name: item.name, lines });
    return getRecipe(ctx, itemId);
  });
}

// ---------- billing hooks (called inside the finalize / cancel transactions; database only, no I/O) ----------

/** Deducts recipe ingredients for a new invoice: one SALE movement per material. Returns the movements for the journal. */
export function consumeForInvoice(ctx: Ctx, invoiceId: string, lines: Array<{ itemId: string | null; qtyMilli: number }>, actorId: string, at: number): MovementRecord[] {
  const itemIds = [...new Set(lines.map((l) => l.itemId).filter((x): x is string => !!x))];
  if (itemIds.length === 0) return [];
  const recipe = all<{ item_id: string; stock_item_id: string; qty_milli: number }>(ctx.db,
    `SELECT r.item_id, r.stock_item_id, r.qty_milli FROM recipe_line r JOIN stock_item s ON s.id = r.stock_item_id AND s.deleted_at IS NULL
     WHERE r.item_id IN (SELECT value FROM json_each(?)) ORDER BY r.stock_item_id`, JSON.stringify(itemIds));
  if (recipe.length === 0) return [];
  const need = new Map<string, number>();
  for (const l of lines) {
    if (!l.itemId) continue;
    for (const r of recipe) if (r.item_id === l.itemId) need.set(r.stock_item_id, (need.get(r.stock_item_id) ?? 0) + mulDivRound(l.qtyMilli, r.qty_milli, 1000));
  }
  const out: MovementRecord[] = [];
  for (const [stockItemId, qty] of need) {
    if (qty > 0) out.push(postMovement(ctx, { stockItemId, deltaMilli: -qty, kind: 'SALE', refType: 'invoice', refId: invoiceId, reason: null, unitCost: null, createdBy: actorId, createdAt: at }));
  }
  return out;
}

/** A cancelled invoice gives back exactly what it consumed. */
export function reverseInvoiceConsumption(ctx: Ctx, invoiceId: string, actorId: string, at: number): MovementRecord[] {
  const sold = all<{ stock_item_id: string; delta_milli: number }>(ctx.db, "SELECT stock_item_id, delta_milli FROM stock_movement WHERE ref_type = 'invoice' AND ref_id = ? AND kind = 'SALE' ORDER BY seq", invoiceId);
  return sold.map((m) => postMovement(ctx, { stockItemId: m.stock_item_id, deltaMilli: -m.delta_milli, kind: 'SALE_REVERSAL', refType: 'invoice', refId: invoiceId, reason: 'Invoice cancelled', unitCost: null, createdBy: actorId, createdAt: at }));
}

export function movementsForRef(ctx: Ctx, refType: string, refId: string, kind: MovementKind): MovementRecord[] {
  return all<MovementRecord>(ctx.db, `SELECT id, stock_item_id AS stockItemId, delta_milli AS deltaMilli, kind, ref_type AS refType, ref_id AS refId, reason, unit_cost AS unitCost, created_by AS createdBy, created_at AS createdAt
    FROM stock_movement WHERE ref_type = ? AND ref_id = ? AND kind = ? ORDER BY seq`, refType, refId, kind);
}

// ---------- integrity and recovery ----------

/** Recomputes every balance from the ledger and reports differences from the cached balance. */
export function verifyStock(ctx: Ctx) {
  const mismatches = all<{ stockItemId: string; name: string; cached: number; ledger: number }>(ctx.db,
    `SELECT s.id AS stockItemId, s.name, s.on_hand_milli AS cached, coalesce((SELECT sum(delta_milli) FROM stock_movement WHERE stock_item_id = s.id), 0) AS ledger
     FROM stock_item s WHERE s.on_hand_milli <> coalesce((SELECT sum(delta_milli) FROM stock_movement WHERE stock_item_id = s.id), 0)`);
  return { ok: mismatches.length === 0, mismatches };
}

/** Rebuilds cached balances from the ledger (after a journal replay). */
export function recomputeStockBalances(ctx: Ctx): void {
  run(ctx.db, 'UPDATE stock_item SET on_hand_milli = coalesce((SELECT sum(delta_milli) FROM stock_movement WHERE stock_item_id = stock_item.id), 0)');
}

/** Journal replay: applies stock item snapshots, a purchase, a void and ledger rows that are missing. Returns true if anything changed. */
export function applyStockEntry(ctx: Ctx, e: { items?: StockItemSnapshot[]; movements?: MovementRecord[]; purchase?: { purchase: PurchaseRecord; lines: PurchaseLineRecord[] }; voidPurchase?: { purchaseId: string; voidedBy: string; reason: string }; at: number }): boolean {
  let changed = false;
  for (const s of e.items ?? []) {
    const cur = get<{ version: number }>(ctx.db, 'SELECT version FROM stock_item WHERE id = ?', s.id);
    if (!cur) {
      run(ctx.db, 'INSERT INTO stock_item(id, name, unit, reorder_level_milli, last_unit_cost, version, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,?,?,?,?)',
        s.id, s.name, s.unit, s.reorderLevelMilli, s.lastUnitCost, s.version, s.createdAt, s.updatedAt, s.deletedAt);
      changed = true;
    } else if (s.version > cur.version) {
      run(ctx.db, 'UPDATE stock_item SET name = ?, reorder_level_milli = ?, last_unit_cost = ?, deleted_at = ?, version = ?, updated_at = ? WHERE id = ?', s.name, s.reorderLevelMilli, s.lastUnitCost, s.deletedAt, s.version, s.updatedAt, s.id);
      changed = true;
    }
  }
  if (e.purchase && !get(ctx.db, 'SELECT 1 FROM purchase WHERE id = ?', e.purchase.purchase.id)) { insertPurchase(ctx, e.purchase.purchase, e.purchase.lines); changed = true; }
  if (e.voidPurchase) {
    const r = run(ctx.db, "UPDATE purchase SET status = 'VOIDED', voided_at = ?, voided_by = ?, void_reason = ? WHERE id = ? AND status = 'POSTED'", e.at, e.voidPurchase.voidedBy, e.voidPurchase.reason, e.voidPurchase.purchaseId);
    if (Number(r.changes) > 0) changed = true;
  }
  changed = insertMissingMovements(ctx, e.movements ?? []) || changed;
  return changed;
}

/** Inserts ledger rows that are not in the database yet (by id). Balances are recomputed after the replay. */
export function insertMissingMovements(ctx: Ctx, movements: MovementRecord[]): boolean {
  let changed = false;
  for (const m of movements) {
    if (get(ctx.db, 'SELECT 1 FROM stock_movement WHERE id = ?', m.id)) continue;
    run(ctx.db, 'INSERT INTO stock_movement(id, stock_item_id, delta_milli, kind, ref_type, ref_id, reason, unit_cost, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      m.id, m.stockItemId, m.deltaMilli, m.kind, m.refType, m.refId, m.reason, m.unitCost, m.createdBy, m.createdAt);
    changed = true;
  }
  return changed;
}
