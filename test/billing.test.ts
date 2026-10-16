import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { all, get } from '../src/store/db.ts';
import { addLine, applyBillDiscount, cancelOrder, createOrder, getCart, holdOrder, listOpenOrders, removeLine, resumeOrder, updateOrder } from '../src/services/orders.ts';
import { cancelInvoice, createCreditNote, finalizeInvoice, getInvoice } from '../src/services/invoices.ts';
import { closeShift, zReport } from '../src/services/shifts.ts';
import { recomputeDailySummary } from '../src/services/reports.ts';
import { verifyAuditChain } from '../src/services/audit.ts';
import { createItem, updateItem } from '../src/services/catalog.ts';
import { createCtx, silentLogger } from '../src/services/ctx.ts';
import { cartOf, makeEnv, quickBill, rid, startShift } from './helpers.ts';
import { AppError } from '../src/store/db.ts';

const code = (fn: () => unknown): string => { try { fn(); } catch (e) { if (e instanceof AppError) return e.code; throw e; } return 'NO_ERROR'; };

test('finalize: immutable invoice, hand-checked GST, journal, outbox, audit and print jobs', () => {
  const env = makeEnv(); try {
    startShift(env);
    const cart = cartOf(env, [['Classic Veg Burger', 1000], ['Cold Coffee', 2000]]);
    // hand-checked: burger 9900 -> taxable 9429, tax 471 (236/235); coffee x2 23800 -> taxable 22667, tax 1133 (567/566)
    assert.deepEqual([cart.totals.grossTotal, cart.totals.taxableTotal, cart.totals.cgst, cart.totals.sgst, cart.totals.grandTotal], [33700, 32096, 803, 801, 33700]);
    const r = finalizeInvoice(env.ctx, env.cashier, rid(), { orderId: cart.order.id, payments: [{ mode: 'CASH', amount: 33700, tendered: 50000 }] });
    assert.equal(r.invoice.invoiceNo, 'A1/26-27/000001');
    assert.equal(r.changeDue, 16300);
    assert.equal(r.lines.length, 2);
    assert.equal(getCart(env.ctx, cart.order.id).order.status, 'INVOICED');
    // immutability is enforced by the database itself
    assert.throws(() => env.ctx.db.exec("UPDATE invoice SET grand_total = 1 WHERE invoice_no = 'A1/26-27/000001'"), /immutable/);
    assert.throws(() => env.ctx.db.exec('DELETE FROM invoice'), /cannot be deleted/);
    assert.throws(() => env.ctx.db.exec('UPDATE invoice_line SET qty_milli = 5'), /immutable/);
    assert.throws(() => env.ctx.db.exec('UPDATE payment SET amount = 1'), /immutable/);
    assert.throws(() => env.ctx.db.exec("INSERT INTO sale_order_line(id, order_id, item_id, qty_milli, unit_price, sort_no) VALUES ('x', '" + cart.order.id + "', '" + env.items['Brownie'] + "', 1000, 1, 9)"), /not open/);
    // side effects in the same transaction
    assert.equal(get<{ n: number }>(env.ctx.db, "SELECT count(*) n FROM outbox WHERE entity='invoice' AND op='create'")!.n, 1);
    assert.equal(all(env.ctx.db, "SELECT 1 FROM print_job WHERE kind='RECEIPT'").length, 1);
    assert.equal(all(env.ctx.db, "SELECT 1 FROM print_job WHERE kind='KOT'").length, 2); // kitchen + bar
    assert.equal(verifyAuditChain(env.ctx.db).ok, true);
    const journal = readFileSync(join(env.ctx.journalDir, '2026-10-12.ndjson'), 'utf8').trim().split('\n');
    assert.ok(journal.some((l) => JSON.parse(l).type === 'invoice' && JSON.parse(l).full.invoice.invoiceNo === 'A1/26-27/000001'));
  } finally { env.cleanup(); }
});

test('idempotency: same requestId replays; new requestId on a billed order is refused', () => {
  const env = makeEnv(); try {
    startShift(env);
    const cart = cartOf(env, [['French Fries']]);
    const id = rid();
    const a = finalizeInvoice(env.ctx, env.cashier, id, { orderId: cart.order.id, payments: [{ mode: 'UPI', amount: 7900 }] });
    const b = finalizeInvoice(env.ctx, env.cashier, id, { orderId: cart.order.id, payments: [{ mode: 'UPI', amount: 7900 }] });
    assert.equal(a.invoice.id, b.invoice.id);
    assert.equal(get<{ n: number }>(env.ctx.db, 'SELECT count(*) n FROM invoice')!.n, 1);
    assert.equal(code(() => finalizeInvoice(env.ctx, env.cashier, rid(), { orderId: cart.order.id, payments: [{ mode: 'UPI', amount: 7900 }] })), 'ORDER_ALREADY_INVOICED');
    assert.equal(code(() => cancelOrder(env.ctx, env.cashier, id, cart.order.id)), 'REQUEST_ID_REUSED');
    // replayed cart commands rebuild the cart instead of storing it
    const c2 = createOrder(env.ctx, env.cashier, 'cart-req-0001');
    assert.equal(createOrder(env.ctx, env.cashier, 'cart-req-0001').order.id, c2.order.id);
    assert.ok(get<{ l: number }>(env.ctx.db, "SELECT length(result_json) l FROM command_log WHERE request_id='cart-req-0001'")!.l < 100);
  } finally { env.cleanup(); }
});

test('payments must add up exactly; tendered and shift rules', () => {
  const env = makeEnv(); try {
    const cart = cartOf(env, [['French Fries']]);
    assert.equal(code(() => finalizeInvoice(env.ctx, env.cashier, rid(), { orderId: cart.order.id, payments: [{ mode: 'CASH', amount: 7900 }] })), 'NO_OPEN_SHIFT');
    startShift(env);
    const pay = (p: Array<{ mode: string; amount: number; tendered?: number }>) => code(() => finalizeInvoice(env.ctx, env.cashier, rid(), { orderId: cart.order.id, payments: p }));
    assert.equal(pay([{ mode: 'CASH', amount: 7800 }]), 'PAYMENT_MISMATCH');
    assert.equal(pay([{ mode: 'CASH', amount: 8000 }]), 'PAYMENT_MISMATCH');
    assert.equal(pay([]), 'PAYMENT_REQUIRED');
    assert.equal(pay([{ mode: 'CASH', amount: 7900, tendered: 5000 }]), 'CASH_TENDERED_TOO_LOW');
    assert.equal(pay([{ mode: 'UPI', amount: 7900, tendered: 8000 }]), 'VALIDATION');
    const split = finalizeInvoice(env.ctx, env.cashier, rid(), { orderId: cart.order.id, payments: [{ mode: 'CASH', amount: 4000, tendered: 5000 }, { mode: 'UPI', amount: 3900 }] });
    assert.equal(split.payments.length, 2);
    assert.equal(split.changeDue, 1000);
    assert.equal(code(() => finalizeInvoice(env.ctx, env.cashier, rid(), { orderId: createOrder(env.ctx, env.cashier, rid()).order.id, payments: [] })), 'EMPTY_CART');
  } finally { env.cleanup(); }
});

test('numbering is gapless, per financial year, and starts again on 1 April (IST)', () => {
  const env = makeEnv(); try {
    startShift(env);
    const nos = [1, 2, 3].map(() => quickBill(env, [['Masala Chai']]).invoice.invoiceNo);
    assert.deepEqual(nos, ['A1/26-27/000001', 'A1/26-27/000002', 'A1/26-27/000003']);
    env.clock.t = Date.UTC(2027, 2, 31, 18, 29, 0); // 31 Mar 2027 23:59 IST
    assert.equal(quickBill(env, [['Masala Chai']]).invoice.invoiceNo, 'A1/26-27/000004');
    env.clock.advance(2 * 60_000); // 1 Apr 2027 00:01 IST
    assert.equal(quickBill(env, [['Masala Chai']]).invoice.invoiceNo, 'A1/27-28/000001');
  } finally { env.cleanup(); }
});

test('discount policy: cashier limit, manager override, and approval cannot be inflated', () => {
  const env = makeEnv(); try {
    startShift(env);
    const cart = cartOf(env, [['Classic Veg Burger'], ['Cheese Burger']]); // 9900 + 12900 = 22800
    const ov = { userId: env.manager.userId, pin: '2345' };
    const d = (value: number, override?: typeof ov) => applyBillDiscount(env.ctx, env.cashier, rid(), { orderId: cart.order.id, discount: { type: 'percent', value }, override });
    assert.equal(d(1000).totals.discountTotal, 2280); // exactly 10% is within the cashier limit
    assert.equal(code(() => d(2000)), 'APPROVAL_REQUIRED');
    assert.equal(code(() => d(2000, { userId: env.manager.userId, pin: '9999' })), 'BAD_PIN');
    assert.equal(code(() => d(2000, { userId: env.cashier.userId, pin: '1111' })), 'APPROVAL_REQUIRED'); // a cashier cannot approve
    assert.equal(d(2000, ov).order.discountApproved, true);
    // amount discount approved at ~13%, then removing an item would push it to 30%: needs approval again
    applyBillDiscount(env.ctx, env.cashier, rid(), { orderId: cart.order.id, discount: { type: 'amount', value: 3000 }, override: ov });
    const lineId = getCart(env.ctx, cart.order.id).lines[1]!.id;
    assert.equal(code(() => removeLine(env.ctx, env.cashier, rid(), lineId)), 'APPROVAL_REQUIRED');
    assert.equal(getCart(env.ctx, cart.order.id).lines.length, 2); // rolled back
    // managers need no override
    assert.equal(applyBillDiscount(env.ctx, env.manager, rid(), { orderId: cart.order.id, discount: { type: 'percent', value: 5000 } }).totals.discountTotal, 11400);
    // discount larger than the bill is rejected
    assert.equal(code(() => applyBillDiscount(env.ctx, env.manager, rid(), { orderId: cart.order.id, discount: { type: 'amount', value: 99999 } })), 'INVALID_AMOUNT');
  } finally { env.cleanup(); }
});

test('wrong approval PINs count toward lockout even though the command rolls back', () => {
  const env = makeEnv(); try {
    const cart = cartOf(env, [['Classic Veg Burger']]);
    const attempt = (pin: string) => code(() => applyBillDiscount(env.ctx, env.cashier, rid(), { orderId: cart.order.id, discount: { type: 'percent', value: 5000 }, override: { userId: env.manager.userId, pin } }));
    for (let i = 0; i < 5; i++) assert.equal(attempt('0000'), 'BAD_PIN');
    assert.equal(attempt('2345'), 'LOCKED'); // even the right PIN is refused while locked
    env.clock.advance(31_000);
    assert.equal(attempt('2345'), 'NO_ERROR');
  } finally { env.cleanup(); }
});

test('cancel: manager approval, same-day only, reverses totals; later days need a credit note', () => {
  const env = makeEnv(); try {
    startShift(env);
    const keep = quickBill(env, [['Cheese Burger']]);
    const gone = quickBill(env, [['Brownie']]);
    assert.equal(code(() => cancelInvoice(env.ctx, env.cashier, rid(), { invoiceId: gone.invoice.id, reason: 'wrong item' })), 'APPROVAL_REQUIRED');
    cancelInvoice(env.ctx, env.cashier, rid(), { invoiceId: gone.invoice.id, reason: 'wrong item', override: { userId: env.manager.userId, pin: '2345' } });
    assert.equal(getInvoice(env.ctx, gone.invoice.id).invoice.status, 'CANCELLED');
    assert.equal(getInvoice(env.ctx, gone.invoice.id).invoice.invoiceNo, gone.invoice.invoiceNo); // number is kept
    assert.equal(code(() => cancelInvoice(env.ctx, env.manager, rid(), { invoiceId: gone.invoice.id, reason: 'again' })), 'ALREADY_CANCELLED');
    assert.throws(() => env.ctx.db.exec("UPDATE invoice SET status = 'ISSUED' WHERE status = 'CANCELLED'"), /cannot be reinstated/);
    const row = get<{ invoices: number; cancelled: number; sales_total: number }>(env.ctx.db, 'SELECT * FROM daily_summary')!;
    assert.deepEqual([row.invoices, row.cancelled, row.sales_total], [1, 1, keep.invoice.grandTotal]);
    env.clock.advance(24 * 3600_000);
    assert.equal(code(() => cancelInvoice(env.ctx, env.manager, rid(), { invoiceId: keep.invoice.id, reason: 'late' })), 'USE_CREDIT_NOTE');
  } finally { env.cleanup(); }
});

test('credit notes: partial returns add up to exactly the original, no paisa drift', () => {
  const env = makeEnv(); try {
    startShift(env);
    const sale = quickBill(env, [['Classic Veg Burger', 3000]]); // 29700, one line, qty 3
    assert.equal(sale.invoice.grandTotal, 29700);
    const lineId = sale.lines[0]!.id;
    const ov = { userId: env.manager.userId, pin: '2345' };
    const cn = (qty: number, refund?: number, override: typeof ov | null = ov) => createCreditNote(env.ctx, env.cashier, rid(), {
      invoiceId: sale.invoice.id, lines: [{ invoiceLineId: lineId, qtyMilli: qty }], reason: 'customer return',
      refunds: [{ mode: 'CASH', amount: refund ?? 0 }], override: override ?? undefined });
    assert.equal(code(() => cn(1000, 9901, null)), 'APPROVAL_REQUIRED');
    assert.equal(code(() => cn(1000, 9900)), 'PAYMENT_MISMATCH'); // refund must equal the computed credit exactly
    const c1 = cn(1000, 9901), c2 = cn(1000, 9901), c3 = cn(1000, 9898); // last return takes exactly what is left
    assert.deepEqual([c1, c2, c3].map((c) => c.invoice.invoiceNo), ['A1C/26-27/000001', 'A1C/26-27/000002', 'A1C/26-27/000003']);
    assert.equal(c1.invoice.grandTotal + c2.invoice.grandTotal + c3.invoice.grandTotal, sale.invoice.grandTotal);
    assert.equal(code(() => cn(1000, 1)), 'CREDIT_EXCEEDS');
    const orig = getInvoice(env.ctx, sale.invoice.id);
    assert.equal(orig.creditNotes.length, 3);
    // all tax components also add up exactly
    const sum = (k: 'taxable' | 'cgst' | 'sgst') => [c1, c2, c3].reduce((s, c) => s + c.lines[0]![k], 0);
    assert.deepEqual([sum('taxable'), sum('cgst'), sum('sgst')], [sale.lines[0]!.taxable, sale.lines[0]!.cgst, sale.lines[0]!.sgst]);
    assert.equal(code(() => cancelInvoice(env.ctx, env.manager, rid(), { invoiceId: sale.invoice.id, reason: 'x' })), 'HAS_CREDIT_NOTES');
  } finally { env.cleanup(); }
});

test('full return of a rounded bill refunds exactly what was paid (round-off included)', () => {
  const env = makeEnv(); try {
    startShift(env);
    const sale = quickBill(env, [['Cola 300ml', 1000], ['Brownie', 1000]]); // 4000 + 8900 = 12900
    // make a bill whose lines don't sum to a whole rupee: use a loose-qty item
    const odd = quickBill(env, [['Peri Peri Fries', 250]]); // 9900 * 0.25 = 2475 -> rounds to 2500, round-off +25
    assert.equal(odd.invoice.roundOff, 25);
    const r = createCreditNote(env.ctx, env.manager, rid(), { invoiceId: odd.invoice.id, lines: [{ invoiceLineId: odd.lines[0]!.id, qtyMilli: 250 }], reason: 'return', refunds: [{ mode: 'CASH', amount: 2500 }] });
    assert.equal(r.invoice.grandTotal, odd.invoice.grandTotal);
    assert.equal(r.invoice.roundOff, 25);
    assert.ok(sale.invoice.grandTotal > 0);
  } finally { env.cleanup(); }
});

test('Z-report: cash, UPI, cancellations, refunds, expected cash and difference', () => {
  const env = makeEnv(); try {
    const sh = startShift(env, 50000);
    const a = quickBill(env, [['Cheese Burger']], 'CASH');   // 12900 cash
    quickBill(env, [['Chicken Burger']], 'UPI');             // 14900 upi
    const c = quickBill(env, [['Brownie']], 'CASH');          // 8900 cash, cancelled below
    cancelInvoice(env.ctx, env.manager, rid(), { invoiceId: c.invoice.id, reason: 'mistake' });
    createCreditNote(env.ctx, env.manager, rid(), { invoiceId: a.invoice.id, lines: [{ invoiceLineId: a.lines[0]!.id, qtyMilli: 1000 }], reason: 'cold', refunds: [{ mode: 'CASH', amount: 12900 }] });
    const z = zReport(env.ctx, sh.id);
    assert.equal(z.invoices, 2);
    assert.equal(z.cancelled, 1);
    assert.equal(z.creditNotes, 1);
    assert.deepEqual(z.byMode, { CASH: 0, UPI: 14900 }); // 12900 cash in, 12900 refunded
    assert.equal(z.cash.expected, 50000);
    const closed = closeShift(env.ctx, env.cashier, rid(), { countedCash: 49500 });
    assert.equal(closed.cash.difference, -500);
    assert.equal(all(env.ctx.db, "SELECT 1 FROM print_job WHERE kind='REPORT'").length, 1);
    assert.equal(code(() => closeShift(env.ctx, env.cashier, rid(), { countedCash: 0 })), 'NO_OPEN_SHIFT');
    // the incremental daily summary equals a full recompute from the invoices
    const before = all(env.ctx.db, 'SELECT * FROM daily_summary ORDER BY day');
    recomputeDailySummary(env.ctx);
    assert.deepEqual(all(env.ctx.db, 'SELECT * FROM daily_summary ORDER BY day'), before);
  } finally { env.cleanup(); }
});

test('shift close with unfinished bills: refused, manager may discard', () => {
  const env = makeEnv(); try {
    startShift(env);
    cartOf(env, [['Masala Chai']]);
    assert.equal(code(() => closeShift(env.ctx, env.cashier, rid(), { countedCash: 50000 })), 'OPEN_ORDERS_EXIST');
    assert.equal(code(() => closeShift(env.ctx, env.cashier, rid(), { countedCash: 50000, discardOpenOrders: true })), 'FORBIDDEN');
    closeShift(env.ctx, env.manager, rid(), { countedCash: 50000, discardOpenOrders: true });
    assert.equal(listOpenOrders(env.ctx).length, 0);
  } finally { env.cleanup(); }
});

test('tokens increment per day per counter and restart each day', () => {
  const env = makeEnv(); try {
    const t = () => createOrder(env.ctx, env.cashier, rid()).order.tokenNo;
    assert.deepEqual([t(), t(), t()], [1, 2, 3]);
    env.clock.advance(24 * 3600_000);
    assert.equal(t(), 1);
  } finally { env.cleanup(); }
});

test('hold/resume and open bills survive a restart (the server is the source of truth)', () => {
  const env = makeEnv(); try {
    const cart = cartOf(env, [['Cheese Burger', 2000]]);
    holdOrder(env.ctx, env.cashier, rid(), cart.order.id);
    assert.equal(code(() => addLine(env.ctx, env.cashier, rid(), { orderId: cart.order.id, itemId: env.items['Brownie']! })), 'NO_ERROR'); // held bills can still be edited
    env.ctx.db.close();
    const again = createCtx({ dataDir: env.dir, clock: env.clock, logger: silentLogger, scryptCost: 1024 });
    const open = listOpenOrders(again);
    assert.equal(open.length, 1);
    assert.equal((open[0] as { lineCount: number }).lineCount, 2);
    assert.equal(resumeOrder(again, env.cashier, rid(), cart.order.id).order.status, 'DRAFT');
    again.db.close();
  } finally { env.cleanup(); }
});

test('modifiers: priced server-side, rules enforced, identical lines merge', () => {
  const env = makeEnv(); try {
    const cart = createOrder(env.ctx, env.cashier, rid());
    const add = (mods: string[], qty = 1000) => addLine(env.ctx, env.cashier, rid(), { orderId: cart.order.id, itemId: env.items['Cheese Burger']!, qtyMilli: qty, modifierIds: mods.map((m) => env.mods[m]!) });
    const one = add(['Extra cheese']);
    assert.equal(one.lines[0]!.unitPrice, 12900 + 2000);
    assert.equal(add(['Extra cheese'], 2000).lines.length, 1); // merged
    assert.equal(add(['Extra cheese'], 1000).lines[0]!.qtyMilli, 4000);
    assert.equal(add(['Extra patty', 'Jalapenos']).lines.length, 2);
    assert.equal(code(() => add(['Extra cheese', 'Extra patty', 'Jalapenos'])), 'NO_ERROR'); // exactly the max of 3
    assert.equal(code(() => addLine(env.ctx, env.cashier, rid(), { orderId: cart.order.id, itemId: env.items['Brownie']!, modifierIds: [env.mods['Extra cheese']!] })), 'VALIDATION'); // not offered for this item
    assert.equal(code(() => addLine(env.ctx, env.cashier, rid(), { orderId: cart.order.id, itemId: env.items['Cheese Burger']!, qtyMilli: 0 })), 'VALIDATION');
  } finally { env.cleanup(); }
});

test('menu edits never change past invoices (snapshots); deleted items stay in history', () => {
  const env = makeEnv(); try {
    startShift(env);
    const sale = quickBill(env, [['Brownie']]);
    updateItem(env.ctx, env.owner, rid(), env.items['Brownie']!, { price: 99999, name: 'Mega Brownie' });
    const inv = getInvoice(env.ctx, sale.invoice.id);
    assert.equal(inv.lines[0]!.name, 'Brownie');
    assert.equal(inv.lines[0]!.unitPrice, 8900);
    assert.equal(inv.invoice.grandTotal, 8900);
    assert.equal(code(() => createItem(env.ctx, env.cashier, rid(), { name: 'X', taxGroupId: 'x', price: 1 })), 'FORBIDDEN');
  } finally { env.cleanup(); }
});

test('GSTIN buyer on another state switches the bill to IGST', () => {
  const env = makeEnv(); try {
    startShift(env);
    const cart = cartOf(env, [['Cheese Burger']]);
    const c = updateOrder(env.ctx, env.cashier, rid(), { orderId: cart.order.id, buyerGstin: '27AAPFU0939F1ZV' });
    assert.equal(c.order.placeOfSupply, '27');
    assert.deepEqual([c.totals.cgst, c.totals.sgst, c.totals.igst > 0], [0, 0, true]);
    const r = finalizeInvoice(env.ctx, env.cashier, rid(), { orderId: cart.order.id, payments: [{ mode: 'UPI', amount: c.totals.grandTotal }] });
    assert.equal(r.invoice.buyerGstin, '27AAPFU0939F1ZV');
    assert.equal(r.invoice.igst, c.totals.igst);
  } finally { env.cleanup(); }
});
