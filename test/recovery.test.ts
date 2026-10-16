import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { all, get } from '../src/store/db.ts';
import { createCtx, silentLogger } from '../src/services/ctx.ts';
import { backupStatus, listBackups, pruneBackups, restoreBackup, runBackup, verifyBackup } from '../src/services/backup.ts';
import { readJournal, repairJournal, replayJournal, verifyJournal } from '../src/services/journal.ts';
import { cancelInvoice, finalizeInvoice } from '../src/services/invoices.ts';
import { closeShift } from '../src/services/shifts.ts';
import { getHealth } from '../src/services/health.ts';
import { pruneCommandLog } from '../src/services/commands.ts';
import { recomputeDailySummary } from '../src/services/reports.ts';
import { makeEnv, quickBill, rid, startShift } from './helpers.ts';
import { AppError } from '../src/store/db.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const code = async (fn: () => unknown): Promise<string> => { try { await fn(); } catch (e) { if (e instanceof AppError) return e.code; throw e; } return 'NO_ERROR'; };

test('backup is taken online, verified, and restores to an identical database', async () => {
  const env = makeEnv(); try {
    startShift(env);
    for (let i = 0; i < 3; i++) quickBill(env, [['Masala Chai']]);
    const b = await runBackup(env.ctx, 'manual');
    assert.equal(b.verified, true);
    assert.equal(verifyBackup(b.file).ok, true);
    const target = join(mkdtempSync(join(tmpdir(), 'pos-restore-')), 'pos.db');
    restoreBackup(b.file, target);
    const restored = createCtx({ dataDir: join(target, '..'), logger: silentLogger, scryptCost: 1024 });
    assert.equal(get<{ n: number }>(restored.db, 'SELECT count(*) n FROM invoice')!.n, 3);
    assert.equal(await code(() => restoreBackup(b.file, target)), 'TARGET_EXISTS');
    restored.db.close();
  } finally { env.cleanup(); }
});

test('a truncated or garbage backup is rejected, never restored', async () => {
  const env = makeEnv(); try {
    startShift(env);
    quickBill(env, [['Masala Chai']]);
    const b = await runBackup(env.ctx, 'manual');
    const bad = join(env.dir, 'truncated.db');
    copyFileSync(b.file, bad);
    truncateSync(bad, Math.floor(statSync(bad).size / 2));
    assert.equal(verifyBackup(bad).ok, false);
    const junk = join(env.dir, 'junk.db');
    writeFileSync(junk, 'this is not a database'.repeat(500));
    assert.equal(verifyBackup(junk).ok, false);
    assert.equal(await code(() => restoreBackup(bad, join(env.dir, 'x.db'))), 'BACKUP_INVALID');
    assert.equal(await code(() => restoreBackup(junk, join(env.dir, 'y.db'))), 'BACKUP_INVALID');
  } finally { env.cleanup(); }
});

test('disaster recovery: restore last backup, replay the journal, numbering continues with no gap', async () => {
  const env = makeEnv(); try {
    const sh = startShift(env);
    for (let i = 0; i < 3; i++) quickBill(env, [['Cheese Burger']]);
    const backup = await runBackup(env.ctx, 'manual');            // backup taken after bill 3
    const b4 = quickBill(env, [['Brownie']], 'UPI');
    const b5 = quickBill(env, [['Cold Coffee']]);
    cancelInvoice(env.ctx, env.manager, rid(), { invoiceId: b5.invoice.id, reason: 'oops' });
    closeShift(env.ctx, env.cashier, rid(), { countedCash: 50000 + 3 * 12900 });
    const original = all(env.ctx.db, 'SELECT * FROM daily_summary ORDER BY day');
    const originalInvoices = all<{ invoice_no: string; status: string; grand_total: number }>(env.ctx.db, 'SELECT invoice_no, status, grand_total FROM invoice ORDER BY seq_no');
    env.ctx.db.close();

    // The disk is gone. New PC: restore the backup file and copy the journal folder from another location.
    const fresh = mkdtempSync(join(tmpdir(), 'pos-fresh-'));
    restoreBackup(backup.file, join(fresh, 'pos.db'));
    mkdirSync(join(fresh, 'journal'), { recursive: true });
    for (const f of readdirSync(join(env.dir, 'journal'))) copyFileSync(join(env.dir, 'journal', f), join(fresh, 'journal', f));
    const ctx = createCtx({ dataDir: fresh, clock: env.clock, logger: silentLogger, scryptCost: 1024 });
    assert.equal(get<{ n: number }>(ctx.db, 'SELECT count(*) n FROM invoice')!.n, 3);
    const res = replayJournal(ctx);
    assert.deepEqual(res.errors, []);
    assert.ok(res.replayed >= 3); // bill 4, bill 5, cancellation, shift close
    assert.deepEqual(all(ctx.db, 'SELECT invoice_no, status, grand_total FROM invoice ORDER BY seq_no'), originalInvoices);
    assert.deepEqual(all(ctx.db, 'SELECT * FROM daily_summary ORDER BY day'), original);
    assert.equal(get<{ closed_at: number | null }>(ctx.db, 'SELECT closed_at FROM shift WHERE id = ?', sh.id)!.closed_at !== null, true);
    assert.equal(replayJournal(ctx).replayed, 0); // replay is idempotent
    // next bill continues the series without gap or duplicate
    const env2 = { ...env, ctx };
    startShift(env2 as typeof env, 1000);
    assert.equal(quickBill(env2 as typeof env, [['Masala Chai']]).invoice.invoiceNo, 'A1/26-27/000006');
    assert.equal(b4.invoice.invoiceNo, 'A1/26-27/000004');
    ctx.db.close();
    rmSync(fresh, { recursive: true, force: true });
  } finally { env.cleanup(); }
});

test('a torn last journal line (power loss mid-write) is ignored, not fatal', () => {
  const env = makeEnv(); try {
    startShift(env);
    quickBill(env, [['Masala Chai']]);
    const file = join(env.ctx.journalDir, readdirSync(env.ctx.journalDir).find((f) => f.endsWith('.ndjson'))!);
    appendFileSync(file, '{"v":1,"type":"invoice","at":17000000000');
    const j = readJournal(env.ctx.journalDir);
    assert.equal(j.malformed, 1);
    assert.equal(verifyJournal(env.ctx).missingInDb.length, 0);
    assert.equal(replayJournal(env.ctx).errors.length, 0);
  } finally { env.cleanup(); }
});

test('deleted journal: verify reports it, repair rewrites it from the database', () => {
  const env = makeEnv(); try {
    startShift(env);
    for (let i = 0; i < 3; i++) quickBill(env, [['Masala Chai']]);
    for (const f of readdirSync(env.ctx.journalDir)) rmSync(join(env.ctx.journalDir, f));
    assert.equal(verifyJournal(env.ctx).missingInJournal.length, 3);
    assert.equal(getHealth(env.ctx).warnings.some((w) => /journal/i.test(w)), true);
    assert.equal(repairJournal(env.ctx), 3);
    assert.equal(verifyJournal(env.ctx).missingInJournal.length, 0);
  } finally { env.cleanup(); }
});

test('backup retention keeps only the newest per kind; status warns after 24h', async () => {
  const env = makeEnv(); try {
    for (let i = 0; i < 30; i++) { env.clock.advance(3_600_000); await runBackup(env.ctx, 'hourly'); }
    assert.equal(listBackups(env.ctx.backupDir).filter((f) => f.file.startsWith('hourly-')).length, 24);
    assert.equal(backupStatus(env.ctx).warn, false);
    env.clock.advance(25 * 3_600_000);
    assert.equal(backupStatus(env.ctx).warn, true);
    assert.equal(getHealth(env.ctx).ok, false);
    await runBackup(env.ctx, 'manual');
    assert.equal(getHealth(env.ctx).ok, true);
    assert.equal(pruneBackups(env.ctx.backupDir), 0);
    // only backups and the shared photo store; no stray -wal/-shm files (reading a backup for its photo list must not leave any)
    assert.ok(readdirSync(env.ctx.backupDir).every((f) => f.endsWith('.db') || f === 'images'), 'no stray -wal/-shm files beside backups');
    assert.deepEqual(readdirSync(join(env.ctx.backupDir, 'images')), []); // the demo menu has no photos
    writeFileSync(join(env.ctx.backupDir, 'orphan.db-wal'), 'x');
    pruneBackups(env.ctx.backupDir);
    assert.ok(!readdirSync(env.ctx.backupDir).includes('orphan.db-wal'));
  } finally { env.cleanup(); }
});

test('health: deep check verifies integrity and audit chain; old command_log rows are pruned', () => {
  const env = makeEnv(); try {
    startShift(env);
    quickBill(env, [['Masala Chai']]);
    const h = getHealth(env.ctx, { deep: true });
    assert.equal(h.integrity?.quickCheck.ok, true);
    assert.equal(h.integrity?.auditChain.ok, true);
    env.clock.advance(8 * 86_400_000);
    assert.ok(pruneCommandLog(env.ctx, env.clock.now() - 7 * 86_400_000) > 0);
    assert.equal(h.clockWarning, false);
    env.clock.t = Date.UTC(2026, 9, 12, 4, 30, 0) - 3 * 86_400_000; // clock jumps to before the last invoice
    assert.equal(getHealth(env.ctx).clockWarning, true);
    recomputeDailySummary(env.ctx);
  } finally { env.cleanup(); }
});

test('closing and reopening the database keeps committed bills (WAL durability)', () => {
  const env = makeEnv(); try {
    startShift(env);
    const nos = [1, 2, 3].map(() => quickBill(env, [['Masala Chai']]).invoice.invoiceNo);
    const walBefore = readFileSync(env.ctx.dbPath + '-wal').length;
    assert.ok(walBefore >= 0);
    env.ctx.db.close();
    const again = createCtx({ dataDir: env.dir, clock: env.clock, logger: silentLogger, scryptCost: 1024 });
    assert.deepEqual(all<{ invoice_no: string }>(again.db, 'SELECT invoice_no FROM invoice ORDER BY seq_no').map((r) => r.invoice_no), nos);
    again.db.close();
  } finally { env.cleanup(); }
});

test('journal compaction: old days are gzipped (about 20x smaller), still verify and replay, today stays raw', async () => {
  const { compactJournal } = await import('../src/services/journal.ts');
  const env = makeEnv(); try {
    startShift(env);
    for (let i = 0; i < 20; i++) quickBill(env, [['Cheese Burger', 1000], ['Cola 300ml', 2000]]);
    env.clock.advance(3 * 86_400_000);
    const before = readdirSync(env.ctx.journalDir);
    assert.deepEqual(before, ['2026-10-12.ndjson']);
    const rawSize = statSync(join(env.ctx.journalDir, before[0]!)).size;
    const r = compactJournal(env.ctx);
    assert.equal(r.compressed, 1);
    assert.ok(r.savedBytes > rawSize * 0.8, `saved ${r.savedBytes} of ${rawSize}`);
    assert.deepEqual(readdirSync(env.ctx.journalDir), ['2026-10-12.ndjson.gz']);
    assert.equal(verifyJournal(env.ctx).missingInDb.length + verifyJournal(env.ctx).missingInJournal.length, 0);
    assert.equal(compactJournal(env.ctx).compressed, 0); // idempotent
    // compressed days are still read by recovery
    assert.equal(readJournal(env.ctx.journalDir).entries.filter((e) => e.type === 'invoice').length, 20);
  } finally { env.cleanup(); }
});
