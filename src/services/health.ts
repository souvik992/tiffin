import { statSync } from 'node:fs';
import { get } from '../store/db.ts';
import { SCHEMA_VERSION } from '../store/schema.ts';
import { currentSchemaVersion, quickCheck } from '../store/db.ts';
import type { Ctx } from './ctx.ts';
import { verifyAuditChain } from './audit.ts';
import { backupStatus } from './backup.ts';
import { freeDiskMb } from './disk.ts';
import { verifyJournal } from './journal.ts';
import { queueCounts } from './printing/queue.ts';
import { verifyStock } from './stock.ts';

export function getHealth(ctx: Ctx, opts: { deep?: boolean } = {}) {
  const size = (p: string) => { try { return statSync(p).size; } catch { return 0; } };
  const lastIssued = get<{ m: number | null }>(ctx.db, 'SELECT max(issued_at) m FROM invoice')?.m ?? null;
  const now = ctx.clock.now();
  const j = verifyJournal(ctx);
  const freeMb = freeDiskMb(ctx);
  const b = backupStatus(ctx);
  const clockWarning = lastIssued !== null && now < lastIssued - 60_000;
  const warnings: string[] = [];
  if (b.warn) warnings.push('No successful backup in the last 24 hours.');
  if (j.missingInJournal.length > 0) warnings.push(`${j.missingInJournal.length} invoice(s) are missing from the journal. Run journal repair.`);
  if (clockWarning) warnings.push('The system clock is earlier than the latest invoice. Check the date and time.');
  if (freeMb < 1024) warnings.push(`Low disk space: ${freeMb} MB free.`);
  const stock = opts.deep ? verifyStock(ctx) : undefined;
  if (stock && !stock.ok) warnings.push(`Stock balances differ from the stock ledger for ${stock.mismatches.length} item(s).`);
  const receiptPrinter = get(ctx.db, 'SELECT 1 FROM printer WHERE active = 1 AND is_receipt = 1 LIMIT 1');
  if (!receiptPrinter && get(ctx.db, 'SELECT 1 FROM outlet LIMIT 1')) warnings.push('No receipt printer is set up. Add one in Settings, Printers.');
  const print = queueCounts(ctx);
  if (print.FAILED > 0) warnings.push(`${print.FAILED} print job(s) failed.`);
  return {
    ok: warnings.length === 0,
    warnings,
    schemaVersion: currentSchemaVersion(ctx.db),
    appSchemaVersion: SCHEMA_VERSION,
    dbBytes: size(ctx.dbPath),
    walBytes: size(ctx.dbPath + '-wal'),
    freeDiskMb: freeMb,
    backup: b,
    journal: { invoices: j.journalInvoices, malformedLines: j.malformedLines, missingInJournal: j.missingInJournal.length },
    print,
    clockWarning,
    integrity: opts.deep ? { quickCheck: quickCheck(ctx.db), auditChain: verifyAuditChain(ctx.db), stock: stock! } : undefined,
  };
}
