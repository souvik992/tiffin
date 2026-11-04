import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { HostApi } from '../../../src/addons/host.ts';
import { isOnlineMode } from './onlineConfig.ts';
import { googleKeyInUse, readGoogleKey, readMapStyle } from './store.ts';
import type { MapStyle } from './store.ts';

/**
 * Map pictures (tiles) for Settings > Serviceability, fetched by the POS (never by the page, so the window's strict
 * Content-Security-Policy stays and the key never reaches the page). Only while online orders are on.
 *   google  Google Map Tiles API with the owner's key, when the owner chose a Google map (road, satellite, or satellite
 *           with roads) in Settings > Serviceability. A tile session per map is created and reused until it expires. Google's terms do not allow keeping copies, so these tiles are not saved.
 *   osm     the free map (the default, with or without a key): OpenStreetMap tiles, used lightly, saved on disk (they keep working offline).
 */

const OSM = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const GOOGLE_SESSION = 'https://tile.googleapis.com/v1/createSession';
const GOOGLE_TILE = 'https://tile.googleapis.com/v1/2dtiles/';
const TIMEOUT_MS = 8000;

export interface Fetcher { (url: string, init: { method?: string; headers: Record<string, string>; body?: string; signal: AbortSignal }): Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer>; json(): Promise<unknown> }> }

export function mapAttribution(host: HostApi): { provider: 'google' | 'osm'; style: MapStyle; attribution: string } {
  const style = readMapStyle(host);
  return style === 'osm'
    ? { provider: 'osm', style, attribution: '&copy; OpenStreetMap contributors' }
    : { provider: 'google', style, attribution: `${style === 'google-road' ? 'Map data' : 'Imagery'} &copy;${new Date().getFullYear()} Google` };
}

/** What Google's createSession is asked for, per map. */
const GOOGLE_MAPS: Record<Exclude<MapStyle, 'osm'>, object> = {
  'google-road': { mapType: 'roadmap' },
  'google-satellite': { mapType: 'satellite' },
  'google-hybrid': { mapType: 'satellite', layerTypes: ['layerRoadmap'] },
};

/** Google's answer when the key is refused or the API is not switched on, as a message for the owner. */
export function googleRefusal(raw: unknown, api: string): string {
  const e = (raw as { error?: { status?: unknown; message?: unknown } } | null)?.error;
  const msg = typeof e?.message === 'string' ? e.message : '';
  if (/has not been used|is disabled|SERVICE_DISABLED/i.test(msg)) return `${api} is not switched on for this key's project. In the Google Cloud console, open APIs & Services > Library, search "${api}" and press Enable (it can take a few minutes).`;
  if (/API key not valid|API_KEY_INVALID/i.test(msg)) return 'Google says this API key is not valid. Copy it again from the Google Cloud console.';
  if (/billing/i.test(msg)) return 'Google needs a billing account on this project (pay-as-you-go; the free monthly allowance still applies).';
  if (/restrict|not authorized|blocked/i.test(msg)) return `This key is not allowed to use ${api}. In the key's settings, under API restrictions, add "${api}".`;
  return `Google refused: ${msg.slice(0, 200) || 'no reason given'}`;
}

export function makeMaps(host: HostApi, fetcher: Fetcher = fetch as unknown as Fetcher) {
  const ua = `TiffinPOS-ODS/1.0 (POS ${host.posVersion}; store settings map)`;
  let session: { key: string; style: MapStyle; id: string; expiry: number } | null = null;
  const memo = new Map<string, Buffer>(); // a few recent Google tiles in memory only (not on disk)

  const imageOf = (buf: Buffer) => {
    const isPng = buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47, isJpeg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8;
    if (!isPng && !isJpeg) throw new host.AppError('MAP_UNAVAILABLE', 'The map service sent something unexpected.', 503);
    return buf;
  };

  async function googleSession(key: string, style: Exclude<MapStyle, 'osm'>): Promise<string> {
    if (session && session.key === key && session.style === style && session.expiry > Date.now() + 60_000) return session.id;
    const r = await fetcher(`${GOOGLE_SESSION}?key=${encodeURIComponent(key)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...GOOGLE_MAPS[style], language: 'en-IN', region: 'IN' }), signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => null);
    if (!r) throw new host.AppError('MAP_UNAVAILABLE', 'The map could not be loaded. Check the internet connection.', 503);
    const j = await r.json().catch(() => null) as { session?: unknown; expiry?: unknown } | null;
    if (!r.ok || typeof j?.session !== 'string') throw new host.AppError('MAP_KEY', googleRefusal(j, 'Map Tiles API'), 503);
    const expiry = Number(j.expiry) * 1000; // seconds
    session = { key, style, id: j.session, expiry: Number.isFinite(expiry) && expiry > Date.now() ? expiry : Date.now() + 3_600_000 };
    return session.id;
  }

  async function tile(z: number, x: number, y: number): Promise<Buffer> {
    if (![z, x, y].every(Number.isInteger) || z < 0 || z > 19 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) throw new host.AppError('NOT_FOUND', 'No such map tile.', 404);
    const key = googleKeyInUse(host), style = readMapStyle(host);
    if (key && style !== 'osm') {
      const k = `${style}/${z}/${x}/${y}`;
      const hit = memo.get(k);
      if (hit) return hit;
      if (!isOnlineMode(host)) throw new host.AppError('OFFLINE_MODE', 'Turn on online orders to load the map.', 409);
      const s = await googleSession(key, style);
      let r = await fetcher(`${GOOGLE_TILE}${z}/${x}/${y}?session=${encodeURIComponent(s)}&key=${encodeURIComponent(key)}`, { headers: {}, signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => null);
      if (r && (r.status === 401 || r.status === 403)) { session = null; throw new host.AppError('MAP_KEY', googleRefusal(await r.json().catch(() => null), 'Map Tiles API'), 503); }
      if (r && r.status === 400) { session = null; r = null; } // the session ran out: the next tile makes a new one
      if (!r || !r.ok) throw new host.AppError('MAP_UNAVAILABLE', 'The map could not be loaded. Check the internet connection.', 503);
      const img = imageOf(Buffer.from(await r.arrayBuffer()));
      if (memo.size > 400) memo.clear();
      memo.set(k, img);
      return img;
    }
    const dir = join(host.dataDir, 'tiles', 'osm');
    const file = join(dir, String(z), String(x), `${y}.png`);
    if (existsSync(file)) return readFileSync(file);
    if (!isOnlineMode(host)) throw new host.AppError('OFFLINE_MODE', 'Turn on online orders to load the map.', 409);
    const r = await fetcher(OSM.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)), { headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => null);
    if (!r || !r.ok) throw new host.AppError('MAP_UNAVAILABLE', 'The map could not be loaded. Check the internet connection.', 503);
    const png = imageOf(Buffer.from(await r.arrayBuffer()));
    mkdirSync(join(dir, String(z), String(x)), { recursive: true });
    writeFileSync(file, png);
    return png;
  }

  /** Settings > Serviceability > Map > Test key: one road map session (no tiles). */
  async function testTiles(): Promise<{ ok: boolean; message: string }> {
    const key = readGoogleKey(host);
    if (!key) return { ok: false, message: 'No Google key saved.' };
    session = null;
    try { await googleSession(key, 'google-road'); return { ok: true, message: 'Map pictures work.' }; } catch (e) { return { ok: false, message: (e as Error).message }; }
  }

  return { tile, testTiles };
}
