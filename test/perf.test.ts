// Performance gates. Targets come from the design spec; thresholds here equal the targets so a regression fails the build.
// Numbers are measured on whatever machine runs the tests: re-measure on the low-end Windows baseline PC before release.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { get } from '../src/store/db.ts';
import { searchItems } from '../src/services/catalog.ts';
import { addLine, createOrder, getCart } from '../src/services/orders.ts';
import { finalizeInvoice } from '../src/services/invoices.ts';
import { checkInvariants, computeInvoice } from '../src/core/tax.ts';
import { makeEnv, rid, startShift } from './helpers.ts';

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!;
const time = <T>(fn: () => T): [T, number] => { const t = performance.now(); const r = fn(); return [r, performance.now() - t]; };

test('perf: search over 20,000 items, p95 < 50 ms', () => {
  const env = makeEnv(); try {
    const tg = get<{ id: string }>(env.ctx.db, 'SELECT id FROM tax_group WHERE rate_bp = 500')!.id;
    const cat = get<{ id: string }>(env.ctx.db, 'SELECT id FROM category LIMIT 1')!.id;
    const ins = env.ctx.db.prepare('INSERT INTO item(id, category_id, name, tax_group_id, price, unit, updated_at) VALUES (?,?,?,?,?,?,?)');
    const words = ['Spicy', 'Paneer', 'Chicken', 'Veg', 'Cheese', 'Masala', 'Butter', 'Crispy'];
    env.ctx.db.exec('BEGIN');
    for (let i = 0; i < 20_000; i++) ins.run(`p-item-${i}`, cat, `${words[i % 8]} ${words[(i * 3) % 8]} Item ${i}`, tg, 5000, 'pcs', 1);
    env.ctx.db.exec('COMMIT');
    const qs = ['spicy', 'chick', 'paneer but', 'item 1999', 'cri', 'xyz'];
    const ts: number[] = [];
    for (let i = 0; i < 120; i++) ts.push(time(() => searchItems(env.ctx, qs[i % qs.length]!))[1]);
    console.log(`  search p50 ${pct(ts, 50).toFixed(2)} ms, p95 ${pct(ts, 95).toFixed(2)} ms`);
    assert.ok(pct(ts, 95) < 50, `p95 ${pct(ts, 95)}`);
  } finally { env.cleanup(); }
});

test('perf: 1,000-line cart: add p95 < 50 ms, finalize completes under 500 ms, totals stay consistent', () => {
  const env = makeEnv(); try {
    startShift(env);
    const tg = get<{ id: string }>(env.ctx.db, 'SELECT id FROM tax_group WHERE rate_bp = 1800')!.id;
    const cat = get<{ id: string }>(env.ctx.db, 'SELECT id FROM category LIMIT 1')!.id;
    const ins = env.ctx.db.prepare('INSERT INTO item(id, category_id, name, tax_group_id, price, unit, updated_at) VALUES (?,?,?,?,?,?,?)');
    env.ctx.db.exec('BEGIN');
    for (let i = 0; i < 1000; i++) ins.run(`big-${i}`, cat, `Bulk Item ${i}`, tg, 99_999_00 + i, 'pcs', 1); // about Rs 1 lakh each
    env.ctx.db.exec('COMMIT');
    const order = createOrder(env.ctx, env.cashier, rid()).order.id;
    const adds: number[] = [];
    for (let i = 0; i < 1000; i++) adds.push(time(() => addLine(env.ctx, env.cashier, rid(), { orderId: order, itemId: `big-${i}`, qtyMilli: 1000 + (i % 7) * 250 }))[1]);
    const late = adds.slice(900);
    console.log(`  addLine p95 overall ${pct(adds, 95).toFixed(1)} ms, at 900-1000 lines ${pct(late, 95).toFixed(1)} ms`);
    assert.ok(pct(adds, 95) < 50, `add p95 ${pct(adds, 95)}`);
    const cart = getCart(env.ctx, order);
    assert.equal(cart.lines.length, 1000);
    assert.ok(cart.totals.grandTotal > 10_000_000_000, 'a bill above Rs 10 crore is handled without overflow');
    const [r, ms] = time(() => finalizeInvoice(env.ctx, env.cashier, rid(), { orderId: order, payments: [{ mode: 'UPI', amount: cart.totals.grandTotal }] }));
    console.log(`  finalize of a 1,000-line, Rs ${(cart.totals.grandTotal / 100).toLocaleString('en-IN')} bill: ${ms.toFixed(0)} ms`);
    assert.ok(ms < 500, `finalize ${ms}`);
    assert.equal(r.lines.length, 1000);
    const recomputed = computeInvoice(cart.lines.map((l) => ({ id: l.id, qtyMilli: l.qtyMilli, unitPrice: l.unitPrice, rateBp: 1800, cessBp: 0, priceIncludesTax: true })), { intraState: true, roundToRupee: true });
    assert.deepEqual(checkInvariants(recomputed), []);
    assert.equal(recomputed.grandTotal, r.invoice.grandTotal);
  } finally { env.cleanup(); }
});

test('perf: a typical bill finalizes with p95 < 150 ms even with 30,000 invoices of history', () => {
  const env = makeEnv(); try {
    startShift(env);
    const dev = get<{ id: string }>(env.ctx.db, 'SELECT id FROM device')!.id;
    const sid = 'series-hist';
    env.ctx.db.exec('BEGIN');
    env.ctx.db.exec(`INSERT INTO invoice_series(id, device_id, doc_type, fy, prefix, next_no) VALUES ('${sid}', '${dev}', 'TAX_INVOICE', '26-27', 'A1', 30001)`);
    const so = env.ctx.db.prepare("INSERT INTO sale_order(id, device_id, channel, status, created_at, updated_at) VALUES (?,?,'COUNTER','INVOICED',1,1)");
    const iv = env.ctx.db.prepare(`INSERT INTO invoice(id, order_id, device_id, doc_type, series_id, seq_no, invoice_no, issued_at, place_of_supply, gross_total, discount_total, taxable_total, cgst, sgst, igst, cess, round_off, grand_total, status, created_by)
        VALUES (?,?,?,'TAX_INVOICE',?,?,?,?,'29',100,0,100,0,0,0,0,0,100,'ISSUED',?)`);
    for (let i = 0; i < 30_000; i++) { so.run(`ho-${i}`, dev); iv.run(`hi-${i}`, `ho-${i}`, dev, sid, i + 1, `A1/26-27/${String(i + 1).padStart(6, '0')}`, 1_700_000_000_000 + i, env.cashier.userId); }
    env.ctx.db.exec('COMMIT');
    const ts: number[] = [];
    for (let i = 0; i < 60; i++) {
      const o = createOrder(env.ctx, env.cashier, rid()).order.id;
      addLine(env.ctx, env.cashier, rid(), { orderId: o, itemId: env.items['Cheese Burger']! });
      const c = addLine(env.ctx, env.cashier, rid(), { orderId: o, itemId: env.items['Cola 300ml']!, qtyMilli: 2000 });
      ts.push(time(() => finalizeInvoice(env.ctx, env.cashier, rid(), { orderId: o, payments: [{ mode: 'CASH', amount: c.totals.grandTotal }] }))[1]);
    }
    console.log(`  typical finalize p50 ${pct(ts, 50).toFixed(1)} ms, p95 ${pct(ts, 95).toFixed(1)} ms`);
    assert.ok(pct(ts, 95) < 150, `p95 ${pct(ts, 95)}`);
    assert.equal(get<{ n: number }>(env.ctx.db, "SELECT next_no n FROM invoice_series WHERE id = 'series-hist'")!.n, 30061);
  } finally { env.cleanup(); }
});
