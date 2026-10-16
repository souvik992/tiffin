import { DatabaseSync } from 'node:sqlite';
import type { StatementSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { MIGRATIONS, SCHEMA_VERSION } from './schema.ts';

export class AppError extends Error {
  code: string;
  status: number;
  details?: unknown;
  afterRollback?: () => void;
  constructor(code: string, message: string, status = 400, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const stmtCache = new WeakMap<DatabaseSync, Map<string, StatementSync>>();
function stmt(db: DatabaseSync, sql: string): StatementSync {
  let m = stmtCache.get(db);
  if (!m) { m = new Map(); stmtCache.set(db, m); }
  let s = m.get(sql);
  if (!s) { s = db.prepare(sql); m.set(sql, s); }
  return s;
}
type Param = string | number | bigint | null | Uint8Array;
export function get<T>(db: DatabaseSync, sql: string, ...p: Param[]): T | undefined {
  return stmt(db, sql).get(...p) as T | undefined;
}
export function all<T>(db: DatabaseSync, sql: string, ...p: Param[]): T[] {
  return stmt(db, sql).all(...p) as T[];
}
export function run(db: DatabaseSync, sql: string, ...p: Param[]): { changes: number | bigint } {
  return stmt(db, sql).run(...p);
}

const depth = new WeakMap<DatabaseSync, number>();
/** Runs fn in a transaction (BEGIN IMMEDIATE). Nested calls use savepoints. */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  const d = depth.get(db) ?? 0;
  if (d > 0) {
    const sp = `sp${d}`;
    db.exec(`SAVEPOINT ${sp}`);
    depth.set(db, d + 1);
    try {
      const r = fn();
      db.exec(`RELEASE ${sp}`);
      return r;
    } catch (e) {
      db.exec(`ROLLBACK TO ${sp}`);
      db.exec(`RELEASE ${sp}`);
      throw e;
    } finally {
      depth.set(db, d);
    }
  }
  db.exec('BEGIN IMMEDIATE');
  depth.set(db, 1);
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* connection already rolled back */ }
    throw e;
  } finally {
    depth.set(db, 0);
  }
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function openDb(path: string, opts: { readOnly?: boolean; skipMigrate?: boolean; now?: () => number } = {}): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: opts.readOnly ?? false });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    if (!opts.readOnly) {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = FULL'); // committed bills survive power loss
      db.exec('PRAGMA temp_store = MEMORY');
    }
    db.exec('PRAGMA foreign_keys = ON');
    if (!opts.readOnly && !opts.skipMigrate) migrate(db, opts.now ?? Date.now);
  } catch (e) {
    db.close(); // a refused database must not stay open: Windows keeps open files locked, blocking a restore
    throw e;
  }
  return db;
}

export function currentSchemaVersion(db: DatabaseSync): number {
  const t = get<{ n: number }>(db, "SELECT count(*) n FROM sqlite_master WHERE type='table' AND name='schema_migrations'");
  if (!t || t.n === 0) return 0;
  return get<{ v: number | null }>(db, 'SELECT max(version) v FROM schema_migrations')?.v ?? 0;
}

export function migrate(db: DatabaseSync, now: () => number): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)');
  const applied = all<{ version: number; checksum: string }>(db, 'SELECT version, checksum FROM schema_migrations ORDER BY version');
  const known = new Map(MIGRATIONS.map((m) => [m.version, m]));
  for (const a of applied) {
    const m = known.get(a.version);
    if (!m) {
      throw new AppError('SCHEMA_TOO_NEW', `Database schema v${a.version} is newer than this app understands (v${SCHEMA_VERSION}). Update the app; never downgrade.`, 500);
    }
    if (sha256(m.sql) !== a.checksum) {
      throw new AppError('MIGRATION_CHECKSUM', `Migration ${a.version} (${m.name}) was modified after being applied.`, 500);
    }
  }
  const done = new Set(applied.map((a) => a.version));
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue;
    // PRAGMA foreign_keys is a no-op inside a transaction, so a table rebuild switches it off before BEGIN.
    const fkWasOn = m.foreignKeysOff ? (get<{ foreign_keys: number }>(db, 'PRAGMA foreign_keys')?.foreign_keys ?? 0) === 1 : false;
    if (m.foreignKeysOff) db.exec('PRAGMA foreign_keys = OFF');
    try {
      tx(db, () => {
        db.exec(m.sql);
        if (m.foreignKeysOff) {
          const broken = all(db, 'PRAGMA foreign_key_check');
          if (broken.length) throw new AppError('MIGRATION_FK', `Migration ${m.version} (${m.name}) would break ${broken.length} reference(s). Nothing was changed.`, 500);
        }
        run(db, 'INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?,?,?,?)', m.version, m.name, sha256(m.sql), now());
      });
    } finally {
      if (fkWasOn) db.exec('PRAGMA foreign_keys = ON');
    }
  }
}

export function quickCheck(db: DatabaseSync): { ok: boolean; messages: string[] } {
  const rows = all<Record<string, string>>(db, 'PRAGMA quick_check');
  const msgs = rows.map((r) => Object.values(r)[0] ?? '');
  return { ok: msgs.length === 1 && msgs[0] === 'ok', messages: msgs };
}
