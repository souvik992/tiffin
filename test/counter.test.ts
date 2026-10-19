import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, get, AppError } from '../src/store/db.ts';
import { createCtx, silentLogger } from '../src/services/ctx.ts';
import { getCatalog, updateModifierGroup, deleteModifierGroup } from '../src/services/catalog.ts';
import { addLine, createOrder, updateOrder } from '../src/services/orders.ts';
import { cancelInvoice, finalizeInvoice } from '../src/services/invoices.ts';
import { correctPaymentMode, openDrawer, printXReport, setItemAvailability, xReport } from '../src/services/counter.ts';
import { reprintKot, receiptPreview } from '../src/services/printing/jobs.ts';
import { requireApproval, authenticate, login, logout, deactivateUser } from '../src/services/auth.ts';
import { closeShift, zReport } from '../src/services/shifts.ts';
import { recomputeDailySummary } from '../src/services/reports.ts';
import { onlineMenu } from '../src/services/onlineBilling.ts';
import { runBackup, restoreBackup } from '../src/services/backup.ts';
import { replayJournal } from '../src/services/journal.ts';
import { parseEscPos } from '../src/services/printing/virtual.ts';
import { cartOf, makeEnv, quickBill, rid, startShift } from './helpers.ts';
import type { Env } from './helpers.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const code = (fn: () => unknown): string => { try { fn(); } catch (e) { if (e instanceof AppError) return e.code; throw e; } return 'NO_ERROR'; };
const PINS = { owner: '1234', manager: '2345', cashier: '1111' };
const summary = (env: Env) => all<Record<string, number | string>>(env.ctx.db, 'SELECT day, device_id, invoices, cancelled, sales_total, cash, upi, card, other FROM daily_summary ORDER BY day, device_id');

test('add-on groups: options are changed, added and switched off; old bills keep their own copy; delete detaches from items', () => {
  const env = makeEnv(); try {
    startShift(env);
    const g = getCatalog(env.ctx).modifierGroups[0]!;
    const [first, second] = g.modifiers;
    const before = quickBill(env, [['Cheese Burger']]); // plain
    const cart = createOrder(env.ctx, env.cashier, rid());
    addLine(env.ctx, env.cashier, rid(), { orderId: cart.order.id, itemId: env.items['Cheese Burger']!, modifierIds: [first!.id] });

    updateModifierGroup(env.ctx, env.manager, rid(), g.id, { name: 'Extras', minSelect: 0, maxSelect: 2, modifiers: [{ id: first!.id, name: 'Extra cheese slice', price: 2500 }, { name: 'Jalapenos', price: 1500 }] });
    const now = getCatalog(env.ctx).modifierGroups.find((x) => x.id === g.id)!;
    assert.deepEqual(now.modifiers.map((m) => [m.name, m.price]), [['Extra cheese slice', 2500], ['Jalapenos', 1500]]);
    assert.equal(now.maxSelect, 2);
    assert.equal(get<{ active: number }>(env.ctx.db, 'SELECT active FROM modifier WHERE id = ?', second!.id)!.active, 0, 'switched off, not deleted');
    const open = get<{ modifiers_json: string }>(env.ctx.db, 'SELECT modifiers_json FROM sale_order_line WHERE order_id = ?', cart.order.id)!;
    assert.equal(JSON.parse(open.modifiers_json)[0].name, first!.name, 'the open bill keeps the name it was added with');
    assert.ok(before.invoice.id);

    assert.equal(code(() => updateModifierGroup(env.ctx, env.cashier, rid(), g.id, { name: 'X', minSelect: 0, maxSelect: 1, modifiers: [{ name: 'a', price: 0 }] })), 'FORBIDDEN');
    assert.equal(code(() => updateModifierGroup(env.ctx, env.manager, rid(), g.id, { name: 'X', minSelect: 3, maxSelect: 3, modifiers: [{ name: 'a', price: 0 }] })), 'VALIDATION');
    assert.equal(code(() => updateModifierGroup(env.ctx, env.manager, rid(), g.id, { name: 'X', minSelect: 0, maxSelect: 1, modifiers: [{ name: 'A', price: 0 }, { name: 'a ', price: 0 }] })), 'VALIDATION');

    deleteModifierGroup(env.ctx, env.manager, rid(), g.id);
    assert.equal(getCatalog(env.ctx).modifierGroups.some((x) => x.id === g.id), false);
    assert.deepEqual(getCatalog(env.ctx).items.find((i) => i.id === env.items['Cheese Burger'])!.modifierGroupIds, []);
  } finally { env.cleanup(); }
});

test('not available today: the bill refuses the item, the online menu hides it, and it is back the next day by itself', () => {
  const env = makeEnv(); try {
    startShift(env);
    const id = env.items['Cold Coffee']!;
    setItemAvailability(env.ctx, env.cashier, rid(), id, false); // cashiers may mark sold out
    assert.equal(getCatalog(env.ctx).items.find((i) => i.id === id)!.availableToday, false);
    assert.equal(onlineMenu(env.ctx).items.find((i) => i.id === id)!.available, false);
    const cart = createOrder(env.ctx, env.cashier, rid());
    assert.equal(code(() => addLine(env.ctx, env.cashier, rid(), { orderId: cart.order.id, itemId: id })), 'ITEM_UNAVAILABLE');
    // an online order placed a moment before still bills
    addLine(env.ctx, env.cashier, rid(), { orderId: cart.order.id, itemId: id, allowUnavailable: true });
    env.clock.advance(24 * 3_600_000);
    assert.equal(getCatalog(env.ctx).items.find((i) => i.id === id)!.availableToday, true);
    setItemAvailability(env.ctx, env.cashier, rid(), id, false);
    setItemAvailability(env.ctx, env.cashier, rid(), id, true);
    assert.equal(getCatalog(env.ctx).items.find((i) => i.id === id)!.availableToday, true);
  } finally { env.cleanup(); }
});

test('KOT reprint: every station again, marked REPRINT; a cashier needs a manager PIN', () => {
  const env = makeEnv(); try {
    startShift(env);
    const r = quickBill(env, [['Cheese Burger'], ['Cold Coffee']]);
    const first = all<{ n: number }>(env.ctx.db, "SELECT count(*) n FROM print_job WHERE kind='KOT' AND ref_id = ?", r.invoice.id)[0]!.n;
    assert.ok(first > 0);
    const approve = (actor = env.cashier, o?: { userId: string; pin: string }) => (perm: 'invoice.reprint') => requireApproval(env.ctx, actor, perm, o);
    assert.equal(code(() => reprintKot(env.ctx, env.cashier, rid(), { invoiceId: r.invoice.id }, approve())), 'APPROVAL_REQUIRED');
    const out = reprintKot(env.ctx, env.cashier, rid(), { invoiceId: r.invoice.id }, approve(env.cashier, { userId: env.manager.userId, pin: PINS.manager }));
    assert.equal(out.queued, first);
    const again = reprintKot(env.ctx, env.manager, rid(), { invoiceId: r.invoice.id }, approve(env.manager)); // a second reprint is its own run
    assert.equal(again.queued, first);
    const texts = all<{ payload: Uint8Array }>(env.ctx.db, "SELECT payload FROM print_job WHERE kind='KOT' AND ref_id = ? ORDER BY created_at, rowid", r.invoice.id).map((j) => parseEscPos(j.payload).text);
    assert.equal(texts.length, first * 3);
    assert.equal(texts.filter((t) => t.includes('REPRINT')).length, first * 2);
    assert.ok(texts.every((t) => t.includes(`TOKEN ${r.invoice.tokenNo}`) || t.includes(`T O K E N   ${r.invoice.tokenNo}`)));
  } finally { env.cleanup(); }
});

test('X-report: the open shift so far, printed without closing it; cash drawer opens only with a reason and a manager', () => {
  const env = makeEnv(); try {
    assert.equal(code(() => xReport(env.ctx, env.cashier)), 'NO_OPEN_SHIFT');
    startShift(env, 100000);
    quickBill(env, [['Masala Chai']]); quickBill(env, [['Brownie']], 'UPI');
    const x = xReport(env.ctx, env.cashier);
    assert.equal(x.invoices, 2);
    assert.equal(x.closedAt, null);
    assert.equal(x.cash.expected, 100000 + 4900);
    const printed = printXReport(env.ctx, env.cashier, rid());
    assert.equal(printed.queued, 1);
    const job = get<{ payload: Uint8Array }>(env.ctx.db, "SELECT payload FROM print_job WHERE kind='REPORT' ORDER BY created_at DESC LIMIT 1")!;
    assert.match(parseEscPos(job.payload).text, /SHIFT REPORT \(X\)[\s\S]*not a closing report/);
    assert.ok(get(env.ctx.db, 'SELECT 1 FROM shift WHERE closed_at IS NULL'), 'still open');

    assert.equal(code(() => openDrawer(env.ctx, env.cashier, rid(), { reason: 'change' })), 'APPROVAL_REQUIRED');
    assert.equal(code(() => openDrawer(env.ctx, env.manager, rid(), { reason: '' })), 'VALIDATION');
    const d = openDrawer(env.ctx, env.cashier, rid(), { reason: 'change for a customer', override: { userId: env.manager.userId, pin: PINS.manager } });
    const kick = get<{ payload: Uint8Array }>(env.ctx.db, 'SELECT payload FROM print_job WHERE id = ?', d.jobId!)!;
    assert.equal(parseEscPos(kick.payload).drawerKicks, 1);
    assert.ok(get(env.ctx.db, "SELECT 1 FROM audit_log WHERE action = 'drawer.open'"));
  } finally { env.cleanup(); }
});

test('payment mode correction: reports, shift cash and daily totals move; the payment itself never changes; a closed shift is final', () => {
  const env = makeEnv(); try {
    startShift(env, 100000);
    const r = quickBill(env, [['Cheese Burger']]); // paid "cash" by mistake
    const pay = r.payments[0]!;
    assert.equal(code(() => correctPaymentMode(env.ctx, env.cashier, rid(), { paymentId: pay.id, toMode: 'UPI', reason: 'customer paid by UPI' })), 'APPROVAL_REQUIRED');
    assert.equal(code(() => correctPaymentMode(env.ctx, env.manager, rid(), { paymentId: pay.id, toMode: 'CASH', reason: 'same mode' })), 'VALIDATION');
    assert.equal(code(() => correctPaymentMode(env.ctx, env.manager, rid(), { paymentId: pay.id, toMode: 'UPI', reason: '' })), 'VALIDATION');
    correctPaymentMode(env.ctx, env.cashier, rid(), { paymentId: pay.id, toMode: 'UPI', reference: 'UTR123', reason: 'customer paid by UPI', override: { userId: env.manager.userId, pin: PINS.manager } });

    assert.equal(get<{ mode: string }>(env.ctx.db, 'SELECT mode FROM payment WHERE id = ?', pay.id)!.mode, 'CASH', 'the payment row is never edited');
    const x = xReport(env.ctx, env.manager);
    assert.deepEqual(x.byMode, { UPI: r.invoice.grandTotal });
    assert.equal(x.cash.expected, 100000);
    const s1 = summary(env);
    recomputeDailySummary(env.ctx);
    assert.deepEqual(summary(env), s1, 'incremental daily totals equal a full recompute');
    assert.equal(Number(s1[0]!.upi), r.invoice.grandTotal);
    assert.equal(Number(s1[0]!.cash), 0);
    assert.match(receiptPreview(env.ctx, r.invoice.id, 80).lines.join('\n'), /UPI/);
    assert.throws(() => env.ctx.db.exec('UPDATE payment_correction SET to_mode = \'CARD\''), /immutable/);
    assert.throws(() => env.ctx.db.exec('DELETE FROM payment_correction'), /cannot be deleted/);

    // cancelling the bill afterwards takes it off the corrected mode
    cancelInvoice(env.ctx, env.manager, rid(), { invoiceId: r.invoice.id, reason: 'test' });
    const s2 = summary(env);
    recomputeDailySummary(env.ctx);
    assert.deepEqual(summary(env), s2);
    assert.equal(Number(s2[0]!.upi), 0);

    const r2 = quickBill(env, [['Masala Chai']]);
    closeShift(env.ctx, env.manager, rid(), { countedCash: 100000 + r2.invoice.grandTotal });
    startShift(env);
    assert.equal(code(() => correctPaymentMode(env.ctx, env.manager, rid(), { paymentId: r2.payments[0]!.id, toMode: 'CARD', reason: 'late fix' })), 'SHIFT_CLOSED');
  } finally { env.cleanup(); }
});

test('payment mode correction is journaled: restoring an older backup and replaying brings it back', async () => {
  const env = makeEnv(); try {
    startShift(env);
    const r = quickBill(env, [['Cold Coffee']]);
    const b = await runBackup(env.ctx, 'manual');
    correctPaymentMode(env.ctx, env.manager, rid(), { paymentId: r.payments[0]!.id, toMode: 'CARD', reason: 'card machine slip found' });
    const target = join(mkdtempSync(join(tmpdir(), 'pos-corr-')), 'pos.db');
    restoreBackup(b.file, target);
    const ctx2 = createCtx({ dataDir: join(target, '..'), logger: silentLogger, scryptCost: 1024 });
    try {
      ctx2.journalDir = env.ctx.journalDir;
      const rep = replayJournal(ctx2);
      assert.equal(rep.errors.length, 0);
      assert.equal(get<{ mode: string }>(ctx2.db, 'SELECT mode FROM payment_effective WHERE id = ?', r.payments[0]!.id)!.mode, 'CARD');
      assert.equal(get<{ mode: string }>(ctx2.db, 'SELECT mode FROM payment WHERE id = ?', r.payments[0]!.id)!.mode, 'CASH');
      assert.equal(zReport(ctx2, r.invoice.shiftId!).byMode.CARD, r.invoice.grandTotal);
    } finally { ctx2.db.close(); }
  } finally { env.cleanup(); }
});

test('the bill shows the customer typed on it, and where an online order came from', () => {
  const env = makeEnv(); try {
    startShift(env);
    const cart = cartOf(env, [['Masala Chai']]);
    updateOrder(env.ctx, env.cashier, rid(), { orderId: cart.order.id, customerName: 'Asha Rao', customerPhone: '9876543210' });
    const r = finalizeInvoice(env.ctx, env.cashier, rid(), { orderId: cart.order.id, payments: [{ mode: 'CASH', amount: cart.totals.grandTotal }] });
    const text = receiptPreview(env.ctx, r.invoice.id, 80).lines.join('\n');
    assert.match(text, /Customer:? +Asha Rao/);
    assert.match(text, /Phone:? +9876543210/);
    assert.doesNotMatch(text, /Order from/, 'a counter bill does not say where it came from');
    const plain = quickBill(env, [['Masala Chai']]);
    assert.doesNotMatch(receiptPreview(env.ctx, plain.invoice.id, 80).lines.join('\n'), /Customer|Phone:/);
  } finally { env.cleanup(); }
});

test('sign-ins survive a restart of the POS (only a hash is stored); sign-out, deactivation and inactivity still end them', () => {
  const env = makeEnv(); try {
    const { token } = login(env.ctx, env.cashier.userId, PINS.cashier);
    assert.ok(!all<{ token_hash: string }>(env.ctx.db, 'SELECT token_hash FROM app_session').some((r) => r.token_hash === token), 'the token itself is not stored');
    // a restart: a fresh context on the same database, with no sign-ins in memory
    const restarted = { ...env.ctx, sessions: new Map() };
    assert.equal(authenticate(restarted, token).userId, env.cashier.userId);
    logout(restarted, token);
    assert.equal(code(() => authenticate({ ...env.ctx, sessions: new Map() }, token)), 'UNAUTHENTICATED');

    const t2 = login(env.ctx, env.cashier.userId, PINS.cashier).token;
    env.clock.advance(10 * 60_000); // longer than the 5-minute inactivity lock
    assert.equal(code(() => authenticate({ ...env.ctx, sessions: new Map() }, t2)), 'SESSION_LOCKED');

    const t3 = login(env.ctx, env.cashier.userId, PINS.cashier).token;
    deactivateUser(env.ctx, env.owner, rid(), env.cashier.userId);
    assert.equal(code(() => authenticate({ ...env.ctx, sessions: new Map() }, t3)), 'UNAUTHENTICATED');
  } finally { env.cleanup(); }
});
