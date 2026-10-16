import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/store/db.ts';
import { addLine, applyBillDiscount, applyCoupon, createOrder, removeCoupon, updateLine, updateOrder } from '../src/services/orders.ts';
import { cancelInvoice, finalizeInvoice } from '../src/services/invoices.ts';
import { createCoupon, listCoupons, updateCoupon } from '../src/services/coupons.ts';
import type { CouponInput } from '../src/services/coupons.ts';
import { cartOf, makeEnv, rid, startShift } from './helpers.ts';
import type { Env } from './helpers.ts';

const code = (fn: () => unknown): string => { try { fn(); } catch (e) { if (e instanceof AppError) return e.code; throw e; } return 'NO_ERROR'; };
const msg = (fn: () => unknown): string => { try { fn(); } catch (e) { return (e as Error).message; } return ''; };
const coupon = (env: Env, i: Partial<CouponInput> & { code: string }) => createCoupon(env.ctx, env.owner, rid(), { type: 'percent', value: 1000, ...i });
const updateLineQty = (env: Env, lineId: string, qtyMilli: number) => updateLine(env.ctx, env.cashier, rid(), { lineId, qtyMilli });
const pay = (env: Env, orderId: string, amount: number) => finalizeInvoice(env.ctx, env.cashier, rid(), { orderId, payments: [{ mode: 'CASH', amount }] });

test('coupons: only the owner sees and manages them; codes are checked and unique; a cashier can still use one on a bill', () => {
  const env = makeEnv(); try {
    assert.equal(code(() => createCoupon(env.ctx, env.manager, rid(), { code: 'SAVE10', type: 'percent', value: 1000 })), 'FORBIDDEN');
    assert.equal(code(() => coupon(env, { code: 'no spaces' })), 'VALIDATION');
    assert.equal(code(() => coupon(env, { code: 'BIG', value: 10001 })), 'VALIDATION');
    assert.equal(code(() => coupon(env, { code: 'DATES', validFrom: '2026-10-20', validTo: '2026-10-10' })), 'VALIDATION');
    const c = coupon(env, { code: ' save10 ', description: 'Diwali 10% off', maxDiscount: 5000, minBill: 20000 });
    assert.deepEqual([c.code, c.status, c.uses, c.maxDiscount], ['SAVE10', 'active', 0, 5000]);
    assert.equal(code(() => coupon(env, { code: 'SAVE10' })), 'DUPLICATE');
    assert.equal(code(() => listCoupons(env.ctx, env.cashier)), 'FORBIDDEN');
    assert.equal(code(() => listCoupons(env.ctx, env.manager)), 'FORBIDDEN');
    assert.equal(code(() => updateCoupon(env.ctx, env.manager, rid(), c.id, { code: 'SAVE10', type: 'percent', value: 9000 })), 'FORBIDDEN');
    assert.equal(listCoupons(env.ctx, env.owner)[0]!.code, 'SAVE10');
  } finally { env.cleanup(); }
});

test('coupons on a bill: percent with a cap, minimum bill, no manager PIN, re-checked at payment, counted as used', () => {
  const env = makeEnv(); try {
    startShift(env);
    coupon(env, { code: 'SAVE10', value: 1000, maxDiscount: 3000, minBill: 20000, maxUses: 1 });
    // Rs 129 bill: below the Rs 200 minimum
    let cart = cartOf(env, [['Cheese Burger']]);
    assert.match(msg(() => applyCoupon(env.ctx, env.cashier, rid(), { orderId: cart.order.id, code: 'save10' })), /at least Rs 200\.00/);
    assert.equal(code(() => applyCoupon(env.ctx, env.cashier, rid(), { orderId: cart.order.id, code: 'NOPE' })), 'COUPON_INVALID');
    // 3 burgers = Rs 387: 10% is Rs 38.70, capped at Rs 30
    cart = addLine(env.ctx, env.cashier, rid(), { orderId: cart.order.id, itemId: env.items['Cheese Burger']!, qtyMilli: 2000 });
    const withCoupon = applyCoupon(env.ctx, env.cashier, rid(), { orderId: cart.order.id, code: 'SAVE10' });
    assert.deepEqual(withCoupon.order.coupon, { code: 'SAVE10', description: null, problem: null });
    assert.equal(withCoupon.totals.discountTotal, 3000);
    assert.equal(withCoupon.totals.grandTotal, cart.totals.grandTotal - 3000);
    // removing items below the minimum: the cart says why, and the bill cannot be paid with it
    const line = withCoupon.lines[0]!.id;
    let smaller = updateLineQty(env, line, 1000);
    assert.match(smaller.order.coupon!.problem!, /at least Rs 200\.00/);
    assert.equal(smaller.totals.discountTotal, 0);
    assert.equal(code(() => pay(env, cart.order.id, smaller.totals.grandTotal)), 'COUPON_INVALID');
    smaller = updateLineQty(env, line, 3000);
    const paid = pay(env, cart.order.id, smaller.totals.grandTotal);
    assert.equal(paid.invoice.discountTotal, 3000);
    // max 1 use: used up for the next bill; cancelling that bill frees the use
    const next = cartOf(env, [['Cheese Burger', 3000]]);
    assert.match(msg(() => applyCoupon(env.ctx, env.cashier, rid(), { orderId: next.order.id, code: 'SAVE10' })), /maximum number of times/);
    assert.equal(listCoupons(env.ctx, env.owner)[0]!.status, 'used_up');
    cancelInvoice(env.ctx, env.manager, rid(), { invoiceId: paid.invoice.id, reason: 'test' });
    assert.equal(applyCoupon(env.ctx, env.cashier, rid(), { orderId: next.order.id, code: 'SAVE10' }).totals.discountTotal, 3000);
  } finally { env.cleanup(); }
});

test('coupons: a big coupon needs no manager PIN (the owner approved it), dates and switching off are respected, a manual discount replaces it', () => {
  const env = makeEnv(); try {
    startShift(env);
    coupon(env, { code: 'HALF', value: 5000 });
    coupon(env, { code: 'FLAT50', type: 'amount', value: 5000 });
    coupon(env, { code: 'LATER', validFrom: '2026-11-01' });
    const old = coupon(env, { code: 'OLD', validTo: '2026-10-01' });
    const cart = cartOf(env, [['Cheese Burger'], ['Brownie']]);
    const half = applyCoupon(env.ctx, env.cashier, rid(), { orderId: cart.order.id, code: 'HALF' }); // 50%: far above the cashier limit
    assert.equal(half.totals.discountTotal, Math.round((12900 + 8900) / 2));
    assert.match(msg(() => applyCoupon(env.ctx, env.cashier, rid(), { orderId: cart.order.id, code: 'LATER' })), /starts on 2026-11-01/);
    assert.match(msg(() => applyCoupon(env.ctx, env.cashier, rid(), { orderId: cart.order.id, code: 'OLD' })), /ended on 2026-10-01/);
    const flat = applyCoupon(env.ctx, env.cashier, rid(), { orderId: cart.order.id, code: 'FLAT50' });
    assert.deepEqual([flat.order.coupon!.code, flat.totals.discountTotal], ['FLAT50', 5000]);
    // switched off while on a bill: the bill shows why
    updateCoupon(env.ctx, env.owner, rid(), listCoupons(env.ctx, env.owner).find((c) => c.code === 'FLAT50')!.id, { code: 'FLAT50', type: 'amount', value: 5000, active: false });
    const off = updateOrder(env.ctx, env.cashier, rid(), { orderId: cart.order.id, note: 'x' });
    assert.match(off.order.coupon!.problem!, /switched off/);
    // a manual bill discount replaces the coupon; removing the coupon leaves no discount
    const manual = applyBillDiscount(env.ctx, env.cashier, rid(), { orderId: cart.order.id, discount: { type: 'amount', value: 1000 } });
    assert.deepEqual([manual.order.coupon, manual.totals.discountTotal], [null, 1000]);
    applyCoupon(env.ctx, env.cashier, rid(), { orderId: cart.order.id, code: 'HALF' });
    const none = removeCoupon(env.ctx, env.cashier, rid(), cart.order.id);
    assert.deepEqual([none.order.coupon, none.order.billDiscount, none.totals.discountTotal], [null, null, 0]);
    // an amount coupon larger than the bill takes the bill to zero, not below
    const small = cartOf(env, [['Water Bottle 1L']]);
    assert.equal(applyCoupon(env.ctx, env.cashier, rid(), { orderId: small.order.id, code: 'HALF' }).totals.discountTotal, 1000);
    assert.equal(old.status, 'expired');
    // an empty bill cannot take a coupon
    const empty = createOrder(env.ctx, env.cashier, rid());
    assert.equal(code(() => applyCoupon(env.ctx, env.cashier, rid(), { orderId: empty.order.id, code: 'HALF' })), 'EMPTY_CART');
  } finally { env.cleanup(); }
});

test('customer names keep their letters (spaces squeezed, not the letter s)', () => {
  const env = makeEnv(); try {
    startShift(env);
    const o = createOrder(env.ctx, env.cashier, rid(), { customerName: '  Asha   Sen  ' });
    assert.equal(o.order.customerName, 'Asha Sen');
  } finally { env.cleanup(); }
});
