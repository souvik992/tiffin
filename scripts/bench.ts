// Measurements for the performance targets. Usage: node scripts/bench.ts [historicalInvoices]
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createCtx, silentLogger } from '../src/services/ctx.ts';
import { seedDemo } from '../src/seed.ts';
import { all, get } from '../src/store/db.ts';
import { actorsFor } from '../test/helpers.ts';
import { searchItems } from '../src/services/catalog.ts';
import { addLine, createOrder, getCart, updateLine } from '../src/services/orders.ts';
import { finalizeInvoice, listInvoices } from '../src/services/invoices.ts';
import { openShift, zReport } from '../src/services/shifts.ts';
import { dailySummary } from '../src/services/reports.ts';
import { runBackup } from '../src/services/backup.ts';
import { formatDocNo } from '../src/core/numbering.ts';

const HIST = Number(process.argv[2] ?? 100_000);
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!; };
const row = (label: string, xs: number[], target?: string) => console.log(`${label.padEnd(46)} p50 ${pct(xs, 50).toFixed(2).padStart(8)} ms   p95 ${pct(xs, 95).toFixed(2).padStart(8)} ms   max ${Math.max(...xs).toFixed(2).padStart(8)} ms   ${target ?? ''}`);
const time = <T>(fn: () => T): [T, number] => { const t = performance.now(); const r = fn(); return [r, performance.now() - t]; };

const dir = mkdtempSync(join(tmpdir(), 'pos-bench-'));
const ctx = createCtx({ dataDir: dir, logger: silentLogger, scryptCost: 1024 });
seedDemo(ctx);
const { cashier } = actorsFor(ctx);
let n = 0; const rid = () => `bench-${++n}-${Math.random().toString(36).slice(2, 8)}`;
openShift(ctx, cashier, rid(), { openingCash: 0 });

// ---- 20,000 items
{
  const tg = get<{ id: string }>(ctx.db, 'SELECT id FROM tax_group WHERE rate_bp = 500')!.id;
  const cat = get<{ id: string }>(ctx.db, 'SELECT id FROM category LIMIT 1')!.id;
  const words = ['Spicy', 'Paneer', 'Chicken', 'Veg', 'Cheese', 'Masala', 'Butter', 'Crispy', 'Garlic', 'Smoky', 'Tandoori', 'Classic'];
  const ins = ctx.db.prepare('INSERT INTO item(id, category_id, name, tax_group_id, price, unit, updated_at) VALUES (?,?,?,?,?,?,?)');
  const [, ms] = time(() => { ctx.db.exec('BEGIN'); for (let i = 0; i < 20_000; i++) ins.run(`bench-item-${i}`, cat, `${words[i % 12]} ${words[(i * 7) % 12]} Item ${i}`, tg, 5000 + (i % 400) * 25, 'pcs', 1); ctx.db.exec('COMMIT'); });
  console.log(`inserted 20,000 items in ${ms.toFixed(0)} ms`);
}
const queries = ['spicy', 'chick', 'paneer but', 'item 1999', 'tand cris', 'gar', 'xyz', 'veg mas', 'cla'];
const st: number[] = [];
for (let i = 0; i < 300; i++) st.push(time(() => searchItems(ctx, queries[i % queries.length]!))[1]);
row('item search, 20,000 items', st, 'target p95 < 50 ms');

// ---- 1,000-line cart
const order = createOrder(ctx, cashier, rid()).order.id;
const addAt: Record<number, number[]> = {};
const cmdBytes0 = get<{ b: number }>(ctx.db, 'SELECT sum(length(result_json)) b FROM command_log')!.b;
for (let i = 0; i < 1000; i++) {
  const [, ms] = time(() => addLine(ctx, cashier, rid(), { orderId: order, itemId: `bench-item-${i}` }));
  const bucket = i < 50 ? 50 : i < 250 ? 250 : i < 500 ? 500 : i < 750 ? 750 : 1000;
  (addAt[bucket] ??= []).push(ms);
}
for (const b of [50, 250, 500, 750, 1000]) row(`addLine while cart has up to ${b} lines`, addAt[b]!, b === 1000 ? 'target p95 < 50 ms' : '');
const cmdBytes1 = get<{ b: number }>(ctx.db, 'SELECT sum(length(result_json)) b FROM command_log')!.b;
console.log(`command_log growth for 1,000 cart edits: ${((cmdBytes1 - cmdBytes0) / 1024).toFixed(1)} KB`);
const lines = getCart(ctx, order).lines;
const upd: number[] = []; for (let i = 0; i < 40; i++) upd.push(time(() => updateLine(ctx, cashier, rid(), { lineId: lines[(i * 23) % 1000]!.id, qtyMilli: 2000 + i }))[1]);
row('updateLine on a 1,000-line cart', upd);
const gc: number[] = []; for (let i = 0; i < 30; i++) gc.push(time(() => getCart(ctx, order))[1]);
row('getCart (1,000 lines)', gc);
const cart = getCart(ctx, order);
const fin = time(() => finalizeInvoice(ctx, cashier, rid(), { orderId: order, payments: [{ mode: 'UPI', amount: cart.totals.grandTotal }] }))[1];
console.log(`finalize 1,000-line bill (₹${(cart.totals.grandTotal / 100).toLocaleString('en-IN')}): ${fin.toFixed(1)} ms   target < 150 ms for typical bills`);

// ---- typical bill with a large history
{
  const dev = get<{ id: string }>(ctx.db, 'SELECT id FROM device')!.id;
  const user = cashier.userId;
  const series = get<{ id: string }>(ctx.db, "SELECT id FROM invoice_series WHERE doc_type='TAX_INVOICE'")!.id;
  const so = ctx.db.prepare("INSERT INTO sale_order(id, device_id, channel, status, created_at, updated_at) VALUES (?,?,'COUNTER','INVOICED',?,?)");
  const iv = ctx.db.prepare(`INSERT INTO invoice(id, order_id, device_id, doc_type, series_id, seq_no, invoice_no, issued_at, place_of_supply, gross_total, discount_total, taxable_total, cgst, sgst, igst, cess, round_off, grand_total, status, created_by)
      VALUES (?,?,?,'TAX_INVOICE',?,?,?,?,'29',?,0,?,?,?,0,0,0,?,'ISSUED',?)`);
  const il = ctx.db.prepare(`INSERT INTO invoice_line(id, invoice_id, line_no, item_id, name, qty_milli, unit, unit_price, gross, discount, taxable, rate_bp, cgst, sgst, igst, cess, line_total) VALUES (?,?,?,?,?,?, 'pcs',?,?,0,?,500,?,?,0,0,?)`);
  const pm = ctx.db.prepare("INSERT INTO payment(id, invoice_id, mode, amount, created_at) VALUES (?,?,?,?,?)");
  const sm = ctx.db.prepare("INSERT INTO daily_summary(day, device_id, invoices, sales_total, tax_total, cash) VALUES (?,?,?,?,?,?) ON CONFLICT(day, device_id) DO UPDATE SET invoices = invoices + 1, sales_total = sales_total + excluded.sales_total, tax_total = tax_total + excluded.tax_total, cash = cash + excluded.cash");
  const base = Date.UTC(2026, 9, 12, 4, 30) - 5 * 365 * 86_400_000, span = 5 * 365 * 86_400_000 - 86_400_000;
  const start = get<{ n: number }>(ctx.db, 'SELECT next_no n FROM invoice_series WHERE id = ?', series)!.n;
  const [, ms] = time(() => {
    ctx.db.exec('BEGIN');
    for (let i = 0; i < HIST; i++) {
      const seq = start + i, id = `h-inv-${i}`, at = base + Math.floor((i / HIST) * span);
      const day = new Date(at + 19_800_000).toISOString().slice(0, 10);
      so.run(`h-ord-${i}`, dev, at, at);
      iv.run(id, `h-ord-${i}`, dev, series, seq, `H/${seq}`, at, 25000, 23810, 595, 595, 25000, user);
      il.run(`h-l1-${i}`, id, 1, 'bench-item-1', 'Item', 1000, 12500, 12500, 11905, 298, 297, 12500);
      il.run(`h-l2-${i}`, id, 2, 'bench-item-2', 'Item', 1000, 12500, 12500, 11905, 297, 298, 12500);
      pm.run(`h-pay-${i}`, id, i % 3 === 0 ? 'UPI' : 'CASH', 25000, at);
      sm.run(day, dev, 1, 25000, 1190, 25000);
    }
    ctx.db.exec('COMMIT');
  });
  ctx.db.exec(`UPDATE invoice_series SET next_no = ${start + HIST} WHERE id = '${series}'`);
  console.log(`inserted ${HIST.toLocaleString('en-IN')} historical invoices (2 lines, 1 payment each) in ${(ms / 1000).toFixed(1)} s`);
}
const dbMb = () => (statSync(ctx.dbPath).size + (() => { try { return statSync(ctx.dbPath + '-wal').size; } catch { return 0; } })()) / 1_048_576;
console.log(`database size now: ${dbMb().toFixed(0)} MB`);
const typical: number[] = [];
for (let i = 0; i < 60; i++) {
  const o = createOrder(ctx, cashier, rid()).order.id;
  addLine(ctx, cashier, rid(), { orderId: o, itemId: `bench-item-${i}` });
  const c = addLine(ctx, cashier, rid(), { orderId: o, itemId: `bench-item-${i + 100}`, qtyMilli: 2000 });
  typical.push(time(() => finalizeInvoice(ctx, cashier, rid(), { orderId: o, payments: [{ mode: 'CASH', amount: c.totals.grandTotal }] }))[1]);
}
row(`finalize a typical bill, DB holds ${HIST.toLocaleString('en-IN')} invoices`, typical, 'target p95 < 150 ms');
const lp: number[] = []; for (let i = 0; i < 40; i++) lp.push(time(() => listInvoices(ctx, { limit: 50, offset: (i % 5) * 50 }))[1]);
row('history screen (50 newest invoices)', lp, 'target < 1000 ms');
const ds = time(() => dailySummary(ctx, '2021-10-01', '2026-10-12'));
console.log(`daily summary for the whole history (${ds[0].length} days): ${ds[1].toFixed(1)} ms`);
const sh = get<{ id: string }>(ctx.db, 'SELECT id FROM shift LIMIT 1')!.id;
console.log(`Z-report for today's shift: ${time(() => zReport(ctx, sh))[1].toFixed(1)} ms`);
const bt = performance.now();
const b = await runBackup(ctx, 'manual');
console.log(`online backup + verify: ${(performance.now() - bt).toFixed(0)} ms, ${(b.bytes / 1_048_576).toFixed(0)} MB`);
console.log(`bytes per historical invoice (db size / invoices): ${(statSync(ctx.dbPath).size / (HIST + 61) / 1024).toFixed(2)} KB`);
console.log('invoices total:', get<{ n: number }>(ctx.db, 'SELECT count(*) n FROM invoice')!.n);
ctx.db.close();
rmSync(dir, { recursive: true, force: true });
