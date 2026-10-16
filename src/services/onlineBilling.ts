import { get, AppError } from '../store/db.ts';
import type { Actor, Ctx, Role } from './ctx.ts';
import { addFeeLine, addLine, cancelOrder, createOrder, getCart, getOrderRow, openShiftRow } from './orders.ts';
import { cancelInvoice, finalizeInvoice } from './invoices.ts';
import { getCatalog } from './catalog.ts';
import type { Override } from './auth.ts';
import { loadSettings } from './settings.ts';

/**
 * Online orders become ordinary GST bills here (used by the ODS add-on through HostApi.billing).
 * One bill = create order -> add lines -> add fee lines -> finalize. Each step has its own request id derived from the
 * caller's, so a retry (or a POS restart in the middle) resumes exactly where it stopped; the order's external id
 * (the hub order number) makes accepting the same hub order twice return the same bill. If a step fails, the draft
 * order is cancelled, so nothing is left open on the counter.
 */

export type OnlineChannel = 'APP' | 'WEBSITE' | 'SWIGGY' | 'ZOMATO';
const ONLINE_CHANNELS: OnlineChannel[] = ['APP', 'WEBSITE', 'SWIGGY', 'ZOMATO'];
export interface OnlineBillInput {
  channel: OnlineChannel;
  /** The hub's order number, e.g. "W-1042". */
  externalId: string;
  customerPhone?: string | null;
  note?: string | null;
  lines: Array<{ itemId: string; qtyMilli: number; modifierIds?: string[]; note?: string | null }>;
  /** Fees computed by the POS from its serviceability settings; taxGroupId may be null only when both are 0. */
  fees: { delivery: number; packaging: number; taxGroupId: string | null };
  /** COD is collected as CASH by the store's rider or at pickup; online-paid orders arrive as UPI (phase 3: gateway). */
  paymentMode: 'CASH' | 'UPI' | 'CARD' | 'WALLET' | 'OTHER';
}
export interface OnlineBill { invoiceId: string; invoiceNo: string; grandTotal: number; tokenNo: number | null; orderId: string }

function existingBill(ctx: Ctx, channel: string, externalId: string): OnlineBill | null {
  const r = get<{ id: string; invoice_no: string; grand_total: number; token_no: number | null; order_id: string }>(ctx.db,
    `SELECT i.id, i.invoice_no, i.grand_total, i.token_no, i.order_id FROM invoice i JOIN sale_order o ON o.id = i.order_id
      WHERE o.channel = ? AND o.external_id = ? AND i.doc_type = 'TAX_INVOICE' ORDER BY i.issued_at LIMIT 1`, channel, externalId);
  return r ? { invoiceId: r.id, invoiceNo: r.invoice_no, grandTotal: r.grand_total, tokenNo: r.token_no, orderId: r.order_id } : null;
}

export function billOnlineOrder(ctx: Ctx, actor: Actor, requestId: string, input: OnlineBillInput): OnlineBill {
  if (!ONLINE_CHANNELS.includes(input.channel)) throw new AppError('VALIDATION', 'Unknown online channel.');
  if (typeof input.externalId !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(input.externalId)) throw new AppError('VALIDATION', 'The online order number is not valid.');
  if (!Array.isArray(input.lines) || input.lines.length === 0) throw new AppError('EMPTY_CART', 'The online order has no items.', 422);
  const done = existingBill(ctx, input.channel, input.externalId);
  if (done) return done;
  const settings = loadSettings(ctx);
  if (settings.requireShift && !openShiftRow(ctx)) throw new AppError('NO_OPEN_SHIFT', 'Open a shift before accepting online orders.', 409);
  const fees = input.fees ?? { delivery: 0, packaging: 0, taxGroupId: null };
  if ((fees.delivery > 0 || fees.packaging > 0) && !fees.taxGroupId) throw new AppError('VALIDATION', 'Choose the GST rate for delivery and packaging charges (Settings > Serviceability).');

  // a draft from an earlier, interrupted attempt for the same hub order is reused
  const draft = get<{ id: string }>(ctx.db, "SELECT id FROM sale_order WHERE channel = ? AND external_id = ? AND status IN ('DRAFT','HELD')", input.channel, input.externalId);
  const orderId = draft?.id ?? createOrder(ctx, actor, `${requestId}:order`, { channel: input.channel, customerPhone: input.customerPhone ?? null, note: input.note ?? null }).order.id;
  if (!draft) ctx.db.prepare('UPDATE sale_order SET external_id = ? WHERE id = ?').run(input.externalId, orderId);
  try {
    if (!draft || getCart(ctx, orderId).lines.length === 0) {
      input.lines.forEach((l, i) => addLine(ctx, actor, `${requestId}:line:${i}`, { orderId, itemId: l.itemId, qtyMilli: l.qtyMilli, modifierIds: l.modifierIds ?? [], note: l.note ?? null }));
      if (fees.delivery > 0) addFeeLine(ctx, actor, `${requestId}:fee:delivery`, { orderId, kind: 'delivery', amount: fees.delivery, taxGroupId: fees.taxGroupId! });
      if (fees.packaging > 0) addFeeLine(ctx, actor, `${requestId}:fee:packaging`, { orderId, kind: 'packaging', amount: fees.packaging, taxGroupId: fees.taxGroupId! });
    }
    const total = getCart(ctx, orderId).totals.grandTotal;
    const inv = finalizeInvoice(ctx, actor, `${requestId}:bill`, { orderId, payments: [{ mode: input.paymentMode, amount: total }] });
    return { invoiceId: inv.invoice.id, invoiceNo: inv.invoice.invoiceNo, grandTotal: inv.invoice.grandTotal, tokenNo: inv.invoice.tokenNo, orderId };
  } catch (e) {
    if (getOrderRow(ctx, orderId).status === 'DRAFT') {
      try { cancelOrder(ctx, actor, `${requestId}:undo`, orderId); } catch (err) { ctx.logger.error('could not cancel the draft online order', String(err)); }
    }
    throw e;
  }
}

/** The store cancels an online order it had accepted: the bill is cancelled (same day; otherwise a credit note is needed). */
export function cancelOnlineBill(ctx: Ctx, actor: Actor, requestId: string, input: { invoiceId: string; reason: string; override?: Override }) {
  return cancelInvoice(ctx, actor, requestId, { invoiceId: input.invoiceId, reason: input.reason, override: input.override }); // a manager approves, as for any cancelled bill
}

/** Who has the shift open on this counter: automatic accepting bills as them. Null when no shift is open. */
export function shiftActor(ctx: Ctx): Actor | null {
  const s = openShiftRow(ctx);
  if (!s) return null;
  const u = get<{ id: string; name: string; role: Role }>(ctx.db, 'SELECT id, name, role FROM app_user WHERE id = ? AND active = 1', s.user_id);
  return u ? { userId: u.id, name: u.name, role: u.role } : null;
}

/** What customers may order online: the active menu with prices, GST and options (published to the order hub). */
export function onlineMenu(ctx: Ctx) {
  const c = getCatalog(ctx);
  const groups = new Map((c.taxGroups as Array<{ id: string; rateBp: number; cessBp: number; priceIncludesTax: number }>).map((t) => [t.id, t]));
  const items = (c.items as Array<Record<string, unknown>>).filter((i) => !String(i.sku ?? '').startsWith('SYS-')).map((i) => {
    const t = groups.get(String(i.taxGroupId));
    return {
      id: String(i.id), categoryId: (i.categoryId as string | null) ?? null, name: String(i.name), price: Number(i.price), unit: String(i.unit),
      isVeg: i.isVeg === null || i.isVeg === undefined ? null : Boolean(i.isVeg), rateBp: t?.rateBp ?? 0, cessBp: t?.cessBp ?? 0, priceIncludesTax: (t?.priceIncludesTax ?? 1) === 1,
      modifierGroupIds: (i.modifierGroupIds as string[]) ?? [], available: true,
    };
  });
  const categories = (c.categories as Array<{ id: string; name: string; sortOrder: number }>).map((x) => ({ id: x.id, name: x.name, sort: x.sortOrder }));
  const taxGroups = [...groups.values()].map((t) => ({ id: t.id, name: String((t as unknown as { name: string }).name), rateBp: t.rateBp, cessBp: t.cessBp, priceIncludesTax: t.priceIncludesTax === 1 }));
  return { categories, items, modifierGroups: c.modifierGroups, taxGroups, roundToRupee: loadSettings(ctx).roundToRupee };
}

export const listOnlineChannels = () => [...ONLINE_CHANNELS];
