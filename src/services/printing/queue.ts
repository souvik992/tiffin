import { all, get, run, AppError } from '../../store/db.ts';
import type { Actor, Ctx } from '../ctx.ts';
import { assertPerm } from '../permissions.ts';
import { audit } from '../audit.ts';
import type { PrinterRow, Transport } from './transports.ts';

interface JobRow { id: string; kind: string; printer_id: string; payload: Uint8Array; attempts: number; dedupe_key: string | null }

export const DEFAULT_BACKOFF = [1000, 3000, 10000];

/**
 * Persistent print queue. Jobs live in SQLite, so a crash or restart never loses a receipt.
 * One strict in-order lane per printer; failures back off (1s, 3s, 10s) then become FAILED
 * (a one-click retry is offered in the UI). Printing never blocks billing.
 */
export class PrintQueue {
  private ctx: Ctx;
  private transports: Partial<Record<PrinterRow['transport'], Transport>>;
  private backoff: number[];
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(ctx: Ctx, transports: Partial<Record<PrinterRow['transport'], Transport>>, backoff: number[] = DEFAULT_BACKOFF) {
    this.ctx = ctx; this.transports = transports; this.backoff = backoff;
  }

  /** Jobs interrupted mid-send by a crash go back to the queue. */
  recoverOnStartup(): number {
    return Number(run(this.ctx.db, "UPDATE print_job SET status = 'QUEUED', updated_at = ? WHERE status = 'SENDING'", this.ctx.clock.now()).changes);
  }

  start(intervalMs = 1000): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.processDue().catch((e) => this.ctx.logger.error('print loop failed', String(e))); }, intervalMs);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async processDue(): Promise<{ printed: number; failed: number; retried: number }> {
    if (this.running) return { printed: 0, failed: 0, retried: 0 };
    this.running = true;
    const tally = { printed: 0, failed: 0, retried: 0 };
    try {
      const printers = all<PrinterRow>(this.ctx.db, "SELECT * FROM printer WHERE active = 1 AND id IN (SELECT DISTINCT printer_id FROM print_job WHERE status = 'QUEUED')");
      await Promise.all(printers.map((p) => this.drain(p, tally)));
    } finally { this.running = false; }
    return tally;
  }

  private async drain(printer: PrinterRow, tally: { printed: number; failed: number; retried: number }): Promise<void> {
    for (;;) {
      const job = get<JobRow & { next_attempt_at: number }>(this.ctx.db,
        "SELECT id, kind, printer_id, payload, attempts, dedupe_key, next_attempt_at FROM print_job WHERE printer_id = ? AND status = 'QUEUED' ORDER BY created_at, rowid LIMIT 1", printer.id);
      if (!job || job.next_attempt_at > this.ctx.clock.now()) return; // strict order: wait for the head job
      run(this.ctx.db, "UPDATE print_job SET status = 'SENDING', updated_at = ? WHERE id = ?", this.ctx.clock.now(), job.id);
      try {
        const t = this.transports[printer.transport];
        if (!t) throw new Error(`no transport for "${printer.transport}"`);
        await t.send(printer, job.payload); // transports chunk by printer profile to protect small buffers
        run(this.ctx.db, "UPDATE print_job SET status = 'PRINTED', last_error = NULL, updated_at = ? WHERE id = ?", this.ctx.clock.now(), job.id);
        this.ctx.events.emit('print', { jobId: job.id, printerId: printer.id, kind: job.kind, status: 'PRINTED' });
        tally.printed++;
      } catch (e) {
        const attempts = job.attempts + 1;
        const err = String((e as Error).message ?? e).slice(0, 300);
        if (attempts > this.backoff.length) {
          run(this.ctx.db, "UPDATE print_job SET status = 'FAILED', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?", attempts, err, this.ctx.clock.now(), job.id);
          this.ctx.events.emit('print', { jobId: job.id, printerId: printer.id, kind: job.kind, status: 'FAILED', error: err });
          tally.failed++;
          continue; // later jobs may still print; the failed one can be retried from the UI
        }
        const next = this.ctx.clock.now() + this.backoff[attempts - 1]!;
        run(this.ctx.db, "UPDATE print_job SET status = 'QUEUED', attempts = ?, last_error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?", attempts, err, next, this.ctx.clock.now(), job.id);
        this.ctx.events.emit('print', { jobId: job.id, printerId: printer.id, kind: job.kind, status: 'RETRYING', error: err, nextAttemptAt: next });
        tally.retried++;
        return;
      }
    }
  }

  retry(jobId: string): void {
    const p = get<{ active: number }>(this.ctx.db, 'SELECT p.active FROM print_job j JOIN printer p ON p.id = j.printer_id WHERE j.id = ?', jobId);
    if (p && p.active === 0) throw new AppError('PRINTER_OFF', 'That printer is turned off in settings. Turn it on, or reprint the bill on another printer.', 409);
    const r = run(this.ctx.db, "UPDATE print_job SET status = 'QUEUED', attempts = 0, next_attempt_at = 0, last_error = NULL, updated_at = ? WHERE id = ? AND status = 'FAILED'", this.ctx.clock.now(), jobId);
    if (Number(r.changes) === 0) throw new AppError('NOT_FOUND', 'No failed print job with that id.', 404);
  }
}

/** Jobs with the bill number, token and printer name, so a cashier knows which bill did not print. */
export function listJobs(ctx: Ctx, status?: string, limit = 100) {
  const cols = `j.id, j.kind, j.ref_id AS refId, j.printer_id AS printerId, p.name AS printerName, i.invoice_no AS invoiceNo, i.token_no AS tokenNo,
    j.status, j.attempts, j.last_error AS lastError, j.created_at AS createdAt
    FROM print_job j JOIN printer p ON p.id = j.printer_id LEFT JOIN invoice i ON i.id = j.ref_id`;
  const rows = status
    ? all<JobListRow>(ctx.db, `SELECT ${cols} WHERE j.status = ? ORDER BY j.created_at DESC LIMIT ?`, status, limit)
    : all<JobListRow>(ctx.db, `SELECT ${cols} ORDER BY j.created_at DESC LIMIT ?`, limit);
  return rows;
}
export interface JobListRow { id: string; kind: string; refId: string | null; printerId: string; printerName: string; invoiceNo: string | null; tokenNo: number | null; status: string; attempts: number; lastError: string | null; createdAt: number }

export function queueCounts(ctx: Ctx) {
  const rows = all<{ status: string; n: number }>(ctx.db, 'SELECT status, count(*) n FROM print_job GROUP BY status');
  const out: Record<string, number> = { QUEUED: 0, SENDING: 0, PRINTED: 0, FAILED: 0 };
  for (const r of rows) out[r.status] = r.n;
  return out;
}

/** Puts every failed job of one printer back in the queue (after fixing paper, cable or power). */
export function retryFailed(ctx: Ctx, actor: Actor, printerId: string): { printerId: string; requeued: number } {
  assertPerm(actor, 'print.read');
  const p = get<{ active: number }>(ctx.db, 'SELECT active FROM printer WHERE id = ?', printerId);
  if (!p) throw new AppError('NOT_FOUND', 'Printer not found.', 404);
  if (p.active !== 1) throw new AppError('PRINTER_OFF', 'That printer is turned off in settings. Turn it on first.', 409);
  const n = Number(run(ctx.db, "UPDATE print_job SET status = 'QUEUED', attempts = 0, next_attempt_at = 0, last_error = NULL, updated_at = ? WHERE printer_id = ? AND status = 'FAILED'", ctx.clock.now(), printerId).changes);
  audit(ctx, actor.userId, 'print.retry_failed', 'printer', printerId, { requeued: n });
  return { printerId, requeued: n };
}
