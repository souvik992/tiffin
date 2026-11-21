import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { HostApi } from '../../../src/addons/host.ts';
import { isOnlineMode } from './onlineConfig.ts';

/**
 * Map pictures (tiles) for Settings > Serviceability, fetched by the POS (never by the page, so the window's strict
 * Content-Security-Policy stays). Only while online orders are on. The free OpenStreetMap map only (the owner's choice,
 * 2026-11-21: Google maps were removed); tiles are used lightly and saved on disk, so they keep working offline.
 */

const OSM = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TIMEOUT_MS = 8000;

export interface Fetcher { (url: string, init: { method?: string; headers: Record<string, string>; body?: string; signal: AbortSignal }): Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer>; json(): Promise<unknown> }> }

export function mapAttribution(): { provider: 'osm'; attribution: string } {
  return { provider: 'osm', attribution: '&copy; OpenStreetMap contributors' };
}

export function makeMaps(host: HostApi, fetcher: Fetcher = fetch as unknown as Fetcher) {
  const ua = `quickPOS-ODS/1.0 (POS ${host.posVersion}; store settings map)`;

  const imageOf = (buf: Buffer) => {
    const isPng = buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47, isJpeg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8;
    if (!isPng && !isJpeg) throw new host.AppError('MAP_UNAVAILABLE', 'The map service sent something unexpected.', 503);
    return buf;
  };

  async function tile(z: number, x: number, y: number): Promise<Buffer> {
    if (![z, x, y].every(Number.isInteger) || z < 0 || z > 19 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) throw new host.AppError('NOT_FOUND', 'No such map tile.', 404);
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

  return { tile };
}
