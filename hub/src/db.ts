import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

/** The hub's database (node:sqlite, WAL, synchronous FULL). One file; all writes in short transactions. */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS store (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at INTEGER NOT NULL,
  menu_json TEXT, menu_version INTEGER NOT NULL DEFAULT 0,
  accepting INTEGER NOT NULL DEFAULT 0, accepting_reason TEXT,
  order_counter INTEGER NOT NULL DEFAULT 1000, last_seen_at INTEGER
);
CREATE TABLE IF NOT EXISTS device (
  id TEXT PRIMARY KEY, store_id TEXT NOT NULL REFERENCES store(id), name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS pairing_code (
  code_hash TEXT PRIMARY KEY, store_id TEXT NOT NULL REFERENCES store(id), expires_at INTEGER NOT NULL, used_at INTEGER
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, store_id TEXT NOT NULL REFERENCES store(id), number TEXT NOT NULL, state TEXT NOT NULL,
  data_json TEXT NOT NULL, access_hash TEXT NOT NULL, accept_by INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (store_id, number)
);
CREATE INDEX IF NOT EXISTS orders_waiting ON orders(state, accept_by);
CREATE TABLE IF NOT EXISTS event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, store_id TEXT NOT NULL, order_id TEXT, type TEXT NOT NULL, data_json TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS event_store ON event(store_id, seq);
CREATE TABLE IF NOT EXISTS idem (
  scope TEXT NOT NULL, key TEXT NOT NULL, status INTEGER NOT NULL, response_json TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (scope, key)
);
CREATE TABLE IF NOT EXISTS otp (
  mobile TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  sends INTEGER NOT NULL DEFAULT 0, window_start INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS otp_token (token_hash TEXT PRIMARY KEY, mobile TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS image (store_id TEXT NOT NULL REFERENCES store(id), name TEXT NOT NULL, type TEXT NOT NULL, bytes BLOB NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (store_id, name));
CREATE INDEX IF NOT EXISTS event_order ON event(order_id);
CREATE TABLE IF NOT EXISTS order_attempt (
  id INTEGER PRIMARY KEY AUTOINCREMENT, store_id TEXT NOT NULL REFERENCES store(id), at INTEGER NOT NULL, channel TEXT, fulfilment TEXT, payment TEXT,
  customer_name TEXT, mobile_masked TEXT, total INTEGER, code TEXT NOT NULL, message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS order_attempt_at ON order_attempt(store_id, at);
CREATE TABLE IF NOT EXISTS setting (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
`;

export type Db = DatabaseSync;

export function openHubDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  // columns added after the first release (CREATE TABLE IF NOT EXISTS does not add them to an existing database)
  const storeCols = new Set((db.prepare('PRAGMA table_info(store)').all() as Array<{ name: string }>).map((c) => c.name));
  if (!storeCols.has('paused_reason')) db.exec('ALTER TABLE store ADD COLUMN paused_reason TEXT'); // set: paused by the hub admin
  if (!storeCols.has('website_json')) db.exec('ALTER TABLE store ADD COLUMN website_json TEXT'); // website settings (src/website.ts)
  return db;
}

type P = string | number | bigint | null | Uint8Array;
export const one = <T>(db: Db, sql: string, ...p: P[]) => db.prepare(sql).get(...p) as T | undefined;
export const many = <T>(db: Db, sql: string, ...p: P[]) => db.prepare(sql).all(...p) as T[];
export const exec = (db: Db, sql: string, ...p: P[]) => db.prepare(sql).run(...p);
export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch { /* already rolled back */ } throw e; }
}
export const hash = (s: string) => createHash('sha256').update(s).digest('hex');
