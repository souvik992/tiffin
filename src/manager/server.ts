import http from 'node:http';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { backup } from 'node:sqlite';
import { basename, isAbsolute, join } from 'node:path';
import { createServer as createPosServer, listen } from '../http/server.ts';
import { AppError, get } from '../store/db.ts';
import { SCHEMA_VERSION } from '../store/schema.ts';
import { consoleLogger } from '../services/ctx.ts';
import type { Actor, Logger } from '../services/ctx.ts';
import { confirmPin, listLoginUsers, login, loginByMobile, logout } from '../services/auth.ts';
import { copyBackupPhotos, copyDirOf, listBackups, pruneBackups, verifyBackup } from '../services/backup.ts';
import { performRestore } from '../services/restore.ts';
import { clearOldSnapshots, closeSource, openSource, snapshotDb, VIEW_ONLY } from './source.ts';
import type { Source, Want } from './source.ts';
import { listTables, readTable, tableCsv } from './tables.ts';

/**
 * Tiffin Data Manager's backend: the POS's own API (same services, same rules, same checks) over the shop's data,
 * plus its own /mgr routes (status, open another folder or a backup file, all tables, backup, restore).
 *
 * - Only an owner signs in. The sign-in follows the data: when the POS opens or closes and the data is reopened
 *   (live <-> copy), the owner stays signed in if they are an owner in the newly opened data too.
 * - Changes go through the POS's own routes, and only these (menu, stock, purchases, store details, staff, coupons).
 *   Bills, payments, shifts and printing are never changed here (RULES.md 5): those are done at the POS.
 * - While the POS is open, or the data is older than this app, or a backup file is open, everything is view only.
 */

export interface ManagerOptions {
  /** this app's own folder (snapshot copies) */
  home: string;
  /** this computer's POS data folder */
  dataDir: string;
  /** required in X-POS-Secret on every request (the desktop window adds it) */
  secret?: string;
  logger?: Logger;
  isPosRunning?: () => Promise<boolean>;
  /** how often to look for a running POS (ms); 0 = never (tests call refresh) */
  watchMs?: number;
  port?: number;
}

export interface Manager { port: number; server: http.Server; readonly source: Source | null; refresh(): Promise<void>; close(): Promise<void> }

/** Changes allowed through the POS API: master data only. */
const EDITABLE = /^\/api\/(items|categories|tax-groups|modifier-groups|prep-stations|coupons|store|stock|purchases|recipes|users)(\/|$)/;
const MAX_BODY = 2_000_000;

interface MgrSession { userId: string; name: string; ctxToken: string | null; ctxOf: Source['ctx'] | null }

/** Whether a Windows program is running (tasklist; no administrator needed). Elsewhere: never. */
export function windowsProcessRunning(exe: string): Promise<boolean> {
  if (process.platform !== 'win32') return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', `IMAGENAME eq ${exe}`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 10_000 }, (err, stdout) => {
      resolve(!err && stdout.toLowerCase().includes(`"${exe.toLowerCase()}"`));
    });
  });
}

function send(res: ServerResponse, status: number, payload: unknown, type = 'application/json; charset=utf-8', extra: Record<string, string> = {}): void {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload === undefined ? { ok: true } : payload);
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(text);
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if ((req.headers['content-length'] ?? '0') !== '0' && !(req.headers['content-type'] ?? '').startsWith('application/json')) {
    return Promise.reject(new AppError('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.', 415));
  }
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = []; let size = 0;
    req.on('data', (d: Buffer) => { size += d.length; if (size > MAX_BODY) { reject(new AppError('PAYLOAD_TOO_LARGE', 'Request is too large.', 413)); req.destroy(); } else parts.push(d); });
    req.on('end', () => {
      if (!size) return resolve({});
      try { const v = JSON.parse(Buffer.concat(parts).toString('utf8')); resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {}); }
      catch { reject(new AppError('BAD_JSON', 'Request body is not valid JSON.', 400)); }
    });
    req.on('error', reject);
  });
}

const text = (v: unknown, name: string, max = 4096): string => {
  if (typeof v !== 'string' || !v || v.length > max) throw new AppError('VALIDATION', `${name} is missing.`);
  return v;
};
const fullPath = (v: unknown, name: string): string => {
  const p = text(v, name);
  if (!isAbsolute(p) || p.includes('\0')) throw new AppError('VALIDATION', `${name} must be a full path.`);
  return p;
};
function removeSidecars(file: string): void { for (const s of ['-wal', '-shm']) { try { unlinkSync(file + s); } catch { /* none */ } } }

export async function startManager(o: ManagerOptions): Promise<Manager> {
  const logger = o.logger ?? consoleLogger;
  const isPosRunning = o.isPosRunning ?? (() => Promise.resolve(false));
  const secret = o.secret ? Buffer.from(o.secret) : null;
  clearOldSnapshots(o.home);

  let source: Source | null = null;
  let posHandler: RequestListener | null = null;
  let openError: { code: string; message: string } | null = null;
  let want: Want = { origin: 'data' };
  let posRunning = await isPosRunning();
  let chain: Promise<void> = Promise.resolve();
  const sessions = new Map<string, MgrSession>();

  /** Ends sign-ins made in a live database (their app_session rows), so none are left behind in the shop's data. */
  const endLiveSessions = (s: Source) => {
    if (s.kind !== 'live') return;
    for (const m of sessions.values()) if (m.ctxOf === s.ctx && m.ctxToken) { try { logout(s.ctx, m.ctxToken); } catch { /* closed */ } m.ctxToken = null; m.ctxOf = null; }
  };
  const drop = () => { if (source) { endLiveSessions(source); closeSource(source); } source = null; posHandler = null; };

  /** Opens `next` (one at a time). An error is kept for the screen; nothing stays open. */
  const reopen = (next: Want): Promise<void> => {
    const run = async () => {
      drop();
      want = next; openError = null;
      try {
        source = await openSource(next, { home: o.home, dataDir: o.dataDir, posRunning, logger });
        posHandler = createPosServer(source.ctx, { queue: null }).listeners('request')[0] as RequestListener;
        logger.info('data opened', { kind: source.kind, origin: next.origin, schema: source.schema });
      } catch (e) {
        const err = e as AppError;
        openError = { code: err.code ?? 'OPEN_FAILED', message: err.message ?? String(e) };
      }
    };
    chain = chain.then(run, run);
    return chain;
  };

  /** Follows the POS: opened -> copy (view only); closed -> the data itself again. */
  const refresh = async () => {
    posRunning = await isPosRunning();
    if (want.origin === 'file') return;
    if (source?.kind === 'live' && posRunning) return reopen(want);
    if (source?.kind === 'snapshot' && source.viewOnly === VIEW_ONLY.posOpen && !posRunning) return reopen(want);
    if (!source && openError?.code === 'NO_DATA' && existsSync(join(want.origin === 'data' ? o.dataDir : want.path, 'pos.db'))) return reopen(want);
  };

  /** The token this owner uses in the open data (made on demand after the data was reopened). */
  const ctxTokenFor = (m: MgrSession): string | null => {
    if (!source) return null;
    const ctx = source.ctx;
    if (m.ctxOf === ctx && m.ctxToken && ctx.sessions.has(m.ctxToken)) return m.ctxToken;
    const u = get<{ role: string; name: string; active: number; deleted_at: number | null }>(ctx.db, 'SELECT role, name, active, deleted_at FROM app_user WHERE id = ?', m.userId);
    if (!u || u.role !== 'owner' || !u.active || u.deleted_at) return null;
    const token = randomBytes(32).toString('hex'), now = ctx.clock.now();
    ctx.sessions.set(token, { userId: m.userId, role: 'owner', name: u.name, token, lastSeen: now, savedAt: now }); // in memory only
    m.ctxOf = ctx; m.ctxToken = token; m.name = u.name;
    return token;
  };
  const ownerOf = (bearer: string | undefined): Actor => {
    const m = bearer ? sessions.get(bearer) : undefined;
    if (!m || !ctxTokenFor(m)) { if (bearer) sessions.delete(bearer); throw new AppError('UNAUTHENTICATED', 'Please sign in.', 401); }
    return { userId: m.userId, role: 'owner', name: m.name };
  };
  const open = (): Source => {
    if (!source) throw new AppError(openError?.code ?? 'NO_DATA', openError?.message ?? 'No data is open.', 409);
    return source;
  };
  const mustEdit = async (): Promise<Source> => {
    const s = open();
    if (s.kind === 'live') {
      posRunning = await isPosRunning();
      if (posRunning) { void refresh(); throw new AppError('VIEW_ONLY', VIEW_ONLY.posOpen, 409); }
    }
    if (s.viewOnly) throw new AppError('VIEW_ONLY', s.viewOnly, 409);
    return s;
  };

  const status = (bearer: string | undefined) => {
    let signedIn = false;
    if (bearer && sessions.has(bearer)) { try { ownerOf(bearer); signedIn = true; } catch { /* signed out */ } }
    return {
      source: source && { kind: source.kind, origin: want.origin, path: source.path, store: source.store, schema: source.schema, appSchema: SCHEMA_VERSION, editable: !source.viewOnly, viewOnly: source.viewOnly },
      error: openError, posRunning, dataDir: o.dataDir, signedIn,
    };
  };

  async function backupNow(s: Source, copyTo: string | null) {
    if (s.want.origin === 'file') throw new AppError('NOT_HERE', 'This is already a backup file. Open this computer\'s POS data to back it up.', 409);
    if (copyTo && !existsSync(copyTo)) throw new AppError('COPY_FOLDER_MISSING', `The folder ${copyTo} is not available. Is the USB drive plugged in?`, 409);
    const destDir = join(s.path, 'backups');
    mkdirSync(destDir, { recursive: true });
    const file = join(destDir, `manual-${new Date().toISOString().replace(/[-:.]/g, '')}.db`);
    if (s.kind === 'live') await backup(s.ctx.db, file); else await snapshotDb(s.dbFile, file); // never a raw copy of a live database
    const v = verifyBackup(file);
    removeSidecars(file);
    if (!v.ok) { try { unlinkSync(file); } catch { /* gone */ } throw new AppError('BACKUP_FAILED', `The backup failed its check: ${v.messages.join('; ')}. Nothing was saved.`, 500); }
    const photos = copyBackupPhotos(s.imagesFrom, file, destDir, logger);
    pruneBackups(destDir);
    let copy: string | null = null;
    if (copyTo) {
      const dest = copyDirOf(copyTo);
      mkdirSync(dest, { recursive: true });
      const tmp = join(dest, `${basename(file)}.${process.pid}.tmp`);
      copyFileSync(file, tmp);
      const cv = verifyBackup(tmp);
      removeSidecars(tmp);
      if (!cv.ok) { try { unlinkSync(tmp); } catch { /* gone */ } throw new AppError('COPY_FAILED', 'The backup was saved on this computer, but the copy on the drive failed its check. The drive may be faulty.', 500); }
      copy = join(dest, basename(file));
      renameSync(tmp, copy);
      copyBackupPhotos(s.imagesFrom, copy, dest, logger);
      pruneBackups(dest);
    }
    return { file, copy, bytes: statSync(file).size, photos: { referenced: photos.referenced, missing: photos.missing.length } };
  }

  async function restore(actor: Actor, file: string, pin: string) {
    const s = await mustEdit();
    if (!existsSync(file)) throw new AppError('NOT_FOUND', 'That backup file is not there any more.', 404);
    confirmPin(s.ctx, actor, pin); // a wrong PIN counts toward the usual lockout
    const w = want, dataDir = s.path;
    let report: ReturnType<typeof performRestore> | null = null, failure: unknown = null;
    const run = async () => {
      drop();
      try { report = performRestore(dataDir, file, logger); } catch (e) { failure = e; }
    };
    chain = chain.then(run, run);
    await chain;
    await reopen(w);
    if (failure) throw failure;
    logger.info('backup restored by Tiffin Data Manager', { file: basename(file) });
    return report!;
  }

  async function mgr(req: IncomingMessage, res: ServerResponse, url: URL, bearer: string | undefined): Promise<void> {
    const p = url.pathname, m = req.method;
    if (m === 'GET' && p === '/mgr/status') return send(res, 200, status(bearer));
    if (m === 'POST' && p === '/mgr/open') {
      const b = await readJson(req);
      const next: Want = b.origin === 'folder' ? { origin: 'folder', path: fullPath(b.path, 'Folder') } : b.origin === 'file' ? { origin: 'file', path: fullPath(b.path, 'File') } : { origin: 'data' };
      posRunning = await isPosRunning();
      await reopen(next);
      return send(res, 200, status(bearer));
    }
    const actor = ownerOf(bearer);
    const s = open();
    let mt: RegExpExecArray | null;
    if (m === 'GET' && p === '/mgr/tables') return send(res, 200, listTables(s.ctx.db));
    if (m === 'GET' && (mt = /^\/mgr\/tables\/([^/]+)\/csv$/.exec(p))) {
      const t = tableCsv(s.ctx.db, decodeURIComponent(mt[1]!), url.searchParams.get('q') ?? '');
      return send(res, 200, t.csv, 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="${t.filename.replace(/[^\w.-]/g, '_')}"` });
    }
    if (m === 'GET' && (mt = /^\/mgr\/tables\/([^/]+)$/.exec(p))) {
      const n = (k: string) => { const v = url.searchParams.get(k); return v === null || v === '' ? undefined : Number(v) | 0; };
      return send(res, 200, readTable(s.ctx.db, decodeURIComponent(mt[1]!), { search: url.searchParams.get('q') ?? '', limit: n('limit'), offset: n('offset') }));
    }
    if (m === 'GET' && p === '/mgr/backups') {
      const folder = s.want.origin === 'file' ? null : join(s.path, 'backups');
      return send(res, 200, { folder, files: folder ? listBackups(folder) : [], canBackup: Boolean(folder), canRestore: !s.viewOnly, viewOnly: s.viewOnly });
    }
    if (m === 'POST' && p === '/mgr/backup') {
      const b = await readJson(req);
      return send(res, 200, await backupNow(s, b.copyTo ? fullPath(b.copyTo, 'Folder') : null));
    }
    if (m === 'POST' && p === '/mgr/restore') {
      const b = await readJson(req);
      return send(res, 200, await restore(actor, fullPath(b.path, 'Backup file'), text(b.pin, 'PIN', 12)));
    }
    throw new AppError('NOT_FOUND', 'No such endpoint.', 404);
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL, bearer: string | undefined): Promise<void> {
    const p = url.pathname, m = req.method ?? 'GET';
    if (m === 'POST' && p === '/api/auth/login') {
      const s = open();
      const b = await readJson(req);
      const pin = text(b.pin, 'PIN', 12);
      const r = typeof b.mobile === 'string' && b.mobile ? loginByMobile(s.ctx, b.mobile, pin)
        : typeof b.userId === 'string' && b.userId ? login(s.ctx, b.userId, pin) : (() => { throw new AppError('VALIDATION', 'Enter your mobile number.'); })();
      if (r.user.role !== 'owner') { logout(s.ctx, r.token); throw new AppError('OWNER_ONLY', 'Only the owner can open Tiffin Data Manager.', 403); }
      const token = randomBytes(32).toString('hex');
      sessions.set(token, { userId: r.user.userId, name: r.user.name, ctxToken: r.token, ctxOf: s.ctx });
      return send(res, 200, { token, user: r.user });
    }
    if (m === 'POST' && p === '/api/auth/logout') {
      const ms = bearer ? sessions.get(bearer) : undefined;
      if (ms && source && ms.ctxOf === source.ctx && ms.ctxToken) { try { logout(source.ctx, ms.ctxToken); } catch { /* gone */ } }
      if (bearer) sessions.delete(bearer);
      return send(res, 200, { ok: true });
    }
    if (m === 'GET' && p === '/api/login-users') return send(res, 200, listLoginUsers(open().ctx).filter((u) => u.role === 'owner'));
    if (p.startsWith('/api/auth/')) throw new AppError('NOT_HERE', 'Not available in Tiffin Data Manager.', 403);
    const mutating = m !== 'GET' && m !== 'HEAD';
    if (mutating && !EDITABLE.test(p)) throw new AppError('NOT_HERE', 'Bills, payments, shifts and printing are handled at the POS, not in Tiffin Data Manager.', 403);
    if (mutating) await mustEdit();
    const handler = posHandler;
    if (!source || !handler) open();
    delete req.headers.authorization;
    const ms = bearer ? sessions.get(bearer) : undefined;
    if (ms) { const t = ctxTokenFor(ms); if (t) req.headers.authorization = `Bearer ${t}`; else sessions.delete(bearer!); }
    handler!(req, res);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const host = (req.headers.host ?? '').replace(/:\d+$/, '');
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) throw new AppError('BAD_HOST', 'Unexpected Host header.', 403);
      if (secret) {
        const got = req.headers['x-pos-secret'];
        if (typeof got !== 'string' || got.length !== secret.length || !timingSafeEqual(Buffer.from(got), secret)) throw new AppError('BAD_LAUNCH_SECRET', 'Open Tiffin Data Manager from its desktop app.', 403);
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      if (url.pathname.startsWith('/mgr/')) return await mgr(req, res, url, bearer);
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return await api(req, res, url, bearer);
      throw new AppError('NOT_FOUND', 'No such endpoint.', 404);
    } catch (e) {
      if (res.headersSent) return;
      if (e instanceof AppError) return send(res, e.status, { error: { code: e.code, message: e.message, details: e.details } });
      logger.error('unhandled error', { message: String((e as Error).message) });
      send(res, 500, { error: { code: 'INTERNAL', message: 'Something went wrong. Your data is safe; please try again.' } });
    }
  });
  server.requestTimeout = 300_000; // a restore of a large database can take a while
  server.headersTimeout = 10_000;

  await reopen({ origin: 'data' });
  const port = await listen(server, o.port ?? 0);
  const timer = o.watchMs ? setInterval(() => { void refresh().catch(() => { /* next round */ }); }, o.watchMs) : null;

  return {
    port, server, refresh,
    get source() { return source; },
    close: async () => {
      if (timer) clearInterval(timer);
      await chain.catch(() => {});
      drop();
      await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
    },
  };
}
