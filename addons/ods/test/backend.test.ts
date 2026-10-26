import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AppError, get } from '../../../src/store/db.ts';
import { makeHost } from '../../../src/addons/host.ts';
import type { AddonRoute } from '../../../src/addons/host.ts';
import { makeEnv, rid } from '../../../test/helpers.ts';
import type { Env } from '../../../test/helpers.ts';
import { readOnlineConfig, saveOnlineConfig } from '../backend/onlineConfig.ts';
import type { OnlineInput } from '../backend/onlineConfig.ts';
import { readServiceability, saveServiceability } from '../backend/serviceability.ts';
import { makeMaps } from '../backend/maps.ts';
import { apiKeysView, mapView, saveGoogleKey, saveMapStyle } from '../backend/store.ts';
import { mapAttribution } from '../backend/maps.ts';
import { makePlaces } from '../backend/places.ts';
import type { Fetcher } from '../backend/maps.ts';
import { register } from '../backend/index.ts';
import { DEFAULT_SERVICEABILITY } from '../../../contract/src/serviceability.ts';

const code = async (fn: () => unknown): Promise<string> => { try { await fn(); } catch (e) { if (e instanceof AppError) return e.code; throw e; } return 'NO_ERROR'; };
const OFF = { app: false, website: false, swiggy: false, zomato: false };
const DEFAULTS = { acceptMode: 'manual', acceptTimeoutMin: 5, fulfilment: { pickup: true, delivery: true }, payments: { online: true, cod: true } } as const;
const input = (o: Partial<OnlineInput> = {}): OnlineInput => ({ enabled: true, channels: { ...OFF, app: true }, ...DEFAULTS, ...o });
const hostFor = (env: Env) => { const sink = { routes: [] as AddonRoute[], migrations: [], stops: [] as Array<() => void | Promise<void>> }; return { host: makeHost(env.ctx, 'ods', '0.3.0', sink), sink }; };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]);
const fakeNet = () => {
  const calls: string[] = [];
  const f: Fetcher = async (url) => { calls.push(url); return url.includes('nominatim')
    ? { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0), json: async () => [{ display_name: 'Kalyan Nagar, Bengaluru', lat: '13.0213', lon: '77.6460' }, { display_name: 'bad', lat: 'x', lon: '1' }] }
    : { ok: true, status: 200, arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.length), json: async () => null }; };
  return { f, calls };
};

test('online orders settings (now in the add-on): offline by default, owner turns on with channels, options checked', async () => {
  const env = makeEnv(); try {
    const { host } = hostFor(env);
    assert.deepEqual(readOnlineConfig(host), { enabled: false, channels: OFF, mode: 'offline', ...DEFAULTS });
    assert.equal(await code(() => saveOnlineConfig(host, env.manager, rid(), input())), 'FORBIDDEN');
    assert.equal(await code(() => saveOnlineConfig(host, env.owner, rid(), input({ channels: OFF }))), 'VALIDATION');
    assert.equal(await code(() => saveOnlineConfig(host, env.owner, rid(), input({ acceptTimeoutMin: 16 }))), 'VALIDATION');
    assert.equal(await code(() => saveOnlineConfig(host, env.owner, rid(), input({ fulfilment: { pickup: false, delivery: false } }))), 'VALIDATION');
    const on = saveOnlineConfig(host, env.owner, rid(), input({ acceptMode: 'auto', channels: { ...OFF, website: true, zomato: true } }));
    assert.deepEqual([on.enabled, on.mode, on.acceptMode, on.channels], [true, 'online', 'auto', { ...OFF, website: true, zomato: true }]);
    assert.ok(get(env.ctx.db, "SELECT 1 FROM audit_log WHERE action = 'online.config'"));
  } finally { env.cleanup(); }
});

test('serviceability: defaults until saved; owner saves a checked configuration; field errors come back by name', async () => {
  const env = makeEnv(); try {
    const { host } = hostFor(env);
    const d = readServiceability(host);
    assert.deepEqual([d.location, d.zones.length, d.updatedAt], [null, 2, null]);
    const cfg = { ...DEFAULT_SERVICEABILITY, location: { lat: 13.0213, lng: 77.646, label: 'Kalyan Nagar' }, packagingFee: 1000 };
    assert.equal(await code(() => saveServiceability(host, env.manager, rid(), cfg)), 'FORBIDDEN');
    try { saveServiceability(host, env.owner, rid(), { ...cfg, zones: [{ ...cfg.zones[0]!, upToKm: 40 }] }); assert.fail(); }
    catch (e) { assert.ok(e instanceof AppError && e.code === 'VALIDATION'); assert.ok((e.details as { fields: Record<string, string> }).fields['zones.0.upToKm']); }
    const saved = saveServiceability(host, env.owner, rid(), cfg);
    assert.deepEqual([saved.location?.label, saved.packagingFee], ['Kalyan Nagar', 1000]);
    assert.deepEqual(readServiceability(host).location, cfg.location);
    assert.ok(get(env.ctx.db, "SELECT 1 FROM audit_log WHERE action = 'online.serviceability'"));
  } finally { env.cleanup(); }
});

test('map tiles: only in online mode, cached on disk, per provider', async () => {
  const env = makeEnv(); try {
    const { host } = hostFor(env);
    const net = fakeNet();
    const maps = makeMaps(host, net.f);
    assert.equal(await code(() => maps.tile(12, 2925, 1880)), 'OFFLINE_MODE'); // offline mode: no connection at all
    assert.equal(net.calls.length, 0);
    saveOnlineConfig(host, env.owner, rid(), input());
    assert.deepEqual(await maps.tile(12, 2925, 1880), PNG);
    assert.ok(existsSync(join(host.dataDir, 'tiles', 'osm', '12', '2925', '1880.png')));
    saveOnlineConfig(host, env.owner, rid(), input({ enabled: false }));
    assert.deepEqual(await maps.tile(12, 2925, 1880), PNG, 'a cached tile still shows offline');
    assert.equal(net.calls.length, 1);
    assert.equal(await code(() => maps.tile(3, 9, 0)), 'NOT_FOUND'); // x beyond 2^z
    assert.equal(await code(() => maps.tile(20, 0, 0)), 'NOT_FOUND');
  } finally { env.cleanup(); }
});

test('map choice: the free map by default and with a key; Google road, satellite or both when chosen; one session per map, tiles not kept on disk', async () => {
  const env = makeEnv(); try {
    const { host } = hostFor(env);
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    let sessionAnswer: { status: number; json: unknown } = { status: 200, json: { session: 'SESS1', expiry: String(Math.floor(Date.now() / 1000) + 3600) } };
    const f: Fetcher = async (url, init) => {
      calls.push({ url, method: init.method, body: init.body });
      if (url.includes('createSession')) return { ok: sessionAnswer.status < 400, status: sessionAnswer.status, arrayBuffer: async () => new ArrayBuffer(0), json: async () => sessionAnswer.json };
      return { ok: true, status: 200, arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.length), json: async () => null };
    };
    const maps = makeMaps(host, f);
    saveOnlineConfig(host, env.owner, rid(), input());
    assert.throws(() => saveGoogleKey(host, env.manager, 'AIzaSyTESTKEYtestkeyTESTKEYtestkey12345'), /permission|not allowed|owner/i);
    assert.throws(() => saveGoogleKey(host, env.owner, 'AIza-too-short'), /not a Google API key/);
    saveGoogleKey(host, env.owner, 'AIzaSyTESTKEYtestkeyTESTKEYtestkey12345');
    assert.deepEqual(apiKeysView(host), { google: { set: true, hint: '…2345' } });
    assert.ok(get(env.ctx.db, "SELECT 1 FROM audit_log WHERE action = 'ods.api_key.set'"), 'the change is audited');
    // a saved key does not take away the free map: Google is used only when the owner chooses a Google map
    assert.equal(mapAttribution(host).style, 'osm');
    assert.deepEqual(await maps.tile(12, 2925, 1879), PNG);
    assert.match(calls.at(-1)!.url, /tile.openstreetmap.org/);
    assert.throws(() => saveMapStyle(host, env.manager, 'google-road'), /permission|not allowed|owner/i);
    assert.throws(() => saveMapStyle(host, env.owner, 'bing'), /Choose a map/);
    assert.deepEqual(mapView(host).styles.map((s) => [s.id, s.available]), [['osm', true], ['google-road', true], ['google-satellite', true], ['google-hybrid', true]]);
    saveMapStyle(host, env.owner, 'google-road');
    assert.equal(mapView(host).style, 'google-road');
    calls.length = 0;
    assert.deepEqual(await maps.tile(12, 2925, 1880), PNG);
    await maps.tile(12, 2925, 1881);
    await maps.tile(12, 2925, 1880); // from memory
    assert.equal(calls.filter((c) => c.url.includes('createSession')).length, 1, 'one session for many tiles');
    assert.equal(calls.find((c) => c.url.includes('createSession'))!.method, 'POST');
    assert.equal(calls.filter((c) => c.url.includes('/2dtiles/')).length, 2);
    assert.match(calls.find((c) => c.url.includes('/2dtiles/'))!.url, /^https:\/\/tile\.googleapis\.com\/v1\/2dtiles\/12\/2925\/1880\?session=SESS1&key=AIza/);
    assert.ok(!existsSync(join(host.dataDir, 'tiles', 'osm', '12', '2925', '1881.png')), 'Google tiles are not saved on disk');
    assert.deepEqual(JSON.parse(calls.find((c) => c.url.includes('createSession'))!.body!), { mapType: 'roadmap', language: 'en-IN', region: 'IN' });
    // satellite with road names: its own session and its own pictures
    saveMapStyle(host, env.owner, 'google-hybrid');
    await maps.tile(12, 2925, 1880);
    const sessions = calls.filter((c) => c.url.includes('createSession'));
    assert.equal(sessions.length, 2);
    assert.deepEqual(JSON.parse(sessions[1]!.body!), { mapType: 'satellite', layerTypes: ['layerRoadmap'], language: 'en-IN', region: 'IN' });
    assert.equal(calls.filter((c) => c.url.includes('/2dtiles/')).length, 3, 'not the road map picture from memory');
    saveMapStyle(host, env.owner, 'google-satellite');
    await maps.tile(12, 2925, 1880);
    assert.deepEqual(JSON.parse(calls.filter((c) => c.url.includes('createSession'))[2]!.body!), { mapType: 'satellite', language: 'en-IN', region: 'IN' });
    saveMapStyle(host, env.owner, 'osm');
    assert.equal(mapView(host).style, 'osm');
    saveMapStyle(host, env.owner, 'google-road');
    // the Map Tiles API is not switched on: the owner is told what to do
    sessionAnswer = { status: 403, json: { error: { status: 'PERMISSION_DENIED', message: 'Map Tiles API has not been used in project 1 before or it is disabled.' } } };
    assert.match((await maps.testTiles()).message, /Map Tiles API is not switched on.*Enable/);
    // key removed: back to the free map
    saveGoogleKey(host, env.owner, null);
    assert.deepEqual(apiKeysView(host), { google: { set: false, hint: null } });
    assert.equal(mapView(host).style, 'osm');
    assert.deepEqual(mapView(host).styles.map((s) => s.available), [true, false, false, false]);
    assert.throws(() => saveMapStyle(host, env.owner, 'google-road'), /Google Maps key/);
    assert.deepEqual(await maps.tile(12, 2925, 1882), PNG);
    assert.match(calls.at(-1)!.url, /tile\.openstreetmap\.org/);
    assert.ok(!get(env.ctx.db, "SELECT 1 FROM audit_log WHERE action LIKE 'ods.api_key%' AND detail LIKE '%AIza%'"), 'the key is never written to the audit log');
  } finally { env.cleanup(); }
});

test('the add-on registers its routes under /api/addons/ods', async () => {
  const env = makeEnv(); const stops: Array<() => void | Promise<void>> = []; try {
    const { host, sink } = hostFor(env);
    register(host);
    stops.push(...sink.stops);
    assert.deepEqual(sink.routes.map((r) => `${r.method} ${r.path}`).sort(), [
      'DELETE /api/addons/ods/hub', 'GET /api/addons/ods/api-keys', 'GET /api/addons/ods/config', 'GET /api/addons/ods/events', 'GET /api/addons/ods/geocode', 'GET /api/addons/ods/geocode/place', 'GET /api/addons/ods/hub', 'GET /api/addons/ods/map', 'GET /api/addons/ods/menu-sync',
      'GET /api/addons/ods/orders', 'GET /api/addons/ods/print-options', 'GET /api/addons/ods/serviceability', 'GET /api/addons/ods/tax-groups', 'GET /api/addons/ods/tiles/:z/:x/:y',
      'POST /api/addons/ods/api-keys/test', 'POST /api/addons/ods/hub/pair', 'POST /api/addons/ods/menu-sync/now', 'POST /api/addons/ods/orders/:id/accept', 'POST /api/addons/ods/orders/:id/print-bill', 'POST /api/addons/ods/orders/:id/print-kot', 'POST /api/addons/ods/orders/:id/reject', 'POST /api/addons/ods/orders/:id/step',
      'PUT /api/addons/ods/api-keys', 'PUT /api/addons/ods/config', 'PUT /api/addons/ods/map', 'PUT /api/addons/ods/menu-sync', 'PUT /api/addons/ods/print-options', 'PUT /api/addons/ods/serviceability',
    ]);
    assert.equal(sink.routes.find((r) => r.path.endsWith('/tiles/:z/:x/:y'))!.opts.auth, false);
  } finally { for (const s of stops) await s(); env.cleanup(); }
});

test('place search: suggestions while typing (free Photon, India only, near the shop), Nominatim on Enter; Google Places when a Google map is chosen', async () => {
  const env = makeEnv(); try {
    const { host } = hostFor(env);
    const calls: Array<{ url: string; method?: string; headers: Record<string, string>; body?: string }> = [];
    const reply = (json: unknown, status = 200) => ({ ok: status < 400, status, arrayBuffer: async () => new ArrayBuffer(0), json: async () => json });
    let googleStatus = 200;
    const f: Fetcher = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, body: init.body });
      if (url.includes('photon') && url.includes('q=empire%20brookfield')) return reply({ features: [] });
      if (url.includes('photon') && url.includes('q=empire&')) return reply({ features: [0, 1].map(() => ({ properties: { name: 'Empire', street: 'ITPL Main Road', district: 'Priyadarshini Ward', countrycode: 'IN' }, geometry: { coordinates: [77.7175, 12.9661] } })) });
      if (url.includes('photon')) return reply({ features: url.includes('nothing') ? [] : [
        { properties: { name: 'Brookfield Mall', district: 'Priyadarshini Ward', city: 'Bengaluru', state: 'Karnataka', countrycode: 'IN' }, geometry: { coordinates: [77.7166, 12.9667] } },
        { properties: { name: 'Brookfield', city: 'Brookfield', state: 'WI', countrycode: 'US' }, geometry: { coordinates: [-88.1, 43.0] } },
        { properties: { street: 'ITPL Main Road', housenumber: '12', countrycode: 'IN' }, geometry: { coordinates: [77.72, 12.98] } },
      ] });
      if (url.includes('nominatim')) return reply([{ name: '', display_name: '12, 4th Cross, Kalyan Nagar, Bengaluru', lat: '13.0213', lon: '77.6460' }]);
      if (url.includes('places:autocomplete')) return reply({ suggestions: [{ placePrediction: { placeId: 'ChIJempire', text: { text: 'Empire Restaurant, Brookfield' }, structuredFormat: { mainText: { text: 'Empire Restaurant' }, secondaryText: { text: 'Brookfield, Bengaluru' } } } }] }, googleStatus);
      if (url.includes('places.googleapis.com/v1/places/')) return reply({ location: { latitude: 12.9661, longitude: 77.7175 }, formattedAddress: 'ITPL Main Rd, Brookfield, Bengaluru', displayName: { text: 'Empire Restaurant' } });
      return reply(null, 404);
    };
    const places = makePlaces(host, f);
    assert.equal(await code(() => places.suggest('brookfield')), 'OFFLINE_MODE');
    assert.equal(calls.length, 0, 'offline mode: no connection at all');
    saveOnlineConfig(host, env.owner, rid(), input());
    assert.equal(await code(() => places.suggest('br')), 'VALIDATION');

    // free: Photon, India only, biased to the shop
    const free = await places.suggest('  brook  field', { near: { lat: 12.96677, lng: 77.71661 } });
    assert.deepEqual(free, [
      { label: 'Brookfield Mall', detail: 'Priyadarshini Ward, Bengaluru, Karnataka', lat: 12.9667, lng: 77.7166, placeId: null },
      { label: '12, ITPL Main Road', detail: '', lat: 12.98, lng: 77.72, placeId: null },
    ]);
    assert.match(calls[0]!.url, /photon\.komoot\.io.*bbox=68\.1,6\.5,97\.4,35\.7&lat=12\.97&lon=77\.72/);
    await places.suggest('brook field', { near: { lat: 12.96677, lng: 77.71661 } });
    assert.equal(calls.length, 1, 'cached');
    // the map names the area differently: fewer words are tried; the same place twice is shown once
    assert.deepEqual(await places.suggest('empire brookfield'), [{ label: 'Empire', detail: 'ITPL Main Road, Priyadarshini Ward', lat: 12.9661, lng: 77.7175, placeId: null }]);
    // nothing on Photon: Nominatim only when the owner pressed Enter
    assert.deepEqual(await places.suggest('nothing here'), []);
    assert.equal(calls.filter((c) => c.url.includes('nominatim')).length, 0);
    assert.equal((await places.suggest('nothing here', { full: true }))[0]!.label, '12');
    assert.equal(calls.filter((c) => c.url.includes('nominatim')).length, 1);

    // a saved key alone keeps the free search; Google Places once a Google map is chosen
    saveGoogleKey(host, env.owner, 'AIzaSyTESTKEYtestkeyTESTKEYtestkey12345');
    await places.suggest('kalyan nagar');
    assert.ok(!calls.some((c) => c.url.includes('googleapis')), 'free map chosen: free search');
    saveMapStyle(host, env.owner, 'google-road');
    const g = await places.suggest('empire brookfield', { near: { lat: 12.97, lng: 77.72 }, session: 's1' });
    assert.deepEqual(g, [{ label: 'Empire Restaurant', detail: 'Brookfield, Bengaluru', lat: null, lng: null, placeId: 'g:ChIJempire' }]);
    const gc = calls.find((c) => c.url.includes('places:autocomplete'))!;
    assert.equal(gc.method, 'POST');
    assert.equal(gc.headers['X-Goog-Api-Key'], 'AIzaSyTESTKEYtestkeyTESTKEYtestkey12345');
    assert.deepEqual(JSON.parse(gc.body!).includedRegionCodes, ['in']);
    assert.ok(!gc.url.includes('AIza'), 'the key is not in the address');
    // only Essentials fields are asked for (the cheapest tier, largest free allowance)
    assert.deepEqual(await places.place('g:ChIJempire', 's1'), { label: 'ITPL Main Rd, Brookfield, Bengaluru', lat: 12.9661, lng: 77.7175 });
    assert.equal(calls.find((c) => c.url.includes('/v1/places/ChIJempire'))!.headers['X-Goog-FieldMask'], 'location,formattedAddress');
    assert.equal(await code(() => places.place('g:../../x')), 'VALIDATION');
    googleStatus = 403;
    assert.equal(await code(() => places.suggest('empire again')), 'MAP_KEY');
    saveGoogleKey(host, env.owner, null);
    assert.equal((await places.suggest('brook field', { near: { lat: 12.96677, lng: 77.71661 } }))[0]!.label, 'Brookfield Mall', 'no key: the free search again');

  } finally { env.cleanup(); }
});
