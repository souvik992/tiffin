import { quickCheck, AppError } from './store/db.ts';
import { platformTextRenderer } from './services/printing/textRender.ts';
import { pruneSessions } from './services/auth.ts';
import type { Ctx } from './services/ctx.ts';
import { pruneCommandLog } from './services/commands.ts';
import { compactJournal, repairJournal } from './services/journal.ts';
import { DEFAULT_BACKOFF, PrintQueue } from './services/printing/queue.ts';
import { FileTransport, MemoryTransport, TcpTransport } from './services/printing/transports.ts';
import { SpoolerTransport } from './services/printing/spooler.ts';
import { SerialTransport } from './services/printing/serial.ts';
import { UsbTransport } from './services/printing/usb.ts';
import { join } from 'node:path';
import { runBackup } from './services/backup.ts';
import { pruneImages } from './services/images.ts';
import { AndroidTransport } from './services/printing/android.ts';

export function defaultQueue(ctx: Ctx): PrintQueue {
  return new PrintQueue(ctx, { memory: new MemoryTransport(), tcp: new TcpTransport(), file: new FileTransport(join(ctx.dataDir, 'print-files')), spooler: new SpoolerTransport(), serial: new SerialTransport(), usb: new UsbTransport(), android: new AndroidTransport() }, DEFAULT_BACKOFF, platformTextRenderer());
}

/** Runs once at startup. A failed integrity check refuses to start rather than risk billing on a damaged database. */
export function startupChecks(ctx: Ctx, queue: PrintQueue) {
  const q = quickCheck(ctx.db);
  if (!q.ok) throw new AppError('DB_CORRUPT', `The database failed its integrity check: ${q.messages.slice(0, 3).join('; ')}. Restore the latest backup, then replay the journal.`, 500);
  const requeued = queue.recoverOnStartup();
  const journalRepaired = repairJournal(ctx);
  const pruned = pruneCommandLog(ctx, ctx.clock.now() - 7 * 86_400_000);
  const journal = compactJournal(ctx);
  const imagesPruned = pruneImages(ctx);
  pruneSessions(ctx);
  ctx.logger.info('startup checks passed', { requeued, journalRepaired, pruned, journalCompressed: journal.compressed, imagesPruned });
  return { requeued, journalRepaired, pruned, journalCompressed: journal.compressed };
}

/** Hourly rolling backups plus a daily one. Failures are logged and surface as a health warning. */
export function scheduleBackups(ctx: Ctx): () => void {
  const t = setInterval(() => {
    const hour = new Date(ctx.clock.now()).getUTCHours();
    void runBackup(ctx, 'hourly').catch((e) => ctx.logger.error('hourly backup failed', String(e)));
    if (hour === 21) { // ~02:30 IST
      void runBackup(ctx, 'daily').catch((e) => ctx.logger.error('daily backup failed', String(e)));
      try { compactJournal(ctx); } catch (e) { ctx.logger.error('journal compaction failed', String(e)); }
    }
  }, 3_600_000);
  t.unref();
  return () => clearInterval(t);
}
