import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, get, AppError } from '../src/store/db.ts';
import { billOnlineOrder, cancelOnlineBill, onlineMenu, shiftActor } from '../src/services/onlineBilling.ts';
import { makeEnv, rid, startShift } from './helpers.ts';

const code = (fn: () => unknown): string => { try { fn(); } catch (e) { if (e instanceof AppError) return e.code; throw e; } return 'NO_ERROR'; };
const itemId = (env: ReturnType<typeof makeEnv>, name: string) => get<{ id: string }>(env.ctx.db, 'SELECT id FROM item WHERE name = ?', name)!.id;
const fiveGroup = (env: ReturnType<typeof makeEnv>) => get<{ id: string }>(env.ctx.db, 'SELECT id FROM tax_group WHERE rate_bp = 500 AND deleted_at IS NULL LIMIT 1')!.id;

test('an online order becomes a normal GST bill: channel, external id, items, delivery and packaging fee lines, kitchen ticket', () => {
  const env = makeEnv(); try {
    assert.equal(shiftActor(env.ctx), null);
    assert.equal(code(() => billOnlineOrder(env.ctx, env.cashier, rid(), { channel: 'WEBSITE', externalId: 'W-1', lines: [{ itemId: itemId(env, 'Cheese Burger'), qtyMilli: 1000 }], fees: { delivery: 3000, packaging: 1000, taxGroupId: fiveGroup(env) }, paymentMode: 'CASH' })), 'NO_OPEN_SHIFT');
    startShift(env, 50000);
    assert.equal(shiftActor(env.ctx)!.userId, env.cashier.userId); // auto-accept bills as whoever opened the shift
    const r = billOnlineOrder(env.ctx, env.cashier, rid(), {
      channel: 'WEBSITE', externalId: 'W-1042', customerPhone: '9876543210', note: 'Ring the bell',
      lines: [{ itemId: itemId(env, 'Cheese Burger'), qtyMilli: 2000 }], fees: { delivery: 3000, packaging: 1000, taxGroupId: fiveGroup(env) }, paymentMode: 'CASH',
    });
    const order = get<{ channel: string; external_id: string; customer_phone: string; status: string }>(env.ctx.db, 'SELECT channel, external_id, customer_phone, status FROM sale_order WHERE id = (SELECT order_id FROM invoice WHERE id = ?)', r.invoiceId)!;
    assert.deepEqual({ ...order }, { channel: 'WEBSITE', external_id: 'W-1042', customer_phone: '9876543210', status: 'INVOICED' });
    const lines = all<{ name: string; line_total: number; rate_bp: number }>(env.ctx.db, 'SELECT name, line_total, rate_bp FROM invoice_line WHERE invoice_id = ? ORDER BY line_no', r.invoiceId);
    assert.deepEqual(lines.map((l) => l.name), ['Cheese Burger', 'Delivery charge', 'Packaging charge']);
    assert.deepEqual(lines.slice(1).map((l) => [l.line_total, l.rate_bp]), [[3000, 500], [1000, 500]]); // fees taxed at the chosen GST rate (inclusive)
    assert.equal(r.grandTotal, 25800 + 3000 + 1000);
    assert.ok(get(env.ctx.db, "SELECT 1 FROM print_job WHERE kind = 'KOT' AND ref_id = ?", r.invoiceId) || get(env.ctx.db, "SELECT 1 FROM print_job WHERE ref_id = ?", r.invoiceId));
    // the fee items never show on the menu
    assert.ok(!onlineMenu(env.ctx).items.some((i) => i.name.endsWith('charge')));
    assert.ok(!all<{ name: string }>(env.ctx.db, 'SELECT name FROM item WHERE active = 1').some((i) => i.name === 'Delivery charge'));
  } finally { env.cleanup(); }
});

test('billing an online order is safe to repeat (same request or same external id) and leaves nothing behind when it fails', () => {
  const env = makeEnv(); try {
    startShift(env, 50000);
    const input = { channel: 'APP' as const, externalId: 'A-7', lines: [{ itemId: itemId(env, 'Cheese Burger'), qtyMilli: 1000 }], fees: { delivery: 0, packaging: 0, taxGroupId: null }, paymentMode: 'UPI' as const };
    const key = rid();
    const a = billOnlineOrder(env.ctx, env.cashier, key, input);
    const b = billOnlineOrder(env.ctx, env.cashier, key, input);
    const c = billOnlineOrder(env.ctx, env.cashier, rid(), input); // e.g. the POS restarted and accepts the same hub order again
    assert.equal(a.invoiceId, b.invoiceId);
    assert.equal(a.invoiceId, c.invoiceId);
    assert.equal(get<{ n: number }>(env.ctx.db, "SELECT count(*) n FROM invoice WHERE doc_type = 'TAX_INVOICE'")!.n, 1);
    // an item that is not on the menu any more: refused, and no draft order is left open
    const bad = { ...input, externalId: 'A-8', lines: [{ itemId: 'no-such-item', qtyMilli: 1000 }] };
    assert.equal(code(() => billOnlineOrder(env.ctx, env.cashier, rid(), bad)), 'NOT_FOUND');
    assert.equal(get<{ n: number }>(env.ctx.db, "SELECT count(*) n FROM sale_order WHERE status IN ('DRAFT','HELD')")!.n, 0);
    assert.equal(code(() => billOnlineOrder(env.ctx, env.cashier, rid(), { ...input, externalId: 'A-9', channel: 'COUNTER' as never })), 'VALIDATION');
    // the store cancels after accepting: the bill is cancelled (same day), with the reason
    cancelOnlineBill(env.ctx, env.manager, rid(), { invoiceId: a.invoiceId, reason: 'Customer not reachable' });
    assert.equal(get<{ status: string }>(env.ctx.db, 'SELECT status FROM invoice WHERE id = ?', a.invoiceId)!.status, 'CANCELLED');
  } finally { env.cleanup(); }
});

test('the online menu lists what customers may order: prices, GST, veg, availability and options', () => {
  const env = makeEnv(); try {
    const m = onlineMenu(env.ctx);
    const burger = m.items.find((i) => i.name === 'Cheese Burger')!;
    assert.deepEqual([burger.price, burger.rateBp, burger.priceIncludesTax, typeof burger.isVeg], [12900, 500, true, 'boolean']);
    assert.ok(m.categories.length > 0 && m.roundToRupee === true);
    assert.ok(Array.isArray(m.modifierGroups));
    assert.ok(m.taxGroups.some((t) => t.rateBp === 500));
  } finally { env.cleanup(); }
});
