import { backup } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { all, openDb, quickCheck, currentSchemaVersion, AppError } from '../store/db.ts';
import { IMAGE_FILE, imagesDir } from './images.ts';
import { SCHEMA_VERSION } from '../store/schema.ts';
import type { Ctx } from './ctx.ts';
import { getSetting, setSetting } from './settings.ts';

/** Opening a WAL-mode backup (even read-only) can leave -wal/-shm files; the .db itself is complete, so remove them. */
function removeSidecars(file: string): void {
  for (const suffix of ['-wal', '-shm']) { try { unlinkSync(file + suffix); } catch { /* none */ } }
}

export type BackupKind = 'hourly' | 'daily' | 'weekly' | 'close' | 'manual';
const KEEP: Record<BackupKind, number> = { hourly: 24, daily: 7, weekly: 4, close: 10, manual: 20 };

/** Opens a backup read-only and runs an integrity check. */
export function verifyBackup(file: string): { ok: boolean; version: number; messages: string[] } {
  let db;
  try {
    db = openDb(file, { readOnly: true, skipMigrate: true });
    const q = quickCheck(db);
    const version = currentSchemaVersion(db);
    return { ok: q.ok && version >= 1 && version <= SCHEMA_VERSION, version, messages: q.messages };
  } catch (e) {
    return { ok: false, version: 0, messages: [String((e as Error).message)] };
  } finally { try { db?.close(); } catch { /* ignore */ } }
}

// ---------- menu photos ----------
// Photos are files (never in the database), named by the SHA-256 of their bytes, so they never change.
// Each backup folder keeps one shared "images" store; a backup copies only photos the store does not have yet.

/** Photo names an (offline) database file refers to. Throws if the file cannot be read as a database. */
export function referencedImages(dbFile: string): string[] {
  const db = openDb(dbFile, { readOnly: true, skipMigrate: true });
  try {
    return all<{ f: string }>(db, 'SELECT DISTINCT image_file f FROM item WHERE image_file IS NOT NULL').map((r) => r.f).filter((n) => IMAGE_FILE.test(n)).sort();
  } finally { db.close(); removeSidecars(dbFile); }
}

const fingerprintOk = (path: string, name: string): boolean => {
  try { return createHash('sha256').update(readFileSync(path)).digest('hex') === name.slice(0, 64); } catch { return false; }
};

/** Copies a photo so a reader never sees half a file, then checks it against its name. */
function copyPhoto(src: string, dst: string, name: string): boolean {
  if (!fingerprintOk(src, name)) return false;
  const tmp = `${dst}.${process.pid}.tmp`;
  copyFileSync(src, tmp);
  renameSync(tmp, dst);
  return fingerprintOk(dst, name);
}

function backupImages(ctx: Ctx, backupFile: string, destDir: string) {
  const names = referencedImages(backupFile);
  const store = join(destDir, 'images');
  mkdirSync(store, { recursive: true });
  let copied = 0;
  const missing: string[] = [];
  for (const n of names) {
    const dst = join(store, n);
    if (fingerprintOk(dst, n)) continue;
    if (copyPhoto(join(imagesDir(ctx), n), dst, n)) copied++; else missing.push(n);
  }
  if (missing.length) ctx.logger.warn('backup: some menu photos are missing from the data folder', { missing: missing.length });
  return { referenced: names.length, copied, missing };
}

/**
 * Online backup using SQLite's backup API (never a raw file copy of a live database).
 * Every backup is verified; a backup that fails verification is deleted and reported.
 */
export async function runBackup(ctx: Ctx, kind: BackupKind = 'manual', destDir: string = ctx.backupDir) {
  const started = ctx.clock.now();
  const stamp = new Date(started).toISOString().replace(/[-:.]/g, '');
  const file = join(destDir, `${kind}-${stamp}.db`);
  await backup(ctx.db, file);
  const v = verifyBackup(file);
  removeSidecars(file);
  if (!v.ok) {
    try { unlinkSync(file); } catch { /* ignore */ }
    throw new AppError('BACKUP_FAILED', `Backup failed verification: ${v.messages.join('; ')}`, 500);
  }
  // Photos are copied after the database is safe; a missing photo is reported but never fails the backup of the bills.
  const images = backupImages(ctx, file, destDir);
  setSetting(ctx, 'last_backup_at', String(started));
  pruneBackups(destDir);
  return { file, bytes: statSync(file).size, verified: true, kind, images };
}

export function pruneBackups(dir: string): number {
  let removed = 0;
  const files = readdirSync(dir).filter((f) => f.endsWith('.db'));
  for (const kind of Object.keys(KEEP) as BackupKind[]) {
    const mine = files.filter((f) => f.startsWith(`${kind}-`)).sort().reverse();
    for (const f of mine.slice(KEEP[kind])) { unlinkSync(join(dir, f)); removeSidecars(join(dir, f)); removed++; }
  }
  const have = new Set(files);
  for (const f of readdirSync(dir)) { // sweep orphaned sidecars
    const m = /^(.*\.db)-(wal|shm)$/.exec(f);
    if (m && !have.has(m[1]!)) { try { unlinkSync(join(dir, f)); } catch { /* ignore */ } }
  }
  pruneBackupImages(dir);
  return removed;
}

/** Removes photos no remaining backup in this folder refers to. If any backup cannot be read, nothing is removed. */
export function pruneBackupImages(dir: string): number {
  const store = join(dir, 'images');
  if (!existsSync(store)) return 0;
  const used = new Set<string>();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.db'))) {
    try { for (const n of referencedImages(join(dir, f))) used.add(n); } catch { return 0; } // unreadable or still being written: keep everything
  }
  let removed = 0;
  for (const f of readdirSync(store)) {
    const stale = /\.\d+\.tmp$/.test(f) && Date.now() - statSync(join(store, f)).mtimeMs > 86_400_000;
    if (!stale && (!IMAGE_FILE.test(f) || used.has(f))) continue;
    try { unlinkSync(join(store, f)); removed++; } catch { /* in use */ }
  }
  return removed;
}

export function listBackups(dir: string) {
  return readdirSync(dir).filter((f) => f.endsWith('.db')).sort().reverse().map((f) => ({ file: f, bytes: statSync(join(dir, f)).size }));
}

export function backupStatus(ctx: Ctx) {
  const last = Number(getSetting(ctx, 'last_backup_at')) || null;
  const ageHours = last === null ? null : (ctx.clock.now() - last) / 3_600_000;
  return { lastBackupAt: last, ageHours, warn: last === null || (ageHours ?? 0) > 24 };
}

/**
 * Restores a verified backup to targetPath, then its menu photos into the images folder next to it.
 * The target database must not be open. Missing photos are reported, never fatal: the bills matter most.
 */
export function restoreBackup(backupFile: string, targetPath: string, opts: { force?: boolean } = {}) {
  const v = verifyBackup(backupFile);
  removeSidecars(backupFile);
  if (!v.ok) throw new AppError('BACKUP_INVALID', `This backup is not usable: ${v.messages.join('; ')}`, 422);
  if (existsSync(targetPath) && !opts.force) throw new AppError('TARGET_EXISTS', 'A database already exists at the target. Pass force to replace it.', 409);
  for (const suffix of ['-wal', '-shm']) { try { unlinkSync(targetPath + suffix); } catch { /* none */ } }
  copyFileSync(backupFile, targetPath);
  const names = referencedImages(backupFile);
  const from = join(dirname(backupFile), 'images'), to = join(dirname(targetPath), 'images');
  mkdirSync(to, { recursive: true });
  const images = { referenced: names.length, restored: 0, alreadyPresent: 0, missing: [] as string[] };
  for (const n of names) {
    if (fingerprintOk(join(to, n), n)) { images.alreadyPresent++; continue; }
    if (copyPhoto(join(from, n), join(to, n), n)) images.restored++; else images.missing.push(n);
  }
  return { file: backupFile, version: v.version, images };
}
