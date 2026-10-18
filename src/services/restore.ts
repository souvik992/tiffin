import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { all, openDb, AppError } from '../store/db.ts';
import { createCtx, silentLogger } from './ctx.ts';
import type { Ctx, Logger } from './ctx.ts';
import { referencedImages, restoreBackup, verifyBackup } from './backup.ts';
import { replayJournal } from './journal.ts';
import { verifyStock } from './stock.ts';
import { imagesDir } from './images.ts';

/**
 * Restoring a backup (Settings > Backups, or `npm run restore`).
 *
 * The screen never swaps the database under the running POS. It *stages* the chosen backup (checked, copied into
 * <data>/restore/stage with the photos it needs), then the POS restarts itself and applies it before opening the
 * database (`applyPendingRestore`, called by startBackend). Applying:
 *   1. checks the backup again; nothing is changed if it is not usable;
 *   2. moves the current database aside to <data>/pre-restore-<time>/ (never deleted);
 *   3. copies the backup in, with its photos;
 *   4. replays the bill journal, so bills made on this device after the backup come back (numbering continues).
 *      If the current database belongs to another shop or device (no device in common with the backup, e.g. restoring
 *      an old PC's backup onto a new PC that was set up first), its journal is moved aside too and not replayed.
 * If anything fails, the previous database (and journal) are put back and the shop is no worse off.
 */

export interface RestoreReport {
  version: number;
  images: { referenced: number; restored: number; alreadyPresent: number; missing: string[] };
  journal: { replayed: number; skipped: number; errors: Array<{ type: string; id: string; message: string }>; keptAside: boolean };
  stockOk: boolean;
  aside: string | null;
}

export interface LastRestore { ok: boolean; at: number; label: string; report?: RestoreReport; error?: string }

const stageDir = (dataDir: string) => join(dataDir, 'restore', 'stage');
const lastFile = (dataDir: string) => join(dataDir, 'restore', 'last.json');

function deviceIds(dbFile: string): string[] | null {
  try {
    const db = openDb(dbFile, { readOnly: true, skipMigrate: true });
    try { return all<{ id: string }>(db, 'SELECT id FROM device').map((r) => r.id); } finally { db.close(); }
  } catch { return null; } // unreadable (e.g. damaged): treated as this shop's own database
  finally { for (const s of ['-wal', '-shm']) { try { unlinkSync(dbFile + s); } catch { /* none */ } } }
}

/** Restores `backupFile` into dataDir (the POS must not have the database open). See the comment at the top. */
export function performRestore(dataDir: string, backupFile: string, logger: Logger = silentLogger): RestoreReport {
  const dbPath = join(dataDir, 'pos.db'), journalDir = join(dataDir, 'journal');
  const v = verifyBackup(backupFile);
  if (!v.ok) throw new AppError('BACKUP_INVALID', `This backup is not usable: ${v.messages.join('; ') || 'it failed its integrity check'}. Nothing was changed.`, 422);

  // Is the current database the same shop as the backup? Only then does this device's journal belong to it.
  const current = existsSync(dbPath) ? deviceIds(dbPath) : null;
  const incoming = deviceIds(backupFile) ?? [];
  const foreign = current !== null && current.length > 0 && !current.some((id) => incoming.includes(id));

  const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
  const aside = join(dataDir, `pre-restore-${stamp}`);
  let moved = false, journalMoved = false;
  for (const suffix of ['', '-wal', '-shm']) {
    if (!existsSync(dbPath + suffix)) continue;
    mkdirSync(aside, { recursive: true });
    renameSync(dbPath + suffix, join(aside, 'pos.db' + suffix));
    moved = true;
  }
  if (foreign && existsSync(journalDir)) { mkdirSync(aside, { recursive: true }); renameSync(journalDir, join(aside, 'journal')); journalMoved = true; }

  try {
    const r = restoreBackup(backupFile, dbPath);
    const ctx = createCtx({ dataDir, logger });
    try {
      const rep = foreign ? { replayed: 0, skipped: 0, errors: [] } : replayJournal(ctx);
      const st = verifyStock(ctx);
      return { version: r.version, images: r.images, journal: { ...rep, keptAside: journalMoved }, stockOk: st.ok, aside: moved || journalMoved ? aside : null };
    } finally { ctx.db.close(); }
  } catch (e) {
    // Put the previous database (and journal) back.
    for (const suffix of ['-wal', '-shm', '']) { try { if (existsSync(dbPath + suffix)) renameSync(dbPath + suffix, join(aside, `failed-restore.pos.db${suffix}`)); } catch { /* keep going */ } }
    for (const suffix of ['', '-wal', '-shm']) { try { if (existsSync(join(aside, 'pos.db' + suffix))) renameSync(join(aside, 'pos.db' + suffix), dbPath + suffix); } catch { /* keep going */ } }
    if (journalMoved) { try { if (!existsSync(journalDir)) renameSync(join(aside, 'journal'), journalDir); } catch { /* keep going */ } }
    logger.error('restore failed; the previous database was put back', String((e as Error).message ?? e));
    throw e instanceof AppError ? e : new AppError('RESTORE_FAILED', `Restore failed: ${String((e as Error).message ?? e)}. The previous database was put back.`, 500);
  }
}

const fingerprintOk = (path: string, name: string): boolean => {
  try { return createHash('sha256').update(readFileSync(path)).digest('hex') === name.slice(0, 64); } catch { return false; }
};

/** A fresh, empty staging folder for a restore (also where an online backup is downloaded to). */
export function newStage(ctx: Ctx): string {
  const d = stageDir(ctx.dataDir);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(join(d, 'images'), { recursive: true });
  return d;
}

/**
 * Stages a backup for restore at the next start: checks it, copies it (and the photos this POS does not have) into the
 * staging folder, and records the request. `stagedFile` skips the copy when the backup is already in the stage.
 */
export function stageRestore(ctx: Ctx, backupFile: string, label: string, by: string): { label: string; at: number } {
  const v = verifyBackup(backupFile);
  for (const s of ['-wal', '-shm']) { try { unlinkSync(backupFile + s); } catch { /* none */ } }
  if (!v.ok) throw new AppError('BACKUP_INVALID', `This backup is not usable: ${v.messages.join('; ') || 'it failed its integrity check'}. Choose another one.`, 422);
  const d = stageDir(ctx.dataDir);
  const staged = join(d, 'backup.db');
  if (backupFile !== staged) {
    newStage(ctx);
    copyFileSync(backupFile, `${staged}.tmp`);
    renameSync(`${staged}.tmp`, staged);
    const from = join(dirname(backupFile), 'images');
    for (const n of referencedImages(staged)) {
      if (fingerprintOk(join(imagesDir(ctx), n), n) || !fingerprintOk(join(from, n), n)) continue; // already here, or missing (reported after the restore)
      copyFileSync(join(from, n), join(d, 'images', n));
    }
  }
  const at = ctx.clock.now();
  writeFileSync(join(d, 'pending.json'), JSON.stringify({ label, at, by, source: basename(backupFile) }));
  return { label, at };
}

/** Called before the database is opened: applies a staged restore, if any, and records the outcome for the screen. */
export function applyPendingRestore(dataDir: string, logger: Logger = silentLogger): LastRestore | null {
  const d = stageDir(dataDir);
  const pendingFile = join(d, 'pending.json');
  if (!existsSync(pendingFile)) return null;
  let label = 'backup';
  let out: LastRestore;
  try {
    label = String((JSON.parse(readFileSync(pendingFile, 'utf8')) as { label?: string }).label ?? label);
    const report = performRestore(dataDir, join(d, 'backup.db'), logger);
    out = { ok: true, at: Date.now(), label, report };
    logger.info('backup restored', { label, replayed: report.journal.replayed });
  } catch (e) {
    out = { ok: false, at: Date.now(), label, error: String((e as Error).message ?? e) };
  }
  // Never try the same restore twice (a restore that fails at every start would keep the POS from opening).
  rmSync(d, { recursive: true, force: true });
  mkdirSync(dirname(lastFile(dataDir)), { recursive: true });
  writeFileSync(lastFile(dataDir), JSON.stringify(out));
  return out;
}

/** The last restore's outcome, shown once on the Backups screen. */
export function lastRestore(ctx: Ctx): LastRestore | null {
  try { return JSON.parse(readFileSync(lastFile(ctx.dataDir), 'utf8')) as LastRestore; } catch { return null; }
}
export function dismissLastRestore(ctx: Ctx): void { try { unlinkSync(lastFile(ctx.dataDir)); } catch { /* none */ } }
