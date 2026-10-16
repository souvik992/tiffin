import { all, get, run, AppError } from '../store/db.ts';
import type { Actor, Ctx } from './ctx.ts';
import { getDevice } from './ctx.ts';
import { runCommand } from './commands.ts';
import { audit } from './audit.ts';
import { assertPerm, can } from './permissions.ts';
import { requireApproval } from './auth.ts';
import type { Override } from './auth.ts';
import { loadSettings } from './settings.ts';
import type { Settings } from './settings.ts';
import { computeInvoice, MAX_QTY_MILLI } from '../core/tax.ts';
import type { InvoiceComputation, TaxableLineInput } from '../core/tax.ts';
import type { DiscountSpec } from '../core/discount.ts';
import { istDay } from '../core/numbering.ts';
import { camel } from './camel.ts';

export interface OrderRow {
  id: string; device_id: string; shift_id: string | null; channel: string; external_id: string | null; token_no: number | null;
  status: 'DRAFT' | 'HELD' | 'INVOICED' | 'CANCELLED'; customer_phone: string | null; note: string | null;
  place_of_supply: string | null; buyer_gstin: string | null; bill_discount_type: 'amount' | 'percent' | null; bill_discount_value: number | null;
  discount_approved_by: string | null; discount_approved_bp: number | null; created_by: string | null; created_at: number; updated_at: number;
}
export interface CartLineRow {
  id: string; order_id: string; item_id: string; qty_milli: number; unit_price: number; disc_type: 'amount' | 'percent' | null; disc_value: number | null;
  modifiers_json: string; note: string | null; sort_no: number; name: string; hsn_code: string | null; unit: string;
  rate_bp: number; cess_bp: number; price_includes_tax: number;
}

export const CHANNELS = ['COUNTER', 'APP', 'WEBSITE', 'SWIGGY', 'ZOMATO', 'ONDC', 'OTHER'];
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export function getOrderRow(ctx: Ctx, id: string): OrderRow {
  const o = get<OrderRow>(ctx.db, 'SELECT * FROM sale_order WHERE id = ?', id);
  if (!o) throw new AppError('NOT_FOUND', 'Order not found.', 404);
  return o;
}
function assertOpen(o: OrderRow): void {
  if (o.status !== 'DRAFT' && o.status !== 'HELD') throw new AppError('ORDER_NOT_OPEN', `This order is ${o.status.toLowerCase()} and can no longer be changed.`, 409);
}
export function loadCartLines(ctx: Ctx, orderId: string): CartLineRow[] {
  return all<CartLineRow>(ctx.db,
    `SELECT l.*, i.name, i.hsn_code, i.unit, t.rate_bp, t.cess_bp, t.price_includes_tax
       FROM sale_order_line l JOIN item i ON i.id = l.item_id JOIN tax_group t ON t.id = i.tax_group_id
      WHERE l.order_id = ? ORDER BY l.sort_no`, orderId);
}
export function outletState(ctx: Ctx): string {
  return get<{ state_code: string }>(ctx.db, 'SELECT o.state_code FROM outlet o JOIN device d ON d.outlet_id = o.id WHERE d.id = ?', getDevice(ctx).id)!.state_code;
}

export function computeFor(ctx: Ctx, order: OrderRow, lines: CartLineRow[], settings: Settings): { calc: InvoiceComputation; placeOfSupply: string } {
  const home = outletState(ctx);
  const pos = order.place_of_supply ?? home;
  const inputs: TaxableLineInput[] = lines.map((l) => ({
    id: l.id, qtyMilli: l.qty_milli, unitPrice: l.unit_price,
    discount: l.disc_type && l.disc_value !== null ? { type: l.disc_type, value: l.disc_value } : null,
    rateBp: l.rate_bp, cessBp: l.cess_bp, priceIncludesTax: l.price_includes_tax === 1,
  }));
  try {
    const calc = computeInvoice(inputs, {
      billDiscount: order.bill_discount_type && order.bill_discount_value !== null ? { type: order.bill_discount_type, value: order.bill_discount_value } : null,
      intraState: pos === home, roundToRupee: settings.roundToRupee,
    });
    return { calc, placeOfSupply: pos };
  } catch (e) {
    if (e instanceof RangeError) throw new AppError('INVALID_AMOUNT', e.message, 422);
    throw e;
  }
}

export function discountRatioBp(calc: InvoiceComputation): number {
  if (calc.grossTotal === 0 || calc.discountTotal === 0) return 0;
  const g = BigInt(calc.grossTotal);
  return Number((BigInt(calc.discountTotal) * 10000n + g - 1n) / g); // ceiling
}

export function getCart(ctx: Ctx, orderId: string) {
  const order = getOrderRow(ctx, orderId);
  const lines = loadCartLines(ctx, orderId);
  const { calc, placeOfSupply } = computeFor(ctx, order, lines, loadSettings(ctx));
  const byId = new Map(calc.lines.map((l) => [l.id, l]));
  return {
    order: {
      id: order.id, status: order.status, channel: order.channel, tokenNo: order.token_no, customerPhone: order.customer_phone, note: order.note,
      placeOfSupply, buyerGstin: order.buyer_gstin, shiftId: order.shift_id, createdAt: order.created_at, updatedAt: order.updated_at,
      billDiscount: order.bill_discount_type ? { type: order.bill_discount_type, value: order.bill_discount_value } : null,
      discountApproved: order.discount_approved_by !== null,
    },
    lines: lines.map((l) => {
      const c = byId.get(l.id)!;
      return {
        id: l.id, itemId: l.item_id, name: l.name, unit: l.unit, qtyMilli: l.qty_milli, unitPrice: l.unit_price,
        discount: l.disc_type ? { type: l.disc_type, value: l.disc_value } : null,
        modifiers: JSON.parse(l.modifiers_json) as Array<{ id: string; name: string; price: number }>, note: l.note,
        gross: c.gross, discountApplied: c.discount, taxable: c.taxable, rateBp: c.rateBp, cgst: c.cgst, sgst: c.sgst, igst: c.igst, cess: c.cess, lineTotal: c.lineTotal,
      };
    }),
    totals: {
      grossTotal: calc.grossTotal, discountTotal: calc.discountTotal, taxableTotal: calc.taxableTotal, cgst: calc.cgst, sgst: calc.sgst,
      igst: calc.igst, cess: calc.cess, roundOff: calc.roundOff, grandTotal: calc.grandTotal, itemCount: lines.length,
    },
  };
}

/**
 * Discount policy: a cashier may discount up to the configured limit alone. Above that a manager/owner PIN is needed,
 * and the approval covers only the ratio approved (so removing items afterwards cannot inflate the discount).
 */
export function enforceDiscountPolicy(ctx: Ctx, actor: Actor, orderId: string, override?: Override | null): void {
  const order = getOrderRow(ctx, orderId);
  const settings = loadSettings(ctx);
  const { calc } = computeFor(ctx, order, loadCartLines(ctx, orderId), settings);
  const ratio = discountRatioBp(calc);
  if (ratio <= settings.cashierDiscountLimitBp) {
    if (order.discount_approved_by !== null) run(ctx.db, 'UPDATE sale_order SET discount_approved_by = NULL, discount_approved_bp = NULL WHERE id = ?', orderId);
    return;
  }
  if (can(actor.role, 'discount.over_limit')) return;
  if (order.discount_approved_by !== null && order.discount_approved_bp !== null && ratio <= order.discount_approved_bp) return;
  const approver = requireApproval(ctx, actor, 'discount.over_limit', override);
  run(ctx.db, 'UPDATE sale_order SET discount_approved_by = ?, discount_approved_bp = ? WHERE id = ?', approver, ratio, orderId);
  audit(ctx, actor.userId, 'discount.approved', 'order', orderId, { ratioBp: ratio, approver });
}

type CartView = ReturnType<typeof getCart>;
/** Cart-returning command: logs only {orderId}; a replay returns the order's current cart. */
function cartCmd(ctx: Ctx, requestId: string, name: string, actor: Actor, fn: () => CartView): CartView {
  return runCommand(ctx, requestId, name, actor, fn, {
    compact: (c) => ({ orderId: c.order.id }),
    expand: (st) => getCart(ctx, (st as { orderId: string }).orderId),
  });
}

const touch = (ctx: Ctx, orderId: string) => run(ctx.db, 'UPDATE sale_order SET updated_at = ? WHERE id = ?', ctx.clock.now(), orderId);

function validPhone(p: unknown): string | null {
  if (p === undefined || p === null || p === '') return null;
  if (typeof p !== 'string' || !/^\d{10}$/.test(p)) throw new AppError('VALIDATION', 'Phone number must be 10 digits.');
  return p;
}
function validDiscount(d: DiscountSpec | null | undefined): DiscountSpec | null {
  if (d === null || d === undefined) return null;
  if ((d.type !== 'amount' && d.type !== 'percent') || !Number.isSafeInteger(d.value) || d.value < 0) throw new AppError('VALIDATION', 'Invalid discount.');
  if (d.type === 'percent' && d.value > 10000) throw new AppError('VALIDATION', 'Percent discount cannot exceed 100%.');
  return d;
}

export function openShiftRow(ctx: Ctx) {
  return get<{ id: string; user_id: string; opened_at: number; opening_cash: number }>(ctx.db, 'SELECT id, user_id, opened_at, opening_cash FROM shift WHERE device_id = ? AND closed_at IS NULL', getDevice(ctx).id);
}

export function createOrder(ctx: Ctx, actor: Actor, requestId: string, input: { channel?: string; customerPhone?: string | null; note?: string | null } = {}) {
  return cartCmd(ctx, requestId, 'order.create', actor, () => {
    assertPerm(actor, 'order.write');
    const channel = input.channel ?? 'COUNTER';
    if (!CHANNELS.includes(channel)) throw new AppError('VALIDATION', 'Unknown order channel.');
    const device = getDevice(ctx);
    const now = ctx.clock.now();
    const id = ctx.ids.next();
    const tok = get<{ last_no: number }>(ctx.db,
      'INSERT INTO token_counter(device_id, day, last_no) VALUES (?,?,1) ON CONFLICT(device_id, day) DO UPDATE SET last_no = last_no + 1 RETURNING last_no', device.id, istDay(now))!.last_no;
    run(ctx.db, `INSERT INTO sale_order(id, device_id, shift_id, channel, token_no, status, customer_phone, note, created_by, created_at, updated_at)
                 VALUES (?,?,?,?,?,'DRAFT',?,?,?,?,?)`, id, device.id, openShiftRow(ctx)?.id ?? null, channel, tok, validPhone(input.customerPhone), input.note ?? null, actor.userId, now, now);
    audit(ctx, actor.userId, 'order.create', 'order', id, { token: tok });
    return getCart(ctx, id);
  });
}

export interface AddLineInput { orderId: string; itemId: string; qtyMilli?: number; modifierIds?: string[]; note?: string | null }

export function addLine(ctx: Ctx, actor: Actor, requestId: string, input: AddLineInput) {
  return cartCmd(ctx, requestId, 'order.add_line', actor, () => {
    assertPerm(actor, 'order.write');
    const order = getOrderRow(ctx, input.orderId);
    assertOpen(order);
    const qty = input.qtyMilli ?? 1000;
    if (!Number.isSafeInteger(qty) || qty < 1 || qty > MAX_QTY_MILLI) throw new AppError('VALIDATION', 'Quantity is out of range.');
    const item = get<{ id: string; name: string; price: number }>(ctx.db, 'SELECT id, name, price FROM item WHERE id = ? AND deleted_at IS NULL AND active = 1', input.itemId);
    if (!item) throw new AppError('NOT_FOUND', 'Item not found or not available.', 404);
    const note = input.note?.trim() ? input.note.trim().slice(0, 120) : null;

    // Modifiers: resolved from the database (never trust client prices) and checked against group rules.
    const wanted = [...new Set(input.modifierIds ?? [])];
    const groups = all<{ id: string; name: string; min_select: number; max_select: number }>(ctx.db,
      'SELECT g.id, g.name, g.min_select, g.max_select FROM item_modifier_group x JOIN modifier_group g ON g.id = x.group_id WHERE x.item_id = ? AND g.deleted_at IS NULL', item.id);
    const picked: Array<{ id: string; name: string; price: number; group_id: string }> = [];
    for (const mid of wanted) {
      const m = get<{ id: string; name: string; price: number; group_id: string }>(ctx.db, 'SELECT id, name, price, group_id FROM modifier WHERE id = ? AND active = 1', mid);
      if (!m || !groups.some((g) => g.id === m.group_id)) throw new AppError('VALIDATION', 'That option is not available for this item.');
      picked.push(m);
    }
    for (const g of groups) {
      const n = picked.filter((m) => m.group_id === g.id).length;
      if (n < g.min_select) throw new AppError('MODIFIER_REQUIRED', `Choose at least ${g.min_select} option(s) for ${g.name}.`, 422, { groupId: g.id });
      if (n > g.max_select) throw new AppError('MODIFIER_LIMIT', `Choose at most ${g.max_select} option(s) for ${g.name}.`, 422, { groupId: g.id });
    }
    picked.sort((a, b) => (a.id < b.id ? -1 : 1));
    const modsJson = JSON.stringify(picked.map((m) => ({ id: m.id, name: m.name, price: m.price })));
    const unitPrice = item.price + picked.reduce((s, m) => s + m.price, 0);

    const existing = get<{ id: string; qty_milli: number }>(ctx.db,
      `SELECT id, qty_milli FROM sale_order_line WHERE order_id = ? AND item_id = ? AND modifiers_json = ? AND ifnull(note,'') = ifnull(?, '')
          AND disc_type IS NULL AND unit_price = ?`, order.id, item.id, modsJson, note, unitPrice);
    if (existing) {
      if (existing.qty_milli + qty > MAX_QTY_MILLI) throw new AppError('VALIDATION', 'Quantity is out of range.');
      run(ctx.db, 'UPDATE sale_order_line SET qty_milli = qty_milli + ? WHERE id = ?', qty, existing.id);
    } else {
      const count = get<{ n: number; m: number | null }>(ctx.db, 'SELECT count(*) n, max(sort_no) m FROM sale_order_line WHERE order_id = ?', order.id)!;
      if (count.n >= loadSettings(ctx).maxLines) throw new AppError('CART_FULL', `A bill can have at most ${loadSettings(ctx).maxLines} lines.`, 422);
      run(ctx.db, 'INSERT INTO sale_order_line(id, order_id, item_id, qty_milli, unit_price, modifiers_json, note, sort_no) VALUES (?,?,?,?,?,?,?,?)',
        ctx.ids.next(), order.id, item.id, qty, unitPrice, modsJson, note, (count.m ?? 0) + 1);
    }
    touch(ctx, order.id);
    enforceDiscountPolicy(ctx, actor, order.id);
    return getCart(ctx, order.id);
  });
}

export function updateLine(ctx: Ctx, actor: Actor, requestId: string, input: { lineId: string; qtyMilli?: number; discount?: DiscountSpec | null; note?: string | null; override?: Override }) {
  return cartCmd(ctx, requestId, 'order.update_line', actor, () => {
    assertPerm(actor, 'order.write');
    const line = get<{ id: string; order_id: string; qty_milli: number; disc_type: string | null; disc_value: number | null; note: string | null }>(ctx.db, 'SELECT id, order_id, qty_milli, disc_type, disc_value, note FROM sale_order_line WHERE id = ?', input.lineId);
    if (!line) throw new AppError('NOT_FOUND', 'Line not found.', 404);
    assertOpen(getOrderRow(ctx, line.order_id));
    let qty = line.qty_milli;
    if (input.qtyMilli !== undefined) {
      if (!Number.isSafeInteger(input.qtyMilli) || input.qtyMilli < 1 || input.qtyMilli > MAX_QTY_MILLI) throw new AppError('VALIDATION', 'Quantity is out of range.');
      qty = input.qtyMilli;
    }
    let dt = line.disc_type, dv = line.disc_value;
    if (input.discount !== undefined) { const d = validDiscount(input.discount); dt = d?.type ?? null; dv = d?.value ?? null; }
    const note = input.note === undefined ? line.note : input.note?.trim() ? input.note.trim().slice(0, 120) : null;
    run(ctx.db, 'UPDATE sale_order_line SET qty_milli = ?, disc_type = ?, disc_value = ?, note = ? WHERE id = ?', qty, dt, dv, note, line.id);
    touch(ctx, line.order_id);
    enforceDiscountPolicy(ctx, actor, line.order_id, input.override);
    return getCart(ctx, line.order_id);
  });
}

export function removeLine(ctx: Ctx, actor: Actor, requestId: string, lineId: string, override?: Override) {
  return cartCmd(ctx, requestId, 'order.remove_line', actor, () => {
    assertPerm(actor, 'order.write');
    const line = get<{ order_id: string }>(ctx.db, 'SELECT order_id FROM sale_order_line WHERE id = ?', lineId);
    if (!line) throw new AppError('NOT_FOUND', 'Line not found.', 404);
    assertOpen(getOrderRow(ctx, line.order_id));
    run(ctx.db, 'DELETE FROM sale_order_line WHERE id = ?', lineId);
    touch(ctx, line.order_id);
    enforceDiscountPolicy(ctx, actor, line.order_id, override);
    return getCart(ctx, line.order_id);
  });
}

export function applyBillDiscount(ctx: Ctx, actor: Actor, requestId: string, input: { orderId: string; discount: DiscountSpec | null; override?: Override }) {
  return cartCmd(ctx, requestId, 'order.bill_discount', actor, () => {
    assertPerm(actor, 'order.write');
    assertOpen(getOrderRow(ctx, input.orderId));
    const d = validDiscount(input.discount);
    run(ctx.db, 'UPDATE sale_order SET bill_discount_type = ?, bill_discount_value = ?, updated_at = ? WHERE id = ?', d?.type ?? null, d?.value ?? null, ctx.clock.now(), input.orderId);
    enforceDiscountPolicy(ctx, actor, input.orderId, input.override);
    audit(ctx, actor.userId, 'order.bill_discount', 'order', input.orderId, d);
    return getCart(ctx, input.orderId);
  });
}

export function updateOrder(ctx: Ctx, actor: Actor, requestId: string, input: { orderId: string; customerPhone?: string | null; note?: string | null; buyerGstin?: string | null; placeOfSupply?: string | null }, override?: Override) {
  return cartCmd(ctx, requestId, 'order.update', actor, () => {
    assertPerm(actor, 'order.write');
    const o = getOrderRow(ctx, input.orderId);
    assertOpen(o);
    const gstin = input.buyerGstin === undefined ? o.buyer_gstin : input.buyerGstin;
    if (gstin && !GSTIN_RE.test(gstin)) throw new AppError('VALIDATION', 'GSTIN format is invalid.');
    let pos = input.placeOfSupply === undefined ? o.place_of_supply : input.placeOfSupply;
    if (pos && !/^\d{2}$/.test(pos)) throw new AppError('VALIDATION', 'Place of supply must be a 2-digit state code.');
    if (input.buyerGstin && input.placeOfSupply === undefined) pos = input.buyerGstin.slice(0, 2);
    run(ctx.db, 'UPDATE sale_order SET customer_phone = ?, note = ?, buyer_gstin = ?, place_of_supply = ?, updated_at = ? WHERE id = ?',
      input.customerPhone === undefined ? o.customer_phone : validPhone(input.customerPhone), input.note === undefined ? o.note : input.note, gstin ?? null, pos ?? null, ctx.clock.now(), o.id);
    enforceDiscountPolicy(ctx, actor, o.id, override);
    return getCart(ctx, o.id);
  });
}

export function holdOrder(ctx: Ctx, actor: Actor, requestId: string, orderId: string) {
  return cartCmd(ctx, requestId, 'order.hold', actor, () => {
    assertPerm(actor, 'order.write');
    const o = getOrderRow(ctx, orderId);
    if (o.status !== 'DRAFT') throw new AppError('ORDER_NOT_OPEN', 'Only an active bill can be put on hold.', 409);
    run(ctx.db, "UPDATE sale_order SET status = 'HELD', updated_at = ? WHERE id = ?", ctx.clock.now(), orderId);
    return getCart(ctx, orderId);
  });
}
export function resumeOrder(ctx: Ctx, actor: Actor, requestId: string, orderId: string) {
  return cartCmd(ctx, requestId, 'order.resume', actor, () => {
    assertPerm(actor, 'order.write');
    const o = getOrderRow(ctx, orderId);
    if (o.status !== 'HELD') throw new AppError('ORDER_NOT_OPEN', 'Only a held bill can be resumed.', 409);
    run(ctx.db, "UPDATE sale_order SET status = 'DRAFT', updated_at = ? WHERE id = ?", ctx.clock.now(), orderId);
    return getCart(ctx, orderId);
  });
}
/** Hidden menu items that carry the online order fees on a bill (never sold at the counter, never on the menu). */
export const FEE_ITEMS = { delivery: { sku: 'SYS-DELIVERY', name: 'Delivery charge' }, packaging: { sku: 'SYS-PACKAGING', name: 'Packaging charge' } } as const;

/**
 * Adds a delivery or packaging charge to an order. The amount comes from the POS's own serviceability settings (never from
 * a customer app); the GST rate is the tax group the owner chose for fees. The fee is a line on a hidden system item, so
 * the bill, GST, reports and credit notes treat it like any other line.
 */
export function addFeeLine(ctx: Ctx, actor: Actor, requestId: string, input: { orderId: string; kind: keyof typeof FEE_ITEMS; amount: number; taxGroupId: string }) {
  return cartCmd(ctx, requestId, 'order.add_fee', actor, () => {
    assertPerm(actor, 'order.write');
    const order = getOrderRow(ctx, input.orderId);
    assertOpen(order);
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0 || input.amount > 10_000_00) throw new AppError('VALIDATION', 'A fee must be Rs 0.01 to Rs 10,000.');
    const fee = FEE_ITEMS[input.kind];
    if (!fee) throw new AppError('VALIDATION', 'Unknown fee.');
    if (!get(ctx.db, 'SELECT 1 FROM tax_group WHERE id = ? AND deleted_at IS NULL', input.taxGroupId)) throw new AppError('VALIDATION', 'Choose the GST rate for delivery and packaging charges.');
    const now = ctx.clock.now();
    let item = get<{ id: string; tax_group_id: string }>(ctx.db, 'SELECT id, tax_group_id FROM item WHERE sku = ? AND deleted_at IS NULL', fee.sku);
    if (!item) {
      const id = ctx.ids.next();
      run(ctx.db, 'INSERT INTO item(id, category_id, name, sku, tax_group_id, price, unit, is_veg, active, updated_at) VALUES (?,NULL,?,?,?,0,?,NULL,0,?)', id, fee.name, fee.sku, input.taxGroupId, 'pcs', now);
      item = { id, tax_group_id: input.taxGroupId };
    } else if (item.tax_group_id !== input.taxGroupId) {
      run(ctx.db, 'UPDATE item SET tax_group_id = ?, version = version + 1, updated_at = ? WHERE id = ?', input.taxGroupId, now, item.id);
    }
    const count = get<{ m: number | null }>(ctx.db, 'SELECT max(sort_no) m FROM sale_order_line WHERE order_id = ?', order.id)!;
    run(ctx.db, 'INSERT INTO sale_order_line(id, order_id, item_id, qty_milli, unit_price, modifiers_json, note, sort_no) VALUES (?,?,?,?,?,?,?,?)',
      ctx.ids.next(), order.id, item.id, 1000, input.amount, '[]', null, (count.m ?? 0) + 1);
    touch(ctx, order.id);
    return getCart(ctx, order.id);
  });
}

export function cancelOrder(ctx: Ctx, actor: Actor, requestId: string, orderId: string) {
  return runCommand(ctx, requestId, 'order.cancel', actor, () => {
    assertPerm(actor, 'order.write');
    const o = getOrderRow(ctx, orderId);
    assertOpen(o);
    run(ctx.db, "UPDATE sale_order SET status = 'CANCELLED', updated_at = ? WHERE id = ?", ctx.clock.now(), orderId);
    audit(ctx, actor.userId, 'order.cancel', 'order', orderId);
    return { id: orderId, status: 'CANCELLED' as const };
  });
}

/** Open (DRAFT/HELD) orders. Used to restore the screen after a crash or restart: the server is the source of truth. */
export interface OpenOrderSummary {
  id: string; status: 'DRAFT' | 'HELD'; tokenNo: number; channel: string; updatedAt: number; createdAt: number; lineCount: number;
  customerPhone: string | null; note: string | null; createdByName: string | null; grandTotal: number;
}
/** Open bills (drafts and held bills) with their totals from the tax engine, for the "held bills" list. */
export function listOpenOrders(ctx: Ctx, o: { status?: 'DRAFT' | 'HELD' } = {}): OpenOrderSummary[] {
  const statuses = o.status ? [o.status] : ['DRAFT', 'HELD'];
  const rows = all<{ id: string; status: 'DRAFT' | 'HELD'; token_no: number; channel: string; updated_at: number; created_at: number; customer_phone: string | null; note: string | null; created_by_name: string | null; line_count: number }>(ctx.db,
    `SELECT o.id, o.status, o.token_no, o.channel, o.updated_at, o.created_at, o.customer_phone, o.note, u.name AS created_by_name,
      (SELECT count(*) FROM sale_order_line l WHERE l.order_id = o.id) AS line_count
      FROM sale_order o LEFT JOIN app_user u ON u.id = o.created_by
     WHERE o.status IN (SELECT value FROM json_each(?)) ORDER BY o.updated_at DESC LIMIT 200`, JSON.stringify(statuses));
  return rows.map((r) => ({
    id: r.id, status: r.status, tokenNo: r.token_no, channel: r.channel, updatedAt: r.updated_at, createdAt: r.created_at, lineCount: r.line_count,
    customerPhone: r.customer_phone, note: r.note, createdByName: r.created_by_name,
    grandTotal: r.line_count === 0 ? 0 : getCart(ctx, r.id).totals.grandTotal,
  }));
}
