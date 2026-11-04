import { DatabaseSync, backup } from 'node:sqlite';
import { existsSync, lstatSync, mkdirSync, rmdirSync, rmSync, readdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createCtx } from '../services/ctx.ts';
import type { Ctx, Logger } from '../services/ctx.ts';
import { AppError, currentSchemaVersion, get, openDb, quickCheck } from '../store/db.ts';
import { SCHEMA_VERSION } from '../store/schema.ts';

/**
 * Where Tiffin Data Manager reads from (see docs/DECISIONS.md, "Data Manager").
 *
 * - **live**: the data folder itself, opened like the POS opens it. Only when the POS is closed and the data is at
 *   exactly this app's schema, so opening it never upgrades the shop's database behind an older POS.
 * - **snapshot**: a private copy taken with SQLite's backup API (safe while the POS is billing), upgraded in the copy
 *   if it is older. Always view only: nothing typed here can reach the shop's data.
 */
export type Want = { origin: 'data' } | { origin: 'folder'; path: string } | { origin: 'file'; path: string };

export interface Source {
  kind: 'live' | 'snapshot';
  want: Want;
  /** the shop's data folder (data/folder), or the backup file (file) */
  path: string;
  /** the database read from */
  dbFile: string;
  /** the folder its photos are in */
  imagesFrom: string;
  ctx: Ctx;
  schema: number;
  store: string | null;
  /** why changes are not possible (null: live) */
  viewOnly: string | null;
  /** snapshot work folder, removed on close */
  work: string | null;
}

export const VIEW_ONLY = {
  posOpen: 'Tiffin POS is open on this computer, so this is a copy taken just now and you can only look. Close the POS to make changes or restore a backup.',
  older: 'This data was last opened by an older Tiffin POS. You can look at everything; to make changes here, update Tiffin POS on this computer and open it once.',
  file: 'This is a backup file: you can look at everything in it. To bring it back into the shop, open "This computer\'s POS data" and restore it on the Backups page.',
};

/** Schema version of a database file, without changing it (and without leaving -wal/-shm files that were not there). */
export function schemaOf(dbFile: string): number {
  return withReadOnly(dbFile, (db) => {
    const q = quickCheck(db);
    if (!q.ok) throw new AppError('DATA_DAMAGED', `This database failed its check (${q.messages.slice(0, 2).join('; ')}). Restore a backup.`, 422);
    return currentSchemaVersion(db);
  });
}

function withReadOnly<T>(dbFile: string, fn: (db: DatabaseSync) => T): T {
  const had = ['-wal', '-shm'].filter((s) => existsSync(dbFile + s));
  let db: DatabaseSync;
  try { db = openDb(dbFile, { readOnly: true, skipMigrate: true }); } catch (e) {
    throw new AppError('DATA_UNREADABLE', `This file cannot be read as Tiffin POS data: ${String((e as Error).message ?? e)}`, 422);
  }
  try { return fn(db); } finally {
    db.close();
    for (const s of ['-wal', '-shm']) if (!had.includes(s)) { try { unlinkSync(dbFile + s); } catch { /* none */ } }
  }
}

/** A consistent copy of a database that another program (the POS) may be writing to. */
export async function snapshotDb(dbFile: string, dest: string): Promise<void> {
  const had = ['-wal', '-shm'].filter((s) => existsSync(dbFile + s));
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    await backup(db, dest);
  } finally {
    db.close();
    for (const s of ['-wal', '-shm']) if (!had.includes(s)) { try { unlinkSync(dbFile + s); } catch { /* none */ } }
  }
}

const storeName = (ctx: Ctx) => get<{ name: string }>(ctx.db, 'SELECT name FROM outlet ORDER BY rowid LIMIT 1')?.name ?? null;

/** Removes a folder link (junction) without ever touching what it points to. */
function removeLink(p: string): void {
  try { if (!lstatSync(p).isSymbolicLink()) return; } catch { return; }
  try { unlinkSync(p); } catch { rmdirSync(p); } // rmdir of a junction removes the link only (it is never recursive here)
}

/** Deletes a snapshot work folder: its photo link first, so the shop's photos can never be reached by the delete. */
export function removeWork(work: string): void {
  removeLink(join(work, 'images'));
  if (existsSync(join(work, 'images')) && lstatSync(join(work, 'images')).isSymbolicLink()) throw new Error('photo link still present');
  rmSync(work, { recursive: true, force: true });
}

/** Clears snapshot folders left by a crash. */
export function clearOldSnapshots(home: string): void {
  const dir = join(home, 'snapshots');
  if (!existsSync(dir)) return;
  for (const n of readdirSync(dir)) { try { removeWork(join(dir, n)); } catch { /* next start */ } }
}

export interface OpenOptions { home: string; dataDir: string; posRunning: boolean; logger: Logger }

export async function openSource(want: Want, o: OpenOptions): Promise<Source> {
  const isFile = want.origin === 'file';
  const folder = want.origin === 'data' ? o.dataDir : want.path;
  const dbFile = isFile ? want.path : join(folder, 'pos.db');
  if (!existsSync(dbFile)) {
    throw want.origin === 'data'
      ? new AppError('NO_DATA', 'No Tiffin POS data was found on this computer. Open a data folder or a backup file (for example from a USB drive).', 404)
      : new AppError('NO_DATA', isFile ? 'That file is not there any more.' : 'That folder has no Tiffin POS data in it (no pos.db file).', 404);
  }
  const imagesFrom = join(isFile ? dirname(dbFile) : folder, 'images');
  const schema = schemaOf(dbFile);
  if (schema > SCHEMA_VERSION) throw new AppError('SCHEMA_TOO_NEW', 'This data comes from a newer Tiffin POS. Install the latest Tiffin Data Manager to open it.', 409);
  if (schema < 1) throw new AppError('DATA_UNREADABLE', 'This file is not Tiffin POS data.', 422);

  const viewOnly = isFile ? VIEW_ONLY.file : o.posRunning ? VIEW_ONLY.posOpen : schema < SCHEMA_VERSION ? VIEW_ONLY.older : null;
  if (!viewOnly) {
    const ctx = createCtx({ dataDir: folder, logger: o.logger }); // same schema: opening changes nothing
    return { kind: 'live', want, path: folder, dbFile, imagesFrom, ctx, schema, store: storeName(ctx), viewOnly: null, work: null };
  }

  const work = join(o.home, 'snapshots', `${Date.now()}-${process.pid}`);
  mkdirSync(work, { recursive: true });
  try {
    await snapshotDb(dbFile, join(work, 'pos.db'));
    // photos are read where they are, through a folder link (a junction needs no administrator on Windows)
    if (existsSync(imagesFrom)) symlinkSync(imagesFrom, join(work, 'images'), 'junction');
    const ctx = createCtx({ dataDir: work, logger: o.logger }); // upgrades the copy only
    return { kind: 'snapshot', want, path: isFile ? dbFile : folder, dbFile, imagesFrom, ctx, schema, store: storeName(ctx), viewOnly, work };
  } catch (e) {
    try { removeWork(work); } catch { /* next start */ }
    if (e instanceof AppError) throw e;
    throw new AppError('DATA_UNREADABLE', `This data could not be opened: ${String((e as Error).message ?? e)}`, 422);
  }
}

export function closeSource(s: Source): void {
  try { s.ctx.db.close(); } catch { /* closed */ }
  if (s.work) { try { removeWork(s.work); } catch { /* cleared at the next start */ } }
}
