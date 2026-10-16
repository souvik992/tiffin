import { all, get, run, AppError } from '../store/db.ts';
import type { Actor, Ctx } from './ctx.ts';
import { runCommand } from './commands.ts';
import { audit } from './audit.ts';
import { assertPerm } from './permissions.ts';
import { istDay } from '../core/numbering.ts';
import type { DiscountSpec } from '../core/discount.ts';

/**
 * Coupon codes. Only the owner sees and manages them (Settings > Coupons); a cashier types the code on a bill. A coupon becomes the
 * bill discount (percent or amount, a percent one optionally capped), so tax works exactly like a manual bill discount.
 * The owner approved the coupon when creating it, so its discount does not need a manager PIN (line discounts still do).
 * Checked when applied and again when the bill is paid: active, dates (India time), minimum bill, number of uses.
 * A use = a paid bill with the coupon that is not cancelled.
 */

export interface CouponRow {
  id: string; code: string; description: string | null; type: 'amount' | 'percent'; value: number; max_discount: number | null;
  min_bill: number; valid_from: string | null; valid_to: string | null; max_uses: number | null; active: number; created_at: number; updated_at: number;
}
export interface CouponInput {
  code: string; description?: string | null; type: 'amount' | 'percent'; value: number; maxDiscount?: number | null;
  minBill?: number | null; validFrom?: string | null; validTo?: string | null; maxUses?: number | null; active?: boolean;
}

const fail = (m: string): never => { throw new AppError('VALIDATION', m); };
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PAISE = 10_000_000_00; // Rs 1 crore

export function couponUses(ctx: Ctx, couponId: string): number {
  return get<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM invoice i JOIN sale_order o ON o.id = i.order_id WHERE o.coupon_id = ? AND i.doc_type = 'TAX_INVOICE' AND i.status <> 'CANCELLED'", couponId)!.n;
}

function view(ctx: Ctx, c: CouponRow) {
  const uses = couponUses(ctx, c.id);
  return {
    id: c.id, code: c.code, description: c.description, type: c.type, value: c.value, maxDiscount: c.max_discount, minBill: c.min_bill,
    validFrom: c.valid_from, validTo: c.valid_to, maxUses: c.max_uses, active: c.active === 1, uses, createdAt: c.created_at, updatedAt: c.updated_at,
    status: statusOf(ctx, c, uses),
  };
}
/** 'active' or why it cannot be used today. */
function statusOf(ctx: Ctx, c: CouponRow, uses: number): 'active' | 'off' | 'not_started' | 'expired' | 'used_up' {
  const today = istDay(ctx.clock.now());
  if (c.active !== 1) return 'off';
  if (c.valid_from && today < c.valid_from) return 'not_started';
  if (c.valid_to && today > c.valid_to) return 'expired';
  if (c.max_uses !== null && uses >= c.max_uses) return 'used_up';
  return 'active';
}

function checked(i: CouponInput) {
  const code = String(i.code ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9-]{3,20}$/.test(code)) fail('Coupon code: 3 to 20 letters, numbers or dashes (for example SAVE10).');
  const description = typeof i.description === 'string' && i.description.trim() ? i.description.trim().slice(0, 80) : null;
  if (i.type !== 'percent' && i.type !== 'amount') fail('Choose percent or amount.');
  if (!Number.isSafeInteger(i.value) || i.value <= 0) fail('Enter how much the coupon takes off.');
  if (i.type === 'percent' && i.value > 10000) fail('A percent coupon can take off at most 100%.');
  if (i.type === 'amount' && i.value > MAX_PAISE) fail('That amount is too large.');
  const maxDiscount = i.type === 'percent' && i.maxDiscount ? i.maxDiscount : null;
  if (maxDiscount !== null && (!Number.isSafeInteger(maxDiscount) || maxDiscount <= 0 || maxDiscount > MAX_PAISE)) fail('Enter a valid maximum discount.');
  const minBill = i.minBill ?? 0;
  if (!Number.isSafeInteger(minBill) || minBill < 0 || minBill > MAX_PAISE) fail('Enter a valid minimum bill.');
  const validFrom = i.validFrom || null, validTo = i.validTo || null;
  if ((validFrom && !DAY.test(validFrom)) || (validTo && !DAY.test(validTo))) fail('Dates must look like 2026-10-31.');
  if (validFrom && validTo && validTo < validFrom) fail('The end date is before the start date.');
  const maxUses = i.maxUses ?? null;
  if (maxUses !== null && (!Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > 1_000_000)) fail('Number of uses must be 1 or more (empty = no limit).');
  return { code, description, type: i.type, value: i.value, maxDiscount, minBill, validFrom, validTo, maxUses, active: i.active === false ? 0 : 1 };
}

export function listCoupons(ctx: Ctx, actor: Actor) {
  assertPerm(actor, 'settings.write'); // owner only
  return all<CouponRow>(ctx.db, 'SELECT * FROM coupon ORDER BY active DESC, code').map((c) => view(ctx, c));
}

export function createCoupon(ctx: Ctx, actor: Actor, requestId: string, input: CouponInput) {
  return runCommand(ctx, requestId, 'coupon.create', actor, () => {
    assertPerm(actor, 'settings.write'); // only the owner gives money away
    const c = checked(input);
    if (get(ctx.db, 'SELECT 1 FROM coupon WHERE code = ?', c.code)) throw new AppError('DUPLICATE', `There is already a coupon ${c.code}.`, 409);
    const id = ctx.ids.next(), now = ctx.clock.now();
    run(ctx.db, 'INSERT INTO coupon(id, code, description, type, value, max_discount, min_bill, valid_from, valid_to, max_uses, active, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id, c.code, c.description, c.type, c.value, c.maxDiscount, c.minBill, c.validFrom, c.validTo, c.maxUses, c.active, now, now);
    audit(ctx, actor.userId, 'coupon.create', 'coupon', id, c);
    return view(ctx, get<CouponRow>(ctx.db, 'SELECT * FROM coupon WHERE id = ?', id)!);
  });
}

/** Changes apply to bills paid from now on; a used coupon keeps its code (bills and reports refer to it). */
export function updateCoupon(ctx: Ctx, actor: Actor, requestId: string, id: string, input: CouponInput) {
  return runCommand(ctx, requestId, 'coupon.update', actor, () => {
    assertPerm(actor, 'settings.write');
    const old = get<CouponRow>(ctx.db, 'SELECT * FROM coupon WHERE id = ?', id);
    if (!old) throw new AppError('NOT_FOUND', 'Coupon not found.', 404);
    const c = checked(input);
    if (c.code !== old.code) {
      if (couponUses(ctx, id) > 0) fail('This coupon has been used, so its code cannot change. Switch it off and create a new one.');
      if (get(ctx.db, 'SELECT 1 FROM coupon WHERE code = ? AND id <> ?', c.code, id)) throw new AppError('DUPLICATE', `There is already a coupon ${c.code}.`, 409);
    }
    run(ctx.db, 'UPDATE coupon SET code = ?, description = ?, type = ?, value = ?, max_discount = ?, min_bill = ?, valid_from = ?, valid_to = ?, max_uses = ?, active = ?, updated_at = ? WHERE id = ?',
      c.code, c.description, c.type, c.value, c.maxDiscount, c.minBill, c.validFrom, c.validTo, c.maxUses, c.active, ctx.clock.now(), id);
    audit(ctx, actor.userId, 'coupon.update', 'coupon', id, c);
    return view(ctx, get<CouponRow>(ctx.db, 'SELECT * FROM coupon WHERE id = ?', id)!);
  });
}

export function findCouponByCode(ctx: Ctx, code: string): CouponRow {
  const c = get<CouponRow>(ctx.db, 'SELECT * FROM coupon WHERE code = ?', String(code ?? '').trim().toUpperCase());
  if (!c) throw new AppError('COUPON_INVALID', 'No coupon with this code. Check the spelling.', 422);
  return c;
}
export const couponById = (ctx: Ctx, id: string) => get<CouponRow>(ctx.db, 'SELECT * FROM coupon WHERE id = ?', id);

/** Why this coupon cannot be used on a bill of this size right now (null = it can). */
export function couponProblem(ctx: Ctx, c: CouponRow, billGross: number): string | null {
  const s = statusOf(ctx, c, couponUses(ctx, c.id));
  if (s === 'off') return `Coupon ${c.code} is switched off.`;
  if (s === 'not_started') return `Coupon ${c.code} starts on ${c.valid_from}.`;
  if (s === 'expired') return `Coupon ${c.code} ended on ${c.valid_to}.`;
  if (s === 'used_up') return `Coupon ${c.code} has been used the maximum number of times.`;
  if (billGross < c.min_bill) return `Coupon ${c.code} needs a bill of at least Rs ${(c.min_bill / 100).toFixed(2)}.`;
  return null;
}

/** The coupon as a bill discount, before a percent cap (the cap is applied by computeFor, which knows the bill). */
export const couponDiscount = (c: CouponRow): DiscountSpec => ({ type: c.type, value: c.value });
