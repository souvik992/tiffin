import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { HostApi } from '../../../src/addons/host.ts';
import { isOnlineMode } from './onlineConfig.ts';

/**
 * Map tiles and address search for Settings > Serviceability, fetched by the POS (never by the page) so the window's
 * strict Content-Security-Policy stays as it is. Only while online orders are on (offline mode makes no connection);
 * tiles already on disk keep working offline. Sources: OpenStreetMap tiles and Nominatim search, used lightly (a
 * settings screen), cached, with an identifying User-Agent, as their usage policies ask. A shop chain at scale should
 * switch to a paid tile provider (TILE_URL below).
 */

const TILE_URL = (z: number, x: number, y: number) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
const SEARCH_URL = 'https://nominatim.openstreetmap.org/search';
const TIMEOUT_MS = 8000;

export interface Fetcher { (url: string, init: { headers: Record<string, string>; signal: AbortSignal }): Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer>; json(): Promise<unknown> }> }

export function makeMaps(host: HostApi, fetcher: Fetcher = fetch as unknown as Fetcher) {
  const ua = `TiffinPOS-OnlineOrders/1.0 (POS ${host.posVersion}; store settings map)`;
  const tileDir = join(host.dataDir, 'tiles');
  const searchCache = new Map<string, unknown>();
  let lastSearch = 0;

  async function tile(z: number, x: number, y: number): Promise<Buffer> {
    if (![z, x, y].every(Number.isInteger) || z < 0 || z > 19 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) throw new host.AppError('NOT_FOUND', 'No such map tile.', 404);
    const file = join(tileDir, String(z), String(x), `${y}.png`);
    if (existsSync(file)) return readFileSync(file);
    if (!isOnlineMode(host)) throw new host.AppError('OFFLINE_MODE', 'Turn on online orders to load the map.', 409);
    const r = await fetcher(TILE_URL(z, x, y), { headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => null);
    if (!r || !r.ok) throw new host.AppError('MAP_UNAVAILABLE', 'The map could not be loaded. Check the internet connection.', 503);
    const png = Buffer.from(await r.arrayBuffer());
    if (png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) throw new host.AppError('MAP_UNAVAILABLE', 'The map service sent something unexpected.', 503);
    mkdirSync(join(tileDir, String(z), String(x)), { recursive: true });
    writeFileSync(file, png);
    return png;
  }

  async function search(q: string): Promise<Array<{ label: string; lat: number; lng: number }>> {
    const query = q.trim().replace(/\s+/g, ' ');
    if (query.length < 3 || query.length > 200) throw new host.AppError('VALIDATION', 'Type at least 3 letters of the address.');
    if (searchCache.has(query.toLowerCase())) return searchCache.get(query.toLowerCase()) as Array<{ label: string; lat: number; lng: number }>;
    if (!isOnlineMode(host)) throw new host.AppError('OFFLINE_MODE', 'Turn on online orders to search addresses.', 409);
    const wait = lastSearch + 1100 - Date.now(); // Nominatim: at most one search a second
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastSearch = Date.now();
    const url = `${SEARCH_URL}?format=jsonv2&countrycodes=in&limit=5&q=${encodeURIComponent(query)}`;
    const r = await fetcher(url, { headers: { 'User-Agent': ua, 'Accept-Language': 'en' }, signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => null);
    if (!r || !r.ok) throw new host.AppError('MAP_UNAVAILABLE', 'Address search is not available right now. Drag the pin on the map instead.', 503);
    const raw = await r.json();
    const out = (Array.isArray(raw) ? raw : []).slice(0, 5).map((p: { display_name?: unknown; lat?: unknown; lon?: unknown }) => ({ label: String(p.display_name ?? '').slice(0, 200), lat: Number(p.lat), lng: Number(p.lon) }))
      .filter((p) => p.label && Number.isFinite(p.lat) && Number.isFinite(p.lng));
    searchCache.set(query.toLowerCase(), out);
    return out;
  }
  return { tile, search };
}
