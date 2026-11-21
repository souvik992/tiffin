import type { HostApi } from '../../../src/addons/host.ts';
import { isOnlineMode } from './onlineConfig.ts';
import type { Fetcher } from './maps.ts';

/**
 * Place search for Settings > Serviceability (suggestions while typing). Fetched by the POS, never by the page, and only
 * in online mode.
 *   Photon (OpenStreetMap data, made for type-as-you-go), limited to India and biased to the shop;
 *           fewer words are tried when a phrase finds nothing; Nominatim once on Enter (it does not allow type-as-you-go).
 *   address(): the nearest address for a map point (Photon reverse), for the pin moved by hand.
 */

export interface Place { label: string; detail: string; lat: number | null; lng: number | null; placeId: string | null }

const PHOTON = 'https://photon.komoot.io/api/';
const PHOTON_REVERSE = 'https://photon.komoot.io/reverse';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const INDIA_BBOX = '68.1,6.5,97.4,35.7';
const TIMEOUT_MS = 8000;
const BENGALURU = { lat: 12.9716, lng: 77.5946 };

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const join = (parts: unknown[]) => [...new Set(parts.map(str).filter(Boolean))].join(', ');
const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN);

export function makePlaces(host: HostApi, fetcher: Fetcher) {
  const ua = `quickPOS-ODS/1.0 (POS ${host.posVersion}; store settings map)`;
  const cache = new Map<string, Place[]>();
  let lastOsm = 0, lastNominatim = 0;
  const wait = async (last: number, gapMs: number) => { const w = last + gapMs - Date.now(); if (w > 0) await new Promise((r) => setTimeout(r, w)); };
  const unavailable = () => new host.AppError('MAP_UNAVAILABLE', 'Place search is not available right now. Drag the pin on the map instead.', 503);

  async function getJson(url: string, init: { method?: string; headers: Record<string, string>; body?: string }): Promise<unknown> {
    const r = await fetcher(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => null);
    if (!r || !r.ok) throw unavailable();
    return r.json().catch(() => null);
  }

  async function photon(q: string, near: { lat: number; lng: number }): Promise<Place[]> {
    await wait(lastOsm, 300); lastOsm = Date.now();
    const raw = await getJson(`${PHOTON}?q=${encodeURIComponent(q)}&limit=8&lang=en&bbox=${INDIA_BBOX}&lat=${near.lat}&lon=${near.lng}&zoom=13&location_bias_scale=0.6`, { headers: { 'User-Agent': ua } }) as { features?: unknown[] } | null;
    return (raw?.features ?? []).map((f) => {
      const p = ((f as { properties?: Record<string, unknown> }).properties ?? {});
      const c = ((f as { geometry?: { coordinates?: unknown[] } }).geometry?.coordinates ?? []);
      const street = join([p.housenumber, p.street]);
      const label = str(p.name) || street;
      return { label, detail: join([p.name ? street : '', p.district ?? p.locality, p.city, p.state, p.postcode]), lat: num(c[1]), lng: num(c[0]), placeId: null, cc: str(p.countrycode) };
    }).filter((x) => x.label && x.cc === 'IN' && Number.isFinite(x.lat) && Number.isFinite(x.lng)).slice(0, 6).map(({ cc: _cc, ...x }) => x);
  }

  async function nominatim(q: string): Promise<Place[]> {
    await wait(lastNominatim, 1100); lastNominatim = Date.now(); // its policy: at most one search a second, no type-as-you-go
    const raw = await getJson(`${NOMINATIM}?format=jsonv2&countrycodes=in&limit=5&q=${encodeURIComponent(q)}`, { headers: { 'User-Agent': ua, 'Accept-Language': 'en' } });
    return (Array.isArray(raw) ? raw : []).map((p: { name?: unknown; display_name?: unknown; lat?: unknown; lon?: unknown }) => {
      const full = str(p.display_name);
      const label = str(p.name) || full.split(',')[0]!.trim();
      return { label, detail: full.startsWith(label) ? full.slice(label.length).replace(/^,\s*/, '') : full, lat: num(p.lat), lng: num(p.lon), placeId: null };
    }).filter((x) => x.label && Number.isFinite(x.lat) && Number.isFinite(x.lng));
  }

  /** Suggestions for what the owner typed. `full` = Enter / Search pressed (allows the slower fallback). */
  async function suggest(qIn: string, o: { near?: { lat: number; lng: number } | null; full?: boolean } = {}): Promise<Place[]> {
    const q = qIn.trim().replace(/\s+/g, ' ');
    if (q.length < 3 || q.length > 200) throw new host.AppError('VALIDATION', 'Type at least 3 letters.');
    const near = o.near && Number.isFinite(o.near.lat) && Number.isFinite(o.near.lng) ? { lat: Math.round(o.near.lat * 100) / 100, lng: Math.round(o.near.lng * 100) / 100 } : BENGALURU;
    const k = `${near.lat},${near.lng}|${o.full ? 1 : 0}|${q.toLowerCase()}`;
    const hit = cache.get(k);
    if (hit) return hit;
    if (!isOnlineMode(host)) throw new host.AppError('OFFLINE_MODE', 'Turn on online orders to search places.', 409);
    let out = await photon(q, near);
    {
      // "empire brookfield": the map may name the area differently (Priyadarshini Ward), so try fewer words; results
      // are ranked by distance from the shop, so the nearby one comes first
      for (let words = q.split(' '); !out.length && words.length > 1;) {
        words = words.slice(0, -1);
        if (words.join(' ').length < 3) break;
        out = await photon(words.join(' '), near);
      }
      if (!out.length && o.full) out = await nominatim(q);
    }
    const seen = new Set<string>();
    out = out.filter((p) => { const k = `${p.label}|${p.detail}`.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
    if (cache.size > 500) cache.clear();
    cache.set(k, out);
    return out;
  }

  const reverseCache = new Map<string, string>();
  /** The address nearest to a map point ('' when the map has none), for the address field after the pin is moved. */
  async function address(lat: number, lng: number): Promise<string> {
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 6 || lat > 38 || lng < 68 || lng > 98) throw new host.AppError('VALIDATION', 'Choose a point in India.');
    const k = `${lat.toFixed(5)},${lng.toFixed(5)}`;
    const hit = reverseCache.get(k);
    if (hit !== undefined) return hit;
    if (!isOnlineMode(host)) throw new host.AppError('OFFLINE_MODE', 'Turn on online orders to look up addresses.', 409);
    await wait(lastOsm, 300); lastOsm = Date.now();
    const raw = await getJson(`${PHOTON_REVERSE}?lat=${lat}&lon=${lng}&limit=1&lang=en`, { headers: { 'User-Agent': ua } }) as { features?: unknown[] } | null;
    const p = ((raw?.features?.[0] as { properties?: Record<string, unknown> } | undefined)?.properties ?? {});
    const out = str(p.countrycode) && str(p.countrycode) !== 'IN' ? ''
      : join([p.name, join([p.housenumber, p.street]), p.locality, p.district, p.city ?? p.county, p.state, p.postcode]).slice(0, 200);
    if (reverseCache.size > 500) reverseCache.clear();
    reverseCache.set(k, out);
    return out;
  }

  return { suggest, address };
}
