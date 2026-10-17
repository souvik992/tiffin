import { existsSync, readdirSync, readFileSync, statSync, mkdirSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AppError, all, get, run, sha256, tx } from '../store/db.ts';
import type { Actor, Ctx, Logger } from '../services/ctx.ts';
import { runCommand } from '../services/commands.ts';
import { audit } from '../services/audit.ts';
import { assertPerm } from '../services/permissions.ts';
import { getSetting, setSetting } from '../services/settings.ts';
import { compareVersions, manifestProblem, sha256hex, signatureOk } from './manifest.ts';
import type { AddonManifest } from './manifest.ts';
import { TRUSTED_ADDON_KEYS } from './trust.ts';
import { billOnlineOrder, cancelOnlineBill, onlineImage, onlineMenu, shiftActor } from '../services/onlineBilling.ts';

/**
 * Loads signed add-ons (e.g. ODS) at startup. Each add-on gets a small, stable toolbox (HostApi) instead of
 * importing POS internals, its own route area /api/addons/<id>/..., its own migration track, and its own data folder.
 * Anything wrong (signature, changed file, too-old POS, failing code or migration) switches that add-on off with a
 * reason the owner can read; the POS itself always starts.
 */

type Param = string | number | bigint | null | Uint8Array;
export interface AddonRequest { ctx: Ctx; actor: Actor; params: Record<string, string>; query: URLSearchParams; body: unknown; requestId: string; req: IncomingMessage; res: ServerResponse }
export interface AddonRouteOptions { auth?: boolean; idem?: boolean; format?: 'json' | 'sse' }
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export interface AddonMigration { version: number; name: string; sql: string }

export interface HostApi {
  id: string;
  posVersion: string;
  ctx: Ctx;
  log: Logger;
  /** A folder of its own for caches and files: <data>/addons/<id>. */
  dataDir: string;
  AppError: typeof AppError;
  db: { get<T>(sql: string, ...p: Param[]): T | undefined; all<T>(sql: string, ...p: Param[]): T[]; run(sql: string, ...p: Param[]): { changes: number | bigint }; tx<T>(fn: () => T): T };
  runCommand: typeof runCommand;
  audit: typeof audit;
  assertPerm: typeof assertPerm;
  getSetting(key: string): string;
  setSetting(key: string, value: string): void;
  /** path is relative to /api/addons/<id>, e.g. '/config'. */
  route(method: Method, path: string, opts: AddonRouteOptions, handler: (c: AddonRequest) => unknown): void;
  migrations(list: AddonMigration[]): void;
  onStop(fn: () => void | Promise<void>): void;
  /** Online orders as ordinary GST bills (src/services/onlineBilling.ts). */
  billing: { bill: typeof billOnlineOrder; cancel: typeof cancelOnlineBill; shiftActor: typeof shiftActor; menu: typeof onlineMenu; /** POS 0.3.3: a menu photo's bytes. */ image: typeof onlineImage };
}

export interface AddonRoute { method: string; path: string; opts: AddonRouteOptions; handler: (c: AddonRequest) => unknown }
export interface AddonStatus { id: string; name: string; version: string; status: 'active' | 'off'; reason: string | null; hasUi: boolean }
export interface LoadedAddons { list: AddonStatus[]; routes: AddonRoute[]; ui: Map<string, string>; stop(): Promise<void> }

export interface LoadOptions { dir?: string | null; posVersion: string; trustedKeys?: readonly string[] }

const nodeRequire = createRequire(join(process.cwd(), 'addon-host.js'));
const BUILTINS = new Set(builtinModules);
/** Add-ons may only use Node's own modules; everything else is bundled into the signed file. */
const safeRequire = (id: string) => {
  const bare = id.replace(/^node:/, '');
  if (!BUILTINS.has(bare)) throw new Error(`add-ons may only require Node built-in modules (asked for "${id}")`);
  return nodeRequire(id);
};

export const EMPTY_ADDONS: LoadedAddons = { list: [], routes: [], ui: new Map(), stop: async () => {} };

export async function loadAddons(ctx: Ctx, o: LoadOptions): Promise<LoadedAddons> {
  const out: LoadedAddons = { list: [], routes: [], ui: new Map(), stop: async () => {} };
  const stops: Array<() => void | Promise<void>> = [];
  out.stop = async () => { for (const s of stops.reverse()) { try { await s(); } catch (e) { ctx.logger.error('add-on stop failed', String(e)); } } };
  if (!o.dir || !existsSync(o.dir)) return out;
  const keys = o.trustedKeys ?? TRUSTED_ADDON_KEYS;
  const dev = o.posVersion.includes('-dev');

  for (const folder of readdirSync(o.dir).sort()) {
    const root = join(o.dir, folder);
    if (!statSync(root).isDirectory()) continue;
    const off = (reason: string, m?: Partial<AddonManifest>) => {
      out.list.push({ id: m?.id ?? folder, name: m?.name ?? folder, version: m?.version ?? '?', status: 'off', reason, hasUi: false });
      ctx.logger.warn('add-on switched off', { addon: m?.id ?? folder, reason });
    };
    let m: AddonManifest;
    try { m = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as AddonManifest; } catch { off('manifest.json is missing or unreadable. Reinstall the add-on.'); continue; }
    const problem = manifestProblem(m);
    if (problem) { off(`The package is damaged (${problem}). Reinstall the add-on.`, m); continue; }
    if (m.id !== folder) { off(`The add-on folder "${folder}" does not match its name "${m.id}". Reinstall the add-on.`, m); continue; }
    if (out.list.some((a) => a.id === m.id)) { off('Installed twice. Remove the extra copy.', m); continue; }
    if (!signatureOk(m, keys)) { off('Not signed by a trusted publisher. Install it only from the official installer.', m); continue; }
    if (!dev && !(compareVersions(o.posVersion, m.minPosVersion) >= 0)) { off(`Needs Tiffin POS ${m.minPosVersion} or newer (this is ${o.posVersion}). Update the POS first.`, m); continue; }
    // no going back: an older (even genuinely signed) package may have a known fault
    const seen = getSetting(ctx, `addon_version:${m.id}`);
    if (seen && compareVersions(m.version, seen) < 0) { off(`This is an older version (${m.version}) than the one installed before (${seen}). Install the latest version.`, m); continue; }

    // read every listed file once, check it, and only ever use these checked bytes
    const files = new Map<string, Buffer>();
    let bad: string | null = null;
    for (const [name, hash] of Object.entries(m.files)) {
      let bytes: Buffer;
      try { bytes = readFileSync(join(root, name)); } catch { bad = `${name} is missing`; break; }
      if (sha256hex(bytes) !== hash) { bad = `${name} was changed after it was signed`; break; }
      files.set(name, bytes);
    }
    if (bad) { off(`The add-on files are not the ones that were signed (${bad}). Reinstall the add-on.`, m); continue; }

    const routes: AddonRoute[] = [];
    const migrations: AddonMigration[] = [];
    const myStops: Array<() => void | Promise<void>> = [];
    try {
      if (m.backend) {
        const host = makeHost(ctx, m.id, o.posVersion, { routes, migrations, stops: myStops });
        const mod = { exports: {} as { register?: (h: HostApi) => void | Promise<void> } };
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        new Function('module', 'exports', 'require', files.get(m.backend)!.toString('utf8'))(mod, mod.exports, safeRequire);
        if (typeof mod.exports.register !== 'function') throw new Error('the add-on has no register() function');
        await mod.exports.register(host);
        applyAddonMigrations(ctx, m.id, migrations);
      }
    } catch (e) {
      for (const s of myStops) { try { await s(); } catch { /* already failing */ } }
      off(`It could not start: ${e instanceof AppError ? e.message : (e as Error).message}. Billing is not affected.`, m);
      continue;
    }
    out.routes.push(...routes);
    stops.push(...myStops);
    if (m.ui) out.ui.set(m.id, files.get(m.ui)!.toString('utf8'));
    if (!seen || compareVersions(m.version, seen) > 0) setSetting(ctx, `addon_version:${m.id}`, m.version);
    out.list.push({ id: m.id, name: m.name, version: m.version, status: 'active', reason: null, hasUi: Boolean(m.ui) });
    ctx.logger.info('add-on loaded', { addon: m.id, version: m.version });
  }
  return out;
}

/** The toolbox an add-on gets. Exported so add-on tests can run their code against a real POS database. */
export function makeHost(ctx: Ctx, id: string, posVersion: string, sink: { routes: AddonRoute[]; migrations: AddonMigration[]; stops: Array<() => void | Promise<void>> }): HostApi {
  const dataDir = join(ctx.dataDir, 'addons', id);
  mkdirSync(dataDir, { recursive: true });
  return {
    id, posVersion, ctx, log: ctx.logger, dataDir, AppError,
    db: { get: (s, ...p) => get(ctx.db, s, ...p), all: (s, ...p) => all(ctx.db, s, ...p), run: (s, ...p) => run(ctx.db, s, ...p), tx: (fn) => tx(ctx.db, fn) },
    runCommand, audit, assertPerm,
    getSetting: (k) => getSetting(ctx, k), setSetting: (k, v) => setSetting(ctx, k, v),
    route: (method, path, opts, handler) => {
      if (!/^\/[A-Za-z0-9/:._-]*$/.test(path) || path === '/ui.js') throw new Error(`route path not allowed: ${path}`);
      sink.routes.push({ method, path: `/api/addons/${id}${path === '/' ? '' : path}`, opts, handler });
    },
    migrations: (list) => { sink.migrations.push(...list); },
    onStop: (fn) => { sink.stops.push(fn); },
    billing: { bill: billOnlineOrder, cancel: cancelOnlineBill, shiftActor, menu: onlineMenu, image: onlineImage },
  };
}

/** Same rules as the POS's own migrations: applied once, in order, never edited afterwards (checksums). */
export function applyAddonMigrations(ctx: Ctx, addonId: string, list: AddonMigration[]): void {
  const sorted = [...list].sort((a, b) => a.version - b.version);
  sorted.forEach((x, i) => { if (!Number.isInteger(x.version) || x.version !== i + 1) throw new Error('add-on migrations must be numbered 1, 2, 3...'); });
  const applied = all<{ version: number; checksum: string }>(ctx.db, 'SELECT version, checksum FROM addon_migrations WHERE addon_id = ? ORDER BY version', addonId);
  for (const a of applied) {
    const x = sorted.find((s) => s.version === a.version);
    if (!x) throw new AppError('ADDON_TOO_OLD', `its data is from a newer version (step ${a.version}); install the newest add-on`, 500);
    if (sha256(x.sql) !== a.checksum) throw new AppError('ADDON_MIGRATION_CHANGED', `database step ${a.version} (${x.name}) was changed after it was applied`, 500);
  }
  for (const x of sorted) {
    if (applied.some((a) => a.version === x.version)) continue;
    const bad = sqlProblem(addonId, x.sql);
    if (bad) throw new AppError('ADDON_SQL', `database step ${x.version} (${x.name}) ${bad}`, 500);
    tx(ctx.db, () => {
      ctx.db.exec(x.sql);
      run(ctx.db, 'INSERT INTO addon_migrations (addon_id, version, name, checksum, applied_at) VALUES (?,?,?,?,?)', addonId, x.version, x.name, sha256(x.sql), ctx.clock.now());
    });
  }
}

/**
 * Add-on database steps may only create and change the add-on's own tables (named "<id>_...", e.g. ods_order). They may
 * not change POS tables (bills, payments, users...), react to them with triggers, or use ATTACH, PRAGMA or VACUUM.
 * A best-effort check of the statement text; the signature is still the main protection.
 */
export function sqlProblem(addonId: string, sql: string): string | null {
  const prefix = addonId.replace(/-/g, '_') + '_';
  const clean = sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/'(?:[^']|'')*'/g, "''");
  if (/\b(ATTACH|DETACH|PRAGMA|VACUUM|REINDEX)\b/i.test(clean)) return 'uses a command that is not allowed for add-ons (ATTACH, PRAGMA, VACUUM)';
  const name = '("[^"]+"|\\[[^\\]]+\\]|`[^`]+`|[A-Za-z_][A-Za-z0-9_$.]*)';
  const patterns = [
    new RegExp(`\\bCREATE\\s+(?:TEMP(?:ORARY)?\\s+)?(?:UNIQUE\\s+)?(?:TABLE|INDEX|VIEW|TRIGGER)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${name}`, 'gi'),
    new RegExp(`\\bALTER\\s+TABLE\\s+${name}`, 'gi'),
    new RegExp(`\\bDROP\\s+(?:TABLE|INDEX|VIEW|TRIGGER)\\s+(?:IF\\s+EXISTS\\s+)?${name}`, 'gi'),
    new RegExp(`\\b(?:INSERT|REPLACE)\\s+(?:OR\\s+\\w+\\s+)?INTO\\s+${name}`, 'gi'),
    new RegExp(`\\bUPDATE\\s+(?:OR\\s+\\w+\\s+)?${name}`, 'gi'),
    new RegExp(`\\bDELETE\\s+FROM\\s+${name}`, 'gi'),
    new RegExp(`\\bON\\s+${name}`, 'gi'), // the table an index or trigger is attached to
  ];
  for (const p of patterns) {
    for (const m of clean.matchAll(p)) {
      const n = m[1]!.replace(/^["[`]|["\]`]$/g, '').replace(/^main\./i, '');
      if (/^(CONFLICT|DELETE|UPDATE|INSERT|ON|OF|SET)$/i.test(n)) continue; // "ON CONFLICT", "ON DELETE ..." are not tables
      if (!n.toLowerCase().startsWith(prefix)) return `changes "${n}", which is not one of its own tables (they must be named ${prefix}...). Add-ons may only change their own tables`;
    }
  }
  return null;
}
