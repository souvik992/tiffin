import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createGunzip, createGzip } from 'node:zlib';
import { join } from 'node:path';
import { AppError, get } from '../store/db.ts';
import type { Ctx } from './ctx.ts';
import { getSetting, setSetting } from './settings.ts';
import { listBackups, referencedImages, runBackup, verifyBackup } from './backup.ts';
import { imagesDir, IMAGE_FILE } from './images.ts';
import { newStage } from './restore.ts';

/**
 * Online backups to the Tiffin backup server (the order hub, hub/src/backups.ts). Off until the owner connects this
 * POS with a pairing code and switches it on: nothing connects out before that (offline is the default).
 * Each upload is the newest verified local backup, gzipped, with its SHA-256; the menu photos it uses go first, only
 * those the server does not have. Settings: cloud_backup_url, cloud_backup_key (a secret: "_key" settings never leave
 * the backend), cloud_backup_store, cloud_backup_on, cloud_backup_every_hours, cloud_backup_last_at / _last_file / _error.
 */

export const EVERY_HOURS = [1, 3, 6, 12, 24] as const;
const DEFAULT_EVERY = 3;

export interface CloudStatus {
  connected: boolean; on: boolean; url: string | null; store: string | null; everyHours: number;
  lastAt: number | null; lastFile: string | null; error: string | null; busy: boolean;
}

const busy = new WeakSet<Ctx>();
const s = (ctx: Ctx, k: string) => getSetting(ctx, k);

export function cloudStatus(ctx: Ctx): CloudStatus {
  const every = Number(s(ctx, 'cloud_backup_every_hours')) || DEFAULT_EVERY;
  return {
    connected: Boolean(s(ctx, 'cloud_backup_key')), on: s(ctx, 'cloud_backup_on') === '1',
    url: s(ctx, 'cloud_backup_url') || null, store: s(ctx, 'cloud_backup_store') || null, everyHours: every,
    lastAt: Number(s(ctx, 'cloud_backup_last_at')) || null, lastFile: s(ctx, 'cloud_backup_last_file') || null,
    error: s(ctx, 'cloud_backup_error') || null, busy: busy.has(ctx),
  };
}

/** https only, except a server on this same machine (the device key travels on this connection). */
export function serverUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new AppError('VALIDATION', 'Enter the backup server address, e.g. https://backup.example.in', 400); }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new AppError('VALIDATION', 'The backup server address must start with https://', 400);
  return u.origin + u.pathname.replace(/\/+$/, '');
}

async function call(ctx: Ctx, method: string, path: string, init: { body?: BodyInit; headers?: Record<string, string>; json?: unknown; url?: string; key?: string } = {}): Promise<Response> {
  const url = init.url ?? s(ctx, 'cloud_backup_url'), key = init.key ?? s(ctx, 'cloud_backup_key');
  if (!url) throw new AppError('NOT_CONNECTED', 'Connect this POS to the backup server first.', 409);
  let r: Response;
  try {
    r = await fetch(url + path, {
      method, signal: AbortSignal.timeout(30 * 60_000),
      headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}), ...init.headers },
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
      ...(init.body instanceof ReadableStream ? { duplex: 'half' } : {}),
    } as RequestInit);
  } catch {
    throw new AppError('NETWORK', 'Could not reach the backup server. Check the internet connection; the POS will try again later.', 503);
  }
  if (r.ok) return r;
  const err = await r.json().catch(() => null) as { error?: { message?: string } } | null;
  if (r.status === 401) throw new AppError('NOT_CONNECTED', 'This POS is no longer connected to the backup server. Connect it again with a new pairing code.', 409);
  throw new AppError('SERVER_ERROR', err?.error?.message ?? `The backup server answered ${r.status}.`, 502);
}

/** Connects this POS with a one-time pairing code from the backup server, and switches online backups on. */
export async function pairCloud(ctx: Ctx, rawUrl: string, code: string, deviceName: string) {
  const url = serverUrl(rawUrl);
  const r = await call(ctx, 'POST', '/v1/pos/pair', { url, key: '', json: { code, deviceName: `${deviceName} (backups)`.slice(0, 60) } });
  const p = await r.json() as { deviceKey: string; name: string; slug: string };
  if (!p.deviceKey) throw new AppError('SERVER_ERROR', 'The backup server did not answer as expected.', 502);
  setSetting(ctx, 'cloud_backup_url', url);
  setSetting(ctx, 'cloud_backup_key', p.deviceKey);
  setSetting(ctx, 'cloud_backup_store', p.name);
  setSetting(ctx, 'cloud_backup_on', '1');
  setSetting(ctx, 'cloud_backup_error', '');
  return cloudStatus(ctx);
}

export function setCloudOptions(ctx: Ctx, o: { on?: boolean; everyHours?: number }) {
  if (o.on !== undefined) {
    if (o.on && !s(ctx, 'cloud_backup_key')) throw new AppError('NOT_CONNECTED', 'Connect this POS to the backup server first.', 409);
    setSetting(ctx, 'cloud_backup_on', o.on ? '1' : '0');
  }
  if (o.everyHours !== undefined) {
    if (!(EVERY_HOURS as readonly number[]).includes(o.everyHours)) throw new AppError('VALIDATION', `Choose one of ${EVERY_HOURS.join(', ')} hours.`, 400);
    setSetting(ctx, 'cloud_backup_every_hours', String(o.everyHours));
  }
  return cloudStatus(ctx);
}

/** Forgets the server and its key on this POS (backups already on the server stay there). */
export function disconnectCloud(ctx: Ctx) {
  for (const k of ['cloud_backup_url', 'cloud_backup_key', 'cloud_backup_store', 'cloud_backup_on', 'cloud_backup_last_at', 'cloud_backup_last_file', 'cloud_backup_error']) setSetting(ctx, k, '');
  return cloudStatus(ctx);
}

async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const ch of createReadStream(file)) h.update(ch as Buffer);
  return h.digest('hex');
}

/** Uploads one local backup file (photos first). Errors are recorded for the screen and thrown. */
export async function uploadBackup(ctx: Ctx, backupFile: string): Promise<{ name: string; bytes: number }> {
  if (busy.has(ctx)) throw new AppError('BUSY', 'An online backup is already running.', 409);
  busy.add(ctx);
  const gz = `${backupFile}.upload.gz`;
  try {
    // photos the server does not have yet
    const have = new Set(((await (await call(ctx, 'GET', '/v1/pos/backup-images')).json()) as { names: string[] }).names);
    for (const n of referencedImages(backupFile)) {
      if (have.has(n) || !IMAGE_FILE.test(n)) continue;
      const local = [join(ctx.backupDir, 'images', n), join(imagesDir(ctx), n)].find((f) => existsSync(f));
      if (!local) continue; // missing photos are reported by the local backup already
      await call(ctx, 'PUT', `/v1/pos/backup-images/${n}`, { body: readFileSync(local), headers: { 'content-type': 'application/octet-stream' } });
    }
    await pipeline(createReadStream(backupFile), createGzip({ level: 6 }), createWriteStream(gz));
    const sha = await sha256File(gz);
    const name = `${backupFile.split(/[\\/]/).pop()!}.gz`;
    const bytes = statSync(gz).size;
    await call(ctx, 'PUT', `/v1/pos/backups/${name}`, {
      body: Readable.toWeb(createReadStream(gz)) as unknown as ReadableStream,
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes), 'x-content-sha256': sha },
    });
    setSetting(ctx, 'cloud_backup_last_at', String(ctx.clock.now()));
    setSetting(ctx, 'cloud_backup_last_file', name);
    setSetting(ctx, 'cloud_backup_error', '');
    return { name, bytes };
  } catch (e) {
    setSetting(ctx, 'cloud_backup_error', e instanceof AppError ? e.message : String((e as Error).message ?? e));
    throw e;
  } finally {
    busy.delete(ctx);
    try { unlinkSync(gz); } catch { /* none */ }
  }
}

/** "Back up online now": a fresh verified backup, then its upload. */
export async function backupOnlineNow(ctx: Ctx) {
  if (!s(ctx, 'cloud_backup_key')) throw new AppError('NOT_CONNECTED', 'Connect this POS to the backup server first.', 409);
  const b = await runBackup(ctx, 'manual');
  return uploadBackup(ctx, b.file);
}

/** Uploads the newest local backup when online backups are on and the last upload is older than the chosen interval. */
export async function uploadIfDue(ctx: Ctx): Promise<boolean> {
  const st = cloudStatus(ctx);
  if (!st.connected || !st.on || st.busy) return false;
  const newest = listBackups(ctx.backupDir)[0];
  if (!newest || newest.file === st.lastFile?.replace(/\.gz$/, '')) return false;
  if (st.lastAt !== null && ctx.clock.now() - st.lastAt < st.everyHours * 3_600_000) return false;
  await uploadBackup(ctx, join(ctx.backupDir, newest.file));
  return true;
}

/** Checks every 10 minutes (first after 2 minutes). Failures are recorded and retried at the next check. */
export function scheduleCloudBackups(ctx: Ctx): () => void {
  const tick = () => { void uploadIfDue(ctx).catch((e) => ctx.logger.warn('online backup failed', String((e as Error).message ?? e))); };
  const first = setTimeout(tick, 2 * 60_000);
  const t = setInterval(tick, 10 * 60_000);
  first.unref(); t.unref();
  return () => { clearTimeout(first); clearInterval(t); };
}

export async function listOnline(ctx: Ctx) {
  const r = await call(ctx, 'GET', '/v1/pos/backups');
  return ((await r.json()) as { backups: Array<{ name: string; bytes: number; uploadedAt: number }> }).backups;
}

/**
 * Downloads an online backup into the restore staging folder: checked against its SHA-256, unpacked, verified, and the
 * photos it uses that this POS does not have. Returns the staged database file.
 */
export async function downloadToStage(ctx: Ctx, name: string): Promise<string> {
  if (!/^[a-z]+-\d{8}T\d{9}Z\.db\.gz$/.test(name)) throw new AppError('VALIDATION', 'Unknown backup name.', 400);
  const d = newStage(ctx);
  const gz = join(d, 'download.gz'), db = join(d, 'backup.db');
  const r = await call(ctx, 'GET', `/v1/pos/backups/${name}`);
  await pipeline(Readable.fromWeb(r.body as never), createWriteStream(gz));
  const want = r.headers.get('x-content-sha256');
  if (want && (await sha256File(gz)) !== want) throw new AppError('DOWNLOAD_DAMAGED', 'The backup was damaged while downloading. Try again.', 502);
  await pipeline(createReadStream(gz), createGunzip(), createWriteStream(`${db}.tmp`));
  renameSync(`${db}.tmp`, db);
  unlinkSync(gz);
  const v = verifyBackup(db);
  if (!v.ok) throw new AppError('BACKUP_INVALID', 'This online backup is not usable. Choose another one.', 422);
  mkdirSync(join(d, 'images'), { recursive: true });
  for (const n of referencedImages(db)) {
    if (existsSync(join(imagesDir(ctx), n))) continue;
    try {
      const img = Buffer.from(await (await call(ctx, 'GET', `/v1/pos/backup-images/${n}`)).arrayBuffer());
      if (createHash('sha256').update(img).digest('hex') === n.slice(0, 64)) writeFileSync(join(d, 'images', n), img);
    } catch { /* a missing photo is reported after the restore, never fatal */ }
  }
  return db;
}

/** This device's name, for the server's device list. */
export function deviceName(ctx: Ctx): string {
  return get<{ name: string }>(ctx.db, 'SELECT name FROM device LIMIT 1')?.name ?? 'POS';
}
