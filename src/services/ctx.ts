import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createIdGenerator } from '../core/ids.ts';
import type { Clock, IdGenerator, Rng } from '../core/ids.ts';
import { openDb, get, AppError } from '../store/db.ts';

export type Role = 'owner' | 'manager' | 'cashier';
export interface Actor { userId: string; role: Role; name: string }
export interface Session extends Actor { token: string; lastSeen: number; /** when lastSeen was last written to app_session */ savedAt?: number; /** locked by hand (lock button): PIN needed */ locked?: boolean }
export interface Logger { info(msg: string, meta?: unknown): void; warn(msg: string, meta?: unknown): void; error(msg: string, meta?: unknown): void }
export interface Hooks { fault?: (point: string) => void }

export interface Ctx {
  db: DatabaseSync;
  dbPath: string;
  dataDir: string;
  journalDir: string;
  backupDir: string;
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
  hooks: Hooks;
  events: EventEmitter;
  sessions: Map<string, Session>;
  scryptCost: number;
  deviceCache: { id: string; outletId: string } | null;
}

export const consoleLogger: Logger = {
  info: (m, meta) => console.log(JSON.stringify({ level: 'info', m, meta })),
  warn: (m, meta) => console.warn(JSON.stringify({ level: 'warn', m, meta })),
  error: (m, meta) => console.error(JSON.stringify({ level: 'error', m, meta })),
};
export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

export interface CtxOptions {
  dataDir: string;
  dbPath?: string;
  clock?: Clock;
  rng?: Rng;
  logger?: Logger;
  scryptCost?: number;
}

export function createCtx(o: CtxOptions): Ctx {
  const dbPath = o.dbPath ?? join(o.dataDir, 'pos.db');
  const journalDir = join(o.dataDir, 'journal');
  const backupDir = join(o.dataDir, 'backups');
  if (dbPath !== ':memory:') {
    mkdirSync(o.dataDir, { recursive: true });
    mkdirSync(journalDir, { recursive: true });
    mkdirSync(backupDir, { recursive: true });
  }
  const clock = o.clock ?? { now: () => Date.now() };
  const rng: Rng = o.rng ?? ((n) => new Uint8Array(randomBytes(n)));
  return {
    db: openDb(dbPath, { now: () => clock.now() }),
    dbPath,
    dataDir: o.dataDir,
    journalDir,
    backupDir,
    clock,
    ids: createIdGenerator(clock, rng),
    logger: o.logger ?? consoleLogger,
    hooks: {},
    events: new EventEmitter(),
    sessions: new Map(),
    scryptCost: o.scryptCost ?? 16384,
    deviceCache: null,
  };
}

export function getDevice(ctx: Ctx): { id: string; outletId: string } {
  if (ctx.deviceCache) return ctx.deviceCache;
  const s = get<{ value: string }>(ctx.db, "SELECT value FROM settings WHERE key='device_id'");
  const d = s
    ? get<{ id: string; outlet_id: string }>(ctx.db, 'SELECT id, outlet_id FROM device WHERE id = ?', s.value)
    : get<{ id: string; outlet_id: string }>(ctx.db, 'SELECT id, outlet_id FROM device ORDER BY created_at LIMIT 1');
  if (!d) throw new AppError('NOT_SETUP', 'This installation has not been set up yet.', 409);
  ctx.deviceCache = { id: d.id, outletId: d.outlet_id };
  return ctx.deviceCache;
}
