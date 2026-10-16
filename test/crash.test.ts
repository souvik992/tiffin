import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { all, get } from '../src/store/db.ts';
import { createCtx, silentLogger } from '../src/services/ctx.ts';
import { finalizeInvoice } from '../src/services/invoices.ts';
import { readJournal, repairJournal, verifyJournal } from '../src/services/journal.ts';
import { startupChecks, defaultQueue } from '../src/startup.ts';
import { makeEnv, rid, startShift } from './helpers.ts';

const worker = (name: string) => join(import.meta.dirname, 'workers', name);
/** Hard kill at the fault point. Windows has no signals: TerminateProcess shows as status 1, so the worker's marker is required. */
function assertKilled(r: { signal: NodeJS.Signals | null; status: number | null; stdout: string; stderr: string }, point: string) {
  assert.ok(r.stderr.includes(`KILLING at ${point}`), `worker should have reached the fault point, got ${r.status} ${r.stderr}`);
  if (process.platform === 'win32') assert.equal(r.status, 1, 'worker should have been terminated');
  else assert.equal(r.signal, 'SIGKILL', `worker should have been killed, got ${r.status} ${r.stderr}`);
  assert.ok(!r.stdout.includes('COMPLETED'));
}

// Killing the process at any point inside the finalize transaction must leave either the whole bill or nothing.
for (const point of ['finalize.validated', 'invoice.after_row', 'invoice.after_lines', 'invoice.after_payments', 'finalize.before_commit']) {
  test(`SIGKILL at "${point}" leaves no partial bill and the next bill gets number 1`, () => {
    const env = makeEnv(); try {
      startShift(env);
      env.ctx.db.close();
      const r = spawnSync(process.execPath, [worker('crash-worker.ts'), env.dir, point], { encoding: 'utf8' });
      assertKilled(r, point);

      const ctx = createCtx({ dataDir: env.dir, clock: env.clock, logger: silentLogger, scryptCost: 1024 });
      assert.equal(get<{ n: number }>(ctx.db, 'SELECT count(*) n FROM invoice')!.n, 0);
      assert.equal(get<{ n: number }>(ctx.db, 'SELECT count(*) n FROM invoice_line')!.n, 0);
      assert.equal(get<{ n: number }>(ctx.db, 'SELECT count(*) n FROM payment')!.n, 0);
      assert.equal(get<{ n: number }>(ctx.db, 'SELECT count(*) n FROM invoice_series')!.n, 0); // number allocation rolled back too
      assert.equal(get<{ n: number }>(ctx.db, 'SELECT count(*) n FROM print_job')!.n, 0);
      assert.equal(get<{ n: number }>(ctx.db, 'SELECT count(*) n FROM outbox WHERE entity = \'invoice\'')!.n, 0);
      const order = get<{ id: string; status: string }>(ctx.db, 'SELECT id, status FROM sale_order')!;
      assert.equal(order.status, 'DRAFT'); // the cashier's bill is intact and can be re-submitted
      const cashier = all<{ id: string }>(ctx.db, "SELECT id FROM app_user WHERE role='cashier'")[0]!;
      const done = finalizeInvoice(ctx, { userId: cashier.id, role: 'cashier', name: 'Cashier' }, rid(), { orderId: order.id, payments: [{ mode: 'CASH', amount: 12900 }] });
      assert.equal(done.invoice.invoiceNo, 'A1/26-27/000001');
      assert.equal(startupChecks(ctx, defaultQueue(ctx)).journalRepaired, 0);
      ctx.db.close();
    } finally { env.cleanup(); }
  });
}

test('SIGKILL after commit but before the journal write: bill is kept; journal repair restores the entry', () => {
  const env = makeEnv(); try {
    startShift(env);
    env.ctx.db.close();
    const r = spawnSync(process.execPath, [worker('crash-worker.ts'), env.dir, 'finalize.after_commit'], { encoding: 'utf8' });
    assertKilled(r, 'finalize.after_commit');
    const ctx = createCtx({ dataDir: env.dir, clock: env.clock, logger: silentLogger, scryptCost: 1024 });
    assert.equal(get<{ n: number }>(ctx.db, 'SELECT count(*) n FROM invoice')!.n, 1); // committed bills survive a kill
    assert.equal(verifyJournal(ctx).missingInJournal.length, 1);
    assert.equal(startupChecks(ctx, defaultQueue(ctx)).journalRepaired, 1); // startup heals the journal
    assert.equal(verifyJournal(ctx).missingInJournal.length, 0);
    assert.equal(repairJournal(ctx), 0);
    // queued print jobs were committed with the bill and survive for the restart
    assert.equal(get<{ n: number }>(ctx.db, "SELECT count(*) n FROM print_job WHERE status='QUEUED'")!.n, 2); // receipt + one kitchen ticket
    ctx.db.close();
  } finally { env.cleanup(); }
});

test('four processes billing at once: 100 unique, gapless invoice numbers and exact totals', async () => {
  const env = makeEnv(); try {
    startShift(env);
    env.ctx.db.close();
    const runs = ['p1', 'p2', 'p3', 'p4'].map((tag) => new Promise<string[]>((resolve, reject) => {
      const c = spawn(process.execPath, [worker('bulk-worker.ts'), env.dir, '25', tag]);
      let out = '', err = '';
      c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (err += d));
      c.on('close', (code) => (code === 0 ? resolve(JSON.parse(out.trim().split('\n').pop()!)) : reject(new Error(`worker ${tag} exit ${code}: ${err}`))));
    }));
    const all4 = (await Promise.all(runs)).flat();
    assert.equal(new Set(all4).size, 100);
    const ctx = createCtx({ dataDir: env.dir, clock: env.clock, logger: silentLogger, scryptCost: 1024 });
    const seqs = all<{ seq_no: number }>(ctx.db, 'SELECT seq_no FROM invoice ORDER BY seq_no').map((r) => r.seq_no);
    assert.deepEqual(seqs, Array.from({ length: 100 }, (_, i) => i + 1));
    const s = get<{ invoices: number; sales_total: number; cash: number }>(ctx.db, 'SELECT * FROM daily_summary')!;
    assert.deepEqual([s.invoices, s.sales_total, s.cash], [100, 490000, 490000]);
    const j = readJournal(ctx.journalDir);
    assert.equal(j.malformed, 0);
    assert.equal(j.entries.filter((e) => e.type === 'invoice').length, 100);
    assert.equal(verifyJournal(ctx).missingInJournal.length, 0);
    assert.equal(get<{ n: number }>(ctx.db, 'SELECT count(*) n FROM audit_log')!.n > 100, true);
    ctx.db.close();
  } finally { env.cleanup(); }
});
