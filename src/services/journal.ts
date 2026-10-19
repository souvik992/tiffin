import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { all, get, run, tx } from '../store/db.ts';
import type { Ctx } from './ctx.ts';
import { istDay } from '../core/numbering.ts';
import { loadInvoiceFull } from './invoiceView.ts';
import type { InvoiceFull } from './invoiceView.ts';
import { insertCorrection, insertInvoice } from './invoiceStore.ts';
import type { InvoiceRecord, LineRecord, PaymentCorrectionRecord, PaymentRecord } from './invoiceStore.ts';
import { emit } from './outbox.ts';
import { recomputeDailySummary } from './reports.ts';
import { applyStockEntry, insertMissingMovements, movementsForRef, recomputeStockBalances } from './stock.ts';
import type { MovementRecord, PurchaseLineRecord, PurchaseRecord, StockItemSnapshot } from './stock.ts';

/**
 * Daily bill journal: one readable JSON line per event, fsynced, stored OUTSIDE the database.
 * If the database is ever lost or damaged, restore the last backup and replay the journal.
 */
export type JournalEntry =
  | { v: 1; type: 'invoice'; at: number; full: InvoiceFull; stock?: MovementRecord[] }
  | { v: 1; type: 'cancel'; at: number; invoiceId: string; reason: string; cancelledBy: string; stock?: MovementRecord[] }
  | { v: 1; type: 'shift_open'; at: number; shift: { id: string; deviceId: string; userId: string; openedAt: number; openingCash: number } }
  | { v: 1; type: 'shift_close'; at: number; shiftId: string; closedBy: string; expectedCash: number; countedCash: number }
  | { v: 1; type: 'payment_correction'; at: number; correction: PaymentCorrectionRecord; deviceId: string; issuedAt: number }
  | { v: 1; type: 'stock'; at: number; items: StockItemSnapshot[]; movements: MovementRecord[]; purchase?: { purchase: PurchaseRecord; lines: PurchaseLineRecord[] }; voidPurchase?: { purchaseId: string; voidedBy: string; reason: string } };

export function appendJournal(ctx: Ctx, entry: JournalEntry): void {
  mkdirSync(ctx.journalDir, { recursive: true });
  const file = join(ctx.journalDir, `${istDay(entry.at)}.ndjson`);
  const fd = openSync(file, 'a');
  try {
    writeSync(fd, JSON.stringify(entry) + '\n');
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

export function readJournal(dir: string): { entries: JournalEntry[]; malformed: number } {
  const entries: JournalEntry[] = [];
  let malformed = 0;
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.ndjson') || f.endsWith('.ndjson.gz')).sort(); } catch { return { entries, malformed }; }
  for (const f of files) {
    let text: string;
    try {
      const raw = readFileSync(join(dir, f));
      text = f.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
    } catch { malformed++; continue; } // an unreadable day file is reported, not fatal
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line) as JournalEntry); } catch { malformed++; } // a torn last line after power loss is ignored
    }
  }
  entries.sort((a, b) => a.at - b.at);
  return { entries, malformed };
}

/**
 * Journal files are about 2.5 KB per bill raw but about 130 bytes gzipped. Days older than `keepDays`
 * are compressed (written to a temp file, fsynced, renamed, then the original removed), so a crash
 * mid-compaction never loses a day.
 */
export function compactJournal(ctx: Ctx, keepDays = 2): { compressed: number; savedBytes: number } {
  const cutoff = istDay(ctx.clock.now() - keepDays * 86_400_000);
  let compressed = 0, savedBytes = 0;
  let files: string[] = [];
  try { files = readdirSync(ctx.journalDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(f)); } catch { return { compressed, savedBytes }; }
  for (const f of files) {
    if (f.slice(0, 10) >= cutoff) continue;
    const src = join(ctx.journalDir, f), dst = src + '.gz', tmp = dst + '.tmp';
    const raw = readFileSync(src);
    const gz = gzipSync(raw, { level: 9 });
    const fd = openSync(tmp, 'w');
    try { writeSync(fd, gz); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, dst);
    if (gunzipSync(readFileSync(dst)).length !== raw.length) { unlinkSync(dst); continue; } // verify before deleting the original
    unlinkSync(src);
    compressed++; savedBytes += raw.length - gz.length;
  }
  return { compressed, savedBytes };
}

export function verifyJournal(ctx: Ctx) {
  const { entries, malformed } = readJournal(ctx.journalDir);
  const inJournal = new Set(entries.filter((e): e is Extract<JournalEntry, { type: 'invoice' }> => e.type === 'invoice').map((e) => e.full.invoice.id));
  const inDb = new Set(all<{ id: string }>(ctx.db, 'SELECT id FROM invoice').map((r) => r.id));
  return {
    journalInvoices: inJournal.size, dbInvoices: inDb.size, malformedLines: malformed,
    missingInJournal: [...inDb].filter((id) => !inJournal.has(id)),
    missingInDb: [...inJournal].filter((id) => !inDb.has(id)),
  };
}

/** Appends journal entries for invoices that are in the database but not in the journal (e.g. a crash after commit). */
export function repairJournal(ctx: Ctx): number {
  const v = verifyJournal(ctx);
  for (const id of v.missingInJournal) {
    const full = loadInvoiceFull(ctx, id);
    appendJournal(ctx, { v: 1, type: 'invoice', at: full.invoice.issuedAt, full, stock: movementsForRef(ctx, 'invoice', id, 'SALE') });
  }
  return v.missingInJournal.length;
}

export interface ReplayResult { replayed: number; skipped: number; errors: Array<{ type: string; id: string; message: string }> }

/**
 * Replays journal entries missing from the database (restore the latest backup first, then replay).
 * Each entry is applied in its own transaction so one bad entry cannot block the rest.
 */
export function replayJournal(ctx: Ctx): ReplayResult {
  const { entries } = readJournal(ctx.journalDir);
  const res: ReplayResult = { replayed: 0, skipped: 0, errors: [] };
  for (const e of entries) {
    try {
      const applied = tx(ctx.db, () => applyEntry(ctx, e));
      if (applied) res.replayed++; else res.skipped++;
    } catch (err) {
      const id = e.type === 'invoice' ? e.full.invoice.id : e.type === 'cancel' ? e.invoiceId : e.type === 'shift_open' ? e.shift.id : e.type === 'stock' ? (e.purchase?.purchase.id ?? e.voidPurchase?.purchaseId ?? e.movements[0]?.id ?? e.items[0]?.id ?? '') : e.type === 'payment_correction' ? e.correction.id : e.shiftId;
      res.errors.push({ type: e.type, id, message: (err as Error).message });
    }
  }
  if (res.replayed > 0) { recomputeDailySummary(ctx); recomputeStockBalances(ctx); }
  return res;
}

function applyEntry(ctx: Ctx, e: JournalEntry): boolean {
  if (e.type === 'shift_open') {
    if (get(ctx.db, 'SELECT 1 FROM shift WHERE id = ?', e.shift.id)) return false;
    run(ctx.db, 'INSERT INTO shift(id, device_id, user_id, opened_at, opening_cash) VALUES (?,?,?,?,?)', e.shift.id, e.shift.deviceId, e.shift.userId, e.shift.openedAt, e.shift.openingCash);
    return true;
  }
  if (e.type === 'shift_close') {
    const r = run(ctx.db, 'UPDATE shift SET closed_at = ?, closed_by = ?, expected_cash = ?, counted_cash = ? WHERE id = ? AND closed_at IS NULL', e.at, e.closedBy, e.expectedCash, e.countedCash, e.shiftId);
    return Number(r.changes) === 1;
  }
  if (e.type === 'stock') return applyStockEntry(ctx, e);
  if (e.type === 'payment_correction') {
    if (get(ctx.db, 'SELECT 1 FROM payment_correction WHERE id = ?', e.correction.id)) return false;
    if (!get(ctx.db, 'SELECT 1 FROM payment WHERE id = ?', e.correction.paymentId)) throw new Error('the corrected payment is missing');
    insertCorrection(ctx, { ...e.correction, shiftId: e.correction.shiftId && get(ctx.db, 'SELECT 1 FROM shift WHERE id = ?', e.correction.shiftId) ? e.correction.shiftId : null }, e.deviceId, e.issuedAt);
    return true;
  }
  if (e.type === 'cancel') {
    const r = run(ctx.db, "UPDATE invoice SET status = 'CANCELLED', cancel_reason = ?, cancelled_at = ?, cancelled_by = ? WHERE id = ? AND status = 'ISSUED'", e.reason, e.at, e.cancelledBy, e.invoiceId);
    const moved = insertMissingMovements(ctx, e.stock ?? []);
    return Number(r.changes) === 1 || moved;
  }
  const { invoice: iv, lines, payments } = e.full;
  if (get(ctx.db, 'SELECT 1 FROM invoice WHERE id = ?', iv.id)) return insertMissingMovements(ctx, e.stock ?? []);
  const shiftOk = iv.shiftId && get(ctx.db, 'SELECT 1 FROM shift WHERE id = ?', iv.shiftId) ? iv.shiftId : null;
  if (!get(ctx.db, 'SELECT 1 FROM sale_order WHERE id = ?', iv.orderId)) {
    run(ctx.db, "INSERT INTO sale_order(id, device_id, channel, token_no, status, created_by, created_at, updated_at) VALUES (?,?,?,?, 'INVOICED', ?,?,?)",
      iv.orderId, iv.deviceId, e.full.orderChannel, iv.tokenNo, iv.createdBy, iv.issuedAt, iv.issuedAt);
  }
  const [prefix, fy] = iv.invoiceNo.split('/');
  let series = get<{ id: string }>(ctx.db, 'SELECT id FROM invoice_series WHERE device_id = ? AND doc_type = ? AND fy = ?', iv.deviceId, iv.docType, fy!);
  if (!series) {
    run(ctx.db, 'INSERT INTO invoice_series(id, device_id, doc_type, fy, prefix, next_no) VALUES (?,?,?,?,?,1)', iv.seriesId, iv.deviceId, iv.docType, fy!, prefix!);
    series = { id: iv.seriesId };
  }
  const rec: InvoiceRecord = { ...iv, seriesId: series.id, shiftId: shiftOk };
  const lrecs: LineRecord[] = lines.map((l) => ({ ...l }));
  const precs: PaymentRecord[] = payments.map((p) => ({ ...p, mode: p.originalMode ?? p.mode, reference: p.originalMode ? p.originalReference ?? null : p.reference, shiftId: p.shiftId && shiftOk ? p.shiftId : null }));
  insertInvoice(ctx, rec, lrecs, precs);
  run(ctx.db, 'UPDATE invoice_series SET next_no = max(next_no, ?) WHERE id = ?', iv.seqNo + 1, series.id);
  if (iv.docType === 'TAX_INVOICE') run(ctx.db, "UPDATE sale_order SET status = 'INVOICED' WHERE id = ? AND status <> 'INVOICED'", iv.orderId);
  if (iv.status === 'CANCELLED') run(ctx.db, "UPDATE invoice SET status = 'CANCELLED' WHERE id = ?", iv.id);
  emit(ctx, 'invoice', iv.id, 'upsert', { id: iv.id, invoiceNo: iv.invoiceNo, grandTotal: iv.grandTotal, replayed: true });
  insertMissingMovements(ctx, e.stock ?? []);
  return true;
}
