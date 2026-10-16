import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { all, get, openDb, run, sha256, AppError, currentSchemaVersion } from '../src/store/db.ts';
import { MIGRATIONS } from '../src/store/schema.ts';
import { createCtx, silentLogger } from '../src/services/ctx.ts';
import {
  adjustStock, createPurchase, createStockItem, deleteStockItem, getPurchase, getRecipe, listMovements, listPurchases,
  listStockItems, previewPurchase, setRecipe, updateStockItem, verifyStock, voidPurchase,
} from '../src/services/stock.ts';
import { cancelInvoice, createCreditNote } from '../src/services/invoices.ts';
import { restoreBackup, runBackup } from '../src/services/backup.ts';
import { readJournal, repairJournal, replayJournal } from '../src/services/journal.ts';
import { getHealth } from '../src/services/health.ts';
import { makeEnv, quickBill, rid, startShift } from './helpers.ts';
import type { Env } from './helpers.ts';

const code = (fn: () => unknown): string => { try { fn(); } catch (e) { if (e instanceof AppError) return e.code; throw e; } return 'NO_ERROR'; };
const onHand = (env: Env, id: string) => get<{ n: number }>(env.ctx.db, 'SELECT on_hand_milli n FROM stock_item WHERE id = ?', id)!.n;

function materials(env: Env) {
  const bun = createStockItem(env.ctx, env.manager, rid(), { name: 'Burger bun', unit: 'pcs', reorderLevelMilli: 20_000, openingQtyMilli: 50_000, openingUnitCost: 800 });
  const patty = createStockItem(env.ctx, env.manager, rid(), { name: 'Veg patty', unit: 'kg', reorderLevelMilli: 2_000, openingQtyMilli: 5_000 });
  const cheese = createStockItem(env.ctx, env.manager, rid(), { name: 'Cheese slice', unit: 'pcs' });
  return { bun, patty, cheese };
}

test('stock items: create with opening stock, low-stock flag, validation and unique names', () => {
  const env = makeEnv(); try {
    const { bun, patty, cheese } = materials(env);
    assert.equal(bun.onHandMilli, 50_000);
    assert.equal(bun.valuePaise, 50 * 800); // 50 buns at Rs 8
    assert.equal(cheese.onHandMilli, 0);
    assert.equal(cheese.low, false); // no reorder level set
    const list = listStockItems(env.ctx);
    assert.deepEqual(list.map((s) => s.name), ['Burger bun', 'Cheese slice', 'Veg patty']);
    assert.equal(list.find((s) => s.id === patty.id)!.low, false);
    assert.equal(get<{ n: number }>(env.ctx.db, "SELECT count(*) n FROM stock_movement WHERE kind = 'OPENING'")!.n, 2);

    assert.equal(code(() => createStockItem(env.ctx, env.manager, rid(), { name: 'burger BUN', unit: 'pcs' })), 'DUPLICATE');
    assert.equal(code(() => createStockItem(env.ctx, env.manager, rid(), { name: 'Oil', unit: 'barrel' as 'kg' })), 'VALIDATION');
    assert.equal(code(() => createStockItem(env.ctx, env.manager, rid(), { name: '  ', unit: 'kg' })), 'VALIDATION');
    assert.equal(code(() => createStockItem(env.ctx, env.manager, rid(), { name: 'Oil', unit: 'l', openingQtyMilli: -1 })), 'VALIDATION');
    assert.equal(code(() => createStockItem(env.ctx, env.cashier, rid(), { name: 'Oil', unit: 'l' })), 'FORBIDDEN');

    const upd = updateStockItem(env.ctx, env.manager, rid(), patty.id, { name: 'Aloo tikki patty', reorderLevelMilli: 6_000 });
    assert.equal(upd.name, 'Aloo tikki patty');
    assert.equal(upd.low, true); // 5 kg < 6 kg
    assert.throws(() => run(env.ctx.db, "UPDATE stock_item SET unit = 'g' WHERE id = ?", patty.id), /unit of a stock item cannot change/);
    assert.equal(verifyStock(env.ctx).ok, true);
  } finally { env.cleanup(); }
});

test('purchases: exact paise amounts, stock goes up, idempotent, immutable; void reverses once', () => {
  const env = makeEnv(); try {
    const { bun, patty } = materials(env);
    const preview = previewPurchase(env.ctx, [{ stockItemId: patty.id, qtyMilli: 1_500, unitCost: 12_345 }, { stockItemId: bun.id, qtyMilli: 24_000, unitCost: 750 }]);
    assert.deepEqual(preview.lines.map((l) => l.amount), [18_518, 18_000]); // 1.5 kg x Rs 123.45 = Rs 185.175 -> 185.18 (half up)
    assert.equal(preview.total, 36_518);

    const key = rid();
    const p = createPurchase(env.ctx, env.manager, key, { supplierName: 'Metro Wholesale', billNo: 'MW-991', billDate: '2026-10-12', lines: [{ stockItemId: patty.id, qtyMilli: 1_500, unitCost: 12_345 }, { stockItemId: bun.id, qtyMilli: 24_000, unitCost: 750 }] });
    assert.equal(p.purchase.total, 36_518);
    assert.equal(onHand(env, patty.id), 6_500);
    assert.equal(onHand(env, bun.id), 74_000);
    assert.equal(listStockItems(env.ctx).find((s) => s.id === bun.id)!.lastUnitCost, 750);
    // a retry with the same request id changes nothing
    assert.equal(createPurchase(env.ctx, env.manager, key, { supplierName: 'Metro Wholesale', lines: [{ stockItemId: bun.id, qtyMilli: 1, unitCost: 1 }] }).purchase.id, p.purchase.id);
    assert.equal(onHand(env, bun.id), 74_000);
    assert.equal(listPurchases(env.ctx).length, 1);
    assert.equal(getPurchase(env.ctx, p.purchase.id).lines.length, 2);

    assert.equal(code(() => createPurchase(env.ctx, env.cashier, rid(), { supplierName: 'X', lines: [{ stockItemId: bun.id, qtyMilli: 1000, unitCost: 1 }] })), 'FORBIDDEN');
    assert.equal(code(() => createPurchase(env.ctx, env.manager, rid(), { supplierName: 'X', lines: [] })), 'VALIDATION');
    assert.equal(code(() => createPurchase(env.ctx, env.manager, rid(), { supplierName: 'X', lines: [{ stockItemId: 'nope', qtyMilli: 1000, unitCost: 1 }] })), 'NOT_FOUND');
    assert.equal(code(() => createPurchase(env.ctx, env.manager, rid(), { supplierName: 'X', lines: [{ stockItemId: bun.id, qtyMilli: 0, unitCost: 1 }] })), 'VALIDATION');
    assert.equal(code(() => createPurchase(env.ctx, env.manager, rid(), { supplierName: 'X', billDate: '12/10/2026', lines: [{ stockItemId: bun.id, qtyMilli: 1, unitCost: 1 }] })), 'VALIDATION');
    assert.equal(code(() => createPurchase(env.ctx, env.manager, rid(), { supplierName: 'X', supplierGstin: 'BAD', lines: [{ stockItemId: bun.id, qtyMilli: 1, unitCost: 1 }] })), 'VALIDATION');

    // records cannot be edited or deleted, even with direct SQL
    for (const sql of ["UPDATE purchase SET total = 1", "DELETE FROM purchase", "UPDATE purchase_line SET qty_milli = 1", "DELETE FROM purchase_line", "UPDATE stock_movement SET delta_milli = 1", "DELETE FROM stock_movement"]) {
      assert.throws(() => run(env.ctx.db, sql), /immutable|cannot be deleted/, sql);
    }

    assert.equal(code(() => voidPurchase(env.ctx, env.manager, rid(), { purchaseId: p.purchase.id, reason: '' })), 'VALIDATION');
    voidPurchase(env.ctx, env.manager, rid(), { purchaseId: p.purchase.id, reason: 'Entered twice' });
    assert.equal(onHand(env, patty.id), 5_000);
    assert.equal(onHand(env, bun.id), 50_000);
    assert.equal(getPurchase(env.ctx, p.purchase.id).purchase.status, 'VOIDED');
    const after = listStockItems(env.ctx);
    assert.equal(after.find((s) => s.id === bun.id)!.lastUnitCost, 800); // back to the opening cost
    assert.equal(after.find((s) => s.id === patty.id)!.lastUnitCost, null);
    assert.equal(code(() => voidPurchase(env.ctx, env.manager, rid(), { purchaseId: p.purchase.id, reason: 'again' })), 'ALREADY_VOIDED');
    assert.throws(() => run(env.ctx.db, "UPDATE purchase SET status = 'POSTED' WHERE id = ?", p.purchase.id), /cannot be reinstated/);
    assert.equal(verifyStock(env.ctx).ok, true);
  } finally { env.cleanup(); }
});

test('adjustments: wastage, physical count and correction, each with a reason and a ledger row', () => {
  const env = makeEnv(); try {
    const { patty } = materials(env);
    adjustStock(env.ctx, env.manager, rid(), { stockItemId: patty.id, kind: 'WASTAGE', qtyMilli: 250, reason: 'Dropped' });
    assert.equal(onHand(env, patty.id), 4_750);
    const counted = adjustStock(env.ctx, env.manager, rid(), { stockItemId: patty.id, kind: 'COUNT', qtyMilli: 4_600 });
    assert.equal(counted.onHandMilli, 4_600);
    const same = adjustStock(env.ctx, env.manager, rid(), { stockItemId: patty.id, kind: 'COUNT', qtyMilli: 4_600 });
    assert.equal(same.onHandMilli, 4_600); // matching count: no movement
    adjustStock(env.ctx, env.manager, rid(), { stockItemId: patty.id, kind: 'ADJUST', qtyMilli: -100, reason: 'Typo in last purchase' });
    assert.equal(onHand(env, patty.id), 4_500);
    const moves = listMovements(env.ctx, patty.id);
    assert.deepEqual(moves.map((m) => [m.kind, m.deltaMilli]), [['ADJUST', -100], ['COUNT', -150], ['WASTAGE', -250], ['OPENING', 5_000]]);
    assert.equal(moves[2]!.reason, 'Dropped');

    assert.equal(code(() => adjustStock(env.ctx, env.manager, rid(), { stockItemId: patty.id, kind: 'WASTAGE', qtyMilli: 100, reason: ' ' })), 'VALIDATION');
    assert.equal(code(() => adjustStock(env.ctx, env.manager, rid(), { stockItemId: patty.id, kind: 'WASTAGE', qtyMilli: -100, reason: 'x' })), 'VALIDATION');
    assert.equal(code(() => adjustStock(env.ctx, env.manager, rid(), { stockItemId: patty.id, kind: 'ADJUST', qtyMilli: 0, reason: 'x' })), 'VALIDATION');
    assert.equal(code(() => adjustStock(env.ctx, env.manager, rid(), { stockItemId: patty.id, kind: 'COUNT', qtyMilli: -1 })), 'VALIDATION');
    assert.equal(code(() => adjustStock(env.ctx, env.cashier, rid(), { stockItemId: patty.id, kind: 'WASTAGE', qtyMilli: 1, reason: 'x' })), 'FORBIDDEN');
    assert.equal(code(() => adjustStock(env.ctx, env.manager, rid(), { stockItemId: 'nope', kind: 'WASTAGE', qtyMilli: 1, reason: 'x' })), 'NOT_FOUND');
    assert.equal(verifyStock(env.ctx).ok, true);
  } finally { env.cleanup(); }
});

test('recipes: billing deducts stock in the same transaction, never blocks a bill, and cancel restores it', () => {
  const env = makeEnv(); try {
    startShift(env);
    const { bun, patty, cheese } = materials(env);
    const burger = env.items['Cheese Burger']!;
    assert.equal(code(() => setRecipe(env.ctx, env.cashier, rid(), burger, [{ stockItemId: bun.id, qtyMilli: 1000 }])), 'FORBIDDEN');
    assert.equal(code(() => setRecipe(env.ctx, env.manager, rid(), burger, [{ stockItemId: bun.id, qtyMilli: 1000 }, { stockItemId: bun.id, qtyMilli: 1000 }])), 'VALIDATION');
    assert.equal(code(() => setRecipe(env.ctx, env.manager, rid(), 'nope', [])), 'NOT_FOUND');
    setRecipe(env.ctx, env.manager, rid(), burger, [{ stockItemId: bun.id, qtyMilli: 1000 }, { stockItemId: patty.id, qtyMilli: 120 }, { stockItemId: cheese.id, qtyMilli: 1000 }]);
    assert.equal(getRecipe(env.ctx, burger).length, 3);
    assert.equal(code(() => deleteStockItem(env.ctx, env.manager, rid(), bun.id)), 'IN_USE');

    const bill = quickBill(env, [['Cheese Burger', 3000], ['Cola 300ml']]); // 3 burgers; cola has no recipe
    assert.equal(onHand(env, bun.id), 47_000);
    assert.equal(onHand(env, patty.id), 4_640); // 5 kg - 3 x 0.12 kg
    assert.equal(onHand(env, cheese.id), -3_000); // no cheese in stock: the bill still went through
    assert.equal(listStockItems(env.ctx).find((s) => s.id === cheese.id)!.negative, true);
    const sale = all<{ kind: string; ref_id: string }>(env.ctx.db, "SELECT kind, ref_id FROM stock_movement WHERE kind = 'SALE'");
    assert.equal(sale.length, 3);
    assert.ok(sale.every((m) => m.ref_id === bill.invoice.id));

    // the journal entry for the bill carries its stock movements (disaster recovery)
    const entry = readJournal(env.ctx.journalDir).entries.find((e) => e.type === 'invoice' && e.full.invoice.id === bill.invoice.id);
    assert.equal(entry?.type === 'invoice' ? entry.stock?.length : 0, 3);

    // a credit note refunds money but does not restock (returned food is not resaleable)
    const b2 = quickBill(env, [['Cheese Burger']]);
    createCreditNote(env.ctx, env.manager, rid(), { invoiceId: b2.invoice.id, lines: [{ invoiceLineId: b2.lines[0]!.id, qtyMilli: 1000 }], reason: 'Customer returned', refunds: [{ mode: 'CASH', amount: b2.invoice.grandTotal }] });
    assert.equal(onHand(env, bun.id), 46_000);

    // cancelling a bill (same day, wrong bill) reverses exactly what it used
    cancelInvoice(env.ctx, env.manager, rid(), { invoiceId: bill.invoice.id, reason: 'Wrong bill' });
    assert.equal(onHand(env, bun.id), 49_000);
    assert.equal(onHand(env, patty.id), 5_000 - 120);
    assert.equal(onHand(env, cheese.id), -1_000);

    // a recipe change affects future bills only
    setRecipe(env.ctx, env.manager, rid(), burger, []);
    quickBill(env, [['Cheese Burger']]);
    assert.equal(onHand(env, bun.id), 49_000);
    assert.equal(verifyStock(env.ctx).ok, true);
  } finally { env.cleanup(); }
});

test('ledger check: a tampered balance is detected by verifyStock and the deep health check', () => {
  const env = makeEnv(); try {
    const { bun } = materials(env);
    run(env.ctx.db, 'UPDATE stock_item SET on_hand_milli = on_hand_milli + 5 WHERE id = ?', bun.id);
    const v = verifyStock(env.ctx);
    assert.equal(v.ok, false);
    assert.deepEqual(v.mismatches.map((m) => m.stockItemId), [bun.id]);
    const h = getHealth(env.ctx, { deep: true });
    assert.equal(h.integrity?.stock.ok, false);
    assert.ok(h.warnings.some((w) => /stock/i.test(w)));
  } finally { env.cleanup(); }
});

test('disaster recovery: restore the backup, replay the journal; stock, purchases and voids come back exactly', async () => {
  const env = makeEnv(); try {
    startShift(env);
    const { bun, patty } = materials(env);
    setRecipe(env.ctx, env.manager, rid(), env.items['Cheese Burger']!, [{ stockItemId: bun.id, qtyMilli: 1000 }, { stockItemId: patty.id, qtyMilli: 120 }]);
    const backup = await runBackup(env.ctx, 'manual');
    // after the backup: a new material, a purchase, a voided purchase, wastage, a sale and a cancelled sale
    const oil = createStockItem(env.ctx, env.manager, rid(), { name: 'Oil', unit: 'l', reorderLevelMilli: 5_000 });
    createPurchase(env.ctx, env.manager, rid(), { supplierName: 'Metro', lines: [{ stockItemId: oil.id, qtyMilli: 15_000, unitCost: 14_000 }, { stockItemId: bun.id, qtyMilli: 10_000, unitCost: 800 }] });
    const bad = createPurchase(env.ctx, env.manager, rid(), { supplierName: 'Metro', lines: [{ stockItemId: patty.id, qtyMilli: 1_000, unitCost: 20_000 }] });
    voidPurchase(env.ctx, env.manager, rid(), { purchaseId: bad.purchase.id, reason: 'duplicate' });
    adjustStock(env.ctx, env.manager, rid(), { stockItemId: oil.id, kind: 'WASTAGE', qtyMilli: 500, reason: 'Spill' });
    updateStockItem(env.ctx, env.manager, rid(), oil.id, { reorderLevelMilli: 3_000 });
    quickBill(env, [['Cheese Burger', 2000]]);
    const wrong = quickBill(env, [['Cheese Burger']]);
    cancelInvoice(env.ctx, env.manager, rid(), { invoiceId: wrong.invoice.id, reason: 'oops' });
    const snapshot = (db: DatabaseSync) => ({
      items: all(db, 'SELECT id, name, unit, on_hand_milli, reorder_level_milli, last_unit_cost FROM stock_item ORDER BY name'),
      purchases: all(db, 'SELECT id, total, status FROM purchase ORDER BY created_at, id'),
      moves: all(db, 'SELECT id, stock_item_id, delta_milli, kind, ref_id FROM stock_movement ORDER BY id'),
    });
    const original = snapshot(env.ctx.db);
    env.ctx.db.close();

    const fresh = mkdtempSync(join(tmpdir(), 'pos-stock-fresh-'));
    let ctx: ReturnType<typeof createCtx> | null = null;
    try {
      restoreBackup(backup.file, join(fresh, 'pos.db'));
      mkdirSync(join(fresh, 'journal'));
      for (const f of readdirSync(join(env.dir, 'journal'))) copyFileSync(join(env.dir, 'journal', f), join(fresh, 'journal', f));
      ctx = createCtx({ dataDir: fresh, clock: env.clock, logger: silentLogger, scryptCost: 1024 });
      const res = replayJournal(ctx);
      assert.deepEqual(res.errors, []);
      assert.deepEqual(snapshot(ctx.db), original);
      assert.equal(verifyStock(ctx).ok, true);
      assert.equal(replayJournal(ctx).replayed, 0); // idempotent
    } finally { ctx?.db.close(); rmSync(fresh, { recursive: true, force: true }); }
  } finally { env.cleanup(); }
});

test('journal repair after a crash restores the stock movements of the missing bill', () => {
  const env = makeEnv(); try {
    startShift(env);
    const { bun } = materials(env);
    setRecipe(env.ctx, env.manager, rid(), env.items['Cheese Burger']!, [{ stockItemId: bun.id, qtyMilli: 1000 }]);
    const b = quickBill(env, [['Cheese Burger']]);
    // simulate "crash after commit, before the journal write": drop the bill's journal line
    for (const f of readdirSync(env.ctx.journalDir)) rmSync(join(env.ctx.journalDir, f));
    assert.equal(repairJournal(env.ctx), 1);
    const e = readJournal(env.ctx.journalDir).entries.find((x) => x.type === 'invoice' && x.full.invoice.id === b.invoice.id);
    assert.equal(e?.type === 'invoice' ? e.stock?.length : 0, 1);
  } finally { env.cleanup(); }
});

test('migration: a version 1 database (before inventory) upgrades to version 2 with its bills intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pos-mig2-'));
  try {
    const path = join(dir, 'pos.db');
    const v1 = new DatabaseSync(path);
    v1.exec('PRAGMA journal_mode = WAL');
    v1.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)');
    v1.exec(MIGRATIONS[0]!.sql);
    v1.prepare('INSERT INTO schema_migrations VALUES (1, ?, ?, 0)').run(MIGRATIONS[0]!.name, sha256(MIGRATIONS[0]!.sql));
    v1.prepare("INSERT INTO settings(key, value, updated_at) VALUES ('marker', 'kept', 0)").run();
    v1.close();
    const db = openDb(path);
    try {
      assert.equal(currentSchemaVersion(db), MIGRATIONS.at(-1)!.version); // v1 upgrades through every later migration
      assert.equal(get<{ value: string }>(db, "SELECT value FROM settings WHERE key = 'marker'")!.value, 'kept');
      assert.equal(get<{ n: number }>(db, "SELECT count(*) n FROM sqlite_master WHERE name IN ('stock_item','stock_movement','purchase','purchase_line','recipe_line')")!.n, 5);
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
