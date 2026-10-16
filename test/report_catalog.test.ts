import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/store/db.ts';
import { REPORTS, reportCsv, runReport } from '../src/services/reportCatalog.ts';
import type { ReportTable } from '../src/services/reportCatalog.ts';
import { applyBillDiscount } from '../src/services/orders.ts';
import { cancelInvoice, createCreditNote, finalizeInvoice, previewCreditNote } from '../src/services/invoices.ts';
import { closeShift } from '../src/services/shifts.ts';
import { adjustStock, createPurchase, createStockItem } from '../src/services/stock.ts';
import { cartOf, makeEnv, quickBill, rid, startShift } from './helpers.ts';

const code = (fn: () => unknown): string => { try { fn(); } catch (e) { if (e instanceof AppError) return e.code; throw e; } return 'NO_ERROR'; };
const DAY = { from: '2026-10-12', to: '2026-10-12' };

/** One realistic day: cash bill, discounted UPI bill 2 h later, a cancelled card bill, a partial refund, stock moves, shift closed. */
function setup() {
  const env = makeEnv();
  const shift = startShift(env, 50000);
  const b1 = quickBill(env, [['Cheese Burger', 2000]]); // 10:00 IST, cash, Rs 258
  env.clock.advance(2 * 3_600_000); // 12:00 IST
  const c2 = cartOf(env, [['Cola 300ml'], ['Brownie']]);
  const cart2 = applyBillDiscount(env.ctx, env.cashier, rid(), { orderId: c2.order.id, discount: { type: 'percent', value: 1000 } });
  const b2 = finalizeInvoice(env.ctx, env.cashier, rid(), { orderId: c2.order.id, payments: [{ mode: 'UPI', amount: cart2.totals.grandTotal }] });
  const b3 = quickBill(env, [['Masala Chai']], 'CARD');
  cancelInvoice(env.ctx, env.manager, rid(), { invoiceId: b3.invoice.id, reason: 'Wrong item' });
  const refund = previewCreditNote(env.ctx, b1.invoice.id, [{ invoiceLineId: b1.lines[0]!.id, qtyMilli: 1000 }]).total;
  const cn = createCreditNote(env.ctx, env.manager, rid(), { invoiceId: b1.invoice.id, lines: [{ invoiceLineId: b1.lines[0]!.id, qtyMilli: 1000 }], reason: 'Cold', refunds: [{ mode: 'CASH', amount: refund }] });
  // stock: opening 10 kg, buy 5 kg, waste 0.5 kg
  const oil = createStockItem(env.ctx, env.manager, rid(), { name: 'Oil', unit: 'l', openingQtyMilli: 10_000, openingUnitCost: 14_000, reorderLevelMilli: 20_000 });
  createPurchase(env.ctx, env.manager, rid(), { supplierName: 'Metro', billNo: 'M-1', lines: [{ stockItemId: oil.id, qtyMilli: 5_000, unitCost: 15_000 }] });
  adjustStock(env.ctx, env.manager, rid(), { stockItemId: oil.id, kind: 'WASTAGE', qtyMilli: 500, reason: 'Spill' });
  closeShift(env.ctx, env.cashier, rid(), { countedCash: 50000 + 25800 - refund });
  return { env, shift, b1, b2, b3, cn };
}

const col = (t: ReportTable, key: string) => t.rows.map((r) => r[key]);
const total = (t: ReportTable, key: string) => t.totals?.[key];

test('report catalog: every report has a title, a group and columns; unknown names and bad ranges are refused', () => {
  const s = setup(); try {
    const keys = REPORTS.map((r) => r.key);
    for (const k of ['sales-summary', 'payments', 'hourly', 'channels', 'staff', 'discounts', 'items', 'categories', 'gst-rates', 'hsn', 'bills', 'cancellations', 'shifts', 'stock', 'stock-movements', 'purchases']) assert.ok(keys.includes(k), k);
    for (const r of REPORTS) {
      const t = runReport(s.env.ctx, s.env.manager, r.key, DAY);
      assert.ok(t.title && t.columns.length > 0, r.key);
      for (const row of t.rows) for (const c of t.columns) assert.ok(c.key in row, `${r.key}.${c.key}`);
    }
    assert.equal(code(() => runReport(s.env.ctx, s.env.cashier, 'sales-summary', DAY)), 'FORBIDDEN');
    assert.equal(code(() => runReport(s.env.ctx, s.env.manager, 'nope', DAY)), 'NOT_FOUND');
    assert.equal(code(() => runReport(s.env.ctx, s.env.manager, 'sales-summary', { from: '2026-10-13', to: '2026-10-12' })), 'VALIDATION');
    assert.equal(code(() => runReport(s.env.ctx, s.env.manager, 'sales-summary', { from: '12/10/2026', to: '2026-10-12' })), 'VALIDATION');
    assert.equal(code(() => runReport(s.env.ctx, s.env.manager, 'sales-summary', { from: '2020-01-01', to: '2026-10-12' })), 'VALIDATION'); // over 3 years
  } finally { s.env.cleanup(); }
});

test('sales reports agree with each other: summary, payment modes, hourly, channels and staff', () => {
  const s = setup(); try {
    const { env, b1, b2, cn } = s;
    const sum = runReport(env.ctx, env.manager, 'sales-summary', DAY);
    assert.deepEqual(col(sum, 'day'), ['2026-10-12']);
    const r = sum.rows[0]!;
    assert.deepEqual([r.bills, r.cancelled, r.refunds], [2, 1, 1]);
    assert.equal(r.netSales, b1.invoice.grandTotal + b2.invoice.grandTotal);
    assert.equal(r.refundAmount, cn.invoice.grandTotal);
    assert.equal(r.netAfterRefunds, b1.invoice.grandTotal + b2.invoice.grandTotal - cn.invoice.grandTotal);
    assert.equal(r.discounts, b2.invoice.discountTotal);
    assert.equal(total(sum, 'netAfterRefunds'), r.netAfterRefunds);
    assert.ok(sum.summary.some((x) => x.label === 'Net sales after refunds' && x.value === r.netAfterRefunds));

    const pay = runReport(env.ctx, env.manager, 'payments', DAY);
    const byMode = Object.fromEntries(pay.rows.map((x) => [x.mode, x]));
    assert.equal(byMode.Cash!.net, b1.invoice.grandTotal - cn.invoice.grandTotal);
    assert.equal(byMode.UPI!.net, b2.invoice.grandTotal);
    assert.equal(byMode.Card, undefined); // the card bill was cancelled
    assert.equal(total(pay, 'net'), r.netAfterRefunds); // money received = net sales after refunds

    const hourly = runReport(env.ctx, env.manager, 'hourly', DAY);
    assert.deepEqual(col(hourly, 'hour'), ['10:00 - 10:59', '12:00 - 12:59']);
    assert.equal(total(hourly, 'netSales'), r.netSales);

    assert.deepEqual(col(runReport(env.ctx, env.manager, 'channels', DAY), 'channel'), ['Counter']);
    const staff = runReport(env.ctx, env.manager, 'staff', DAY);
    assert.deepEqual(staff.rows.map((x) => [x.cashier, x.bills, x.cancelled]), [['Cashier', 2, 1]]);

    const disc = runReport(env.ctx, env.manager, 'discounts', DAY);
    assert.deepEqual(col(disc, 'invoiceNo'), [b2.invoice.invoiceNo]);
    assert.equal(disc.rows[0]!.discountPct, '10%');
  } finally { s.env.cleanup(); }
});

test('item, category and tax reports: net of refunds, GST matches, HSN summary', () => {
  const s = setup(); try {
    const { env } = s;
    const items = runReport(env.ctx, env.manager, 'items', DAY);
    const burger = items.rows.find((x) => x.item === 'Cheese Burger')!;
    assert.deepEqual([burger.soldQty, burger.returnedQty, burger.netQty, burger.category], ['2', '1', '1', 'Burgers']);
    assert.ok(!items.rows.some((x) => x.item === 'Masala Chai')); // cancelled bill
    // item totals + the bills' round-off = net sales after refunds (round-off is not part of any item)
    const roundOff = Number(items.summary.find((x) => x.label.startsWith('Round off'))?.value ?? 0);
    assert.equal(Number(total(items, 'netSales')) + roundOff, runReport(env.ctx, env.manager, 'sales-summary', DAY).totals!.netAfterRefunds);
    const cats = runReport(env.ctx, env.manager, 'categories', DAY);
    assert.deepEqual(col(cats, 'category').sort(), ['Beverages', 'Burgers', 'Desserts']);

    const gst = runReport(env.ctx, env.manager, 'gst-rates', DAY);
    assert.deepEqual(col(gst, 'rate'), ['5%', '12%', '18%']);
    const tax = Number(total(gst, 'totalTax'));
    const sumTax = runReport(env.ctx, env.manager, 'sales-summary', DAY).totals!;
    assert.equal(tax, Number(sumTax.tax));
    const hsn = runReport(env.ctx, env.manager, 'hsn', DAY);
    assert.equal(Number(total(hsn, 'taxable')), Number(total(gst, 'taxable')));

    const bills = runReport(env.ctx, env.manager, 'bills', DAY);
    assert.equal(bills.rows.length, 4); // two bills, one cancelled bill, one credit note
    assert.ok(bills.rows.some((x) => x.status === 'Cancelled') && bills.rows.some((x) => x.type === 'Credit note'));
    const canc = runReport(env.ctx, env.manager, 'cancellations', DAY);
    assert.deepEqual(canc.rows.map((x) => x.type).sort(), ['Cancelled bill', 'Refund (credit note)']);
    assert.ok(canc.rows.some((x) => x.reason === 'Wrong item' && x.by === 'Manager'));
  } finally { s.env.cleanup(); }
});

test('cash and inventory reports: shift cash, stock on hand, stock movement and purchases', () => {
  const s = setup(); try {
    const { env } = s;
    const shifts = runReport(env.ctx, env.manager, 'shifts', DAY);
    assert.equal(shifts.rows.length, 1);
    assert.deepEqual([shifts.rows[0]!.openingCash, shifts.rows[0]!.difference, shifts.rows[0]!.status], [50000, 0, 'Closed']);
    const stock = runReport(env.ctx, env.manager, 'stock', DAY);
    const oil = stock.rows.find((x) => x.material === 'Oil')!;
    assert.deepEqual([oil.inStock, oil.status], ['14.5 L', 'Low']);
    assert.equal(oil.value, 14_500 * 15_000 / 1000);
    const mv = runReport(env.ctx, env.manager, 'stock-movements', DAY).rows.find((x) => x.material === 'Oil')!;
    assert.deepEqual([mv.opening, mv.purchased, mv.wasted, mv.closing], ['0 L', '5 L', '0.5 L', '14.5 L']); // the opening stock entry falls inside the day, under "adjusted"
    assert.equal(mv.adjusted, '10 L');
    const pur = runReport(env.ctx, env.manager, 'purchases', DAY);
    assert.deepEqual([pur.rows[0]!.supplier, pur.rows[0]!.amount, total(pur, 'amount')], ['Metro', 75_000, 75_000]);
  } finally { s.env.cleanup(); }
});

test('CSV download: Excel-friendly, amounts as plain numbers (negatives too), text protected from formula injection', () => {
  const s = setup(); try {
    const { env } = s;
    const { filename, csv } = reportCsv(env.ctx, env.manager, 'payments', DAY);
    assert.equal(filename, 'payments_2026-10-12_to_2026-10-12.csv');
    assert.ok(csv.startsWith('﻿'), 'byte-order mark so Excel reads UTF-8');
    const lines = csv.slice(1).trim().split('\r\n');
    assert.equal(lines[0], 'Payment mode,Payments,Received,Refunded,Net');
    assert.ok(lines.at(-1)!.startsWith('TOTAL,'));
    assert.ok(lines.some((l) => /^Cash,\d+,\d+\.\d\d,-?\d+\.\d\d,\d+\.\d\d$/.test(l)), lines.join(' | '));
    const sum = reportCsv(env.ctx, env.manager, 'cancellations', DAY).csv;
    assert.ok(!/,'-/.test(sum), 'negative numbers are not turned into text');
    assert.equal(code(() => reportCsv(env.ctx, env.cashier, 'payments', DAY)), 'FORBIDDEN');
  } finally { s.env.cleanup(); }
});
