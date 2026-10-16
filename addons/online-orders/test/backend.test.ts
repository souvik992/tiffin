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
import type { Fetcher } from '../backend/maps.ts';
import { register } from '../backend/index.ts';
import { DEFAULT_SERVICEABILITY } from '../../../contract/src/serviceability.ts';

const code = async (fn: () => unknown): Promise<string> => { try { await fn(); } catch (e) { if (e instanceof AppError) return e.code; throw e; } return 'NO_ERROR'; };
const OFF = { app: false, website: false, swiggy: false, zomato: false };
const DEFAULTS = { acceptMode: 'manual', acceptTimeoutMin: 5, fulfilment: { pickup: true, delivery: true }, payments: { online: true, cod: true } } as const;
const input = (o: Partial<OnlineInput> = {}): OnlineInput => ({ enabled: true, channels: { ...OFF, app: true }, ...DEFAULTS, ...o });
const hostFor = (env: Env) => { const sink = { routes: [] as AddonRoute[], migrations: [], stops: [] }; return { host: makeHost(env.ctx, 'online-orders', '0.2.0', sink), sink }; };
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

test('map tiles and address search: only in online mode, cached on disk, polite to the map service', async () => {
  const env = makeEnv(); try {
    const { host } = hostFor(env);
    const net = fakeNet();
    const maps = makeMaps(host, net.f);
    assert.equal(await code(() => maps.tile(12, 2925, 1880)), 'OFFLINE_MODE'); // offline mode: no connection at all
    assert.equal(await code(() => maps.search('Kalyan Nagar')), 'OFFLINE_MODE');
    assert.equal(net.calls.length, 0);
    saveOnlineConfig(host, env.owner, rid(), input());
    assert.deepEqual(await maps.tile(12, 2925, 1880), PNG);
    assert.ok(existsSync(join(host.dataDir, 'tiles', '12', '2925', '1880.png')));
    saveOnlineConfig(host, env.owner, rid(), input({ enabled: false }));
    assert.deepEqual(await maps.tile(12, 2925, 1880), PNG, 'a cached tile still shows offline');
    assert.equal(net.calls.length, 1);
    assert.equal(await code(() => maps.tile(3, 9, 0)), 'NOT_FOUND'); // x beyond 2^z
    assert.equal(await code(() => maps.tile(20, 0, 0)), 'NOT_FOUND');
    saveOnlineConfig(host, env.owner, rid(), input());
    assert.deepEqual(await maps.search('  Kalyan   Nagar '), [{ label: 'Kalyan Nagar, Bengaluru', lat: 13.0213, lng: 77.646 }]);
    await maps.search('kalyan nagar'); // cached: no second request
    assert.equal(net.calls.filter((u) => u.includes('nominatim')).length, 1);
    assert.match(net.calls.find((u) => u.includes('nominatim'))!, /countrycodes=in/);
    assert.equal(await code(() => maps.search('ab')), 'VALIDATION');
  } finally { env.cleanup(); }
});

test('the add-on registers its routes under /api/addons/online-orders', () => {
  const env = makeEnv(); try {
    const { host, sink } = hostFor(env);
    register(host);
    assert.deepEqual(sink.routes.map((r) => `${r.method} ${r.path}`).sort(), [
      'GET /api/addons/online-orders/config', 'GET /api/addons/online-orders/geocode', 'GET /api/addons/online-orders/serviceability',
      'GET /api/addons/online-orders/tiles/:z/:x/:y', 'PUT /api/addons/online-orders/config', 'PUT /api/addons/online-orders/serviceability',
    ]);
    assert.equal(sink.routes.find((r) => r.path.endsWith('/tiles/:z/:x/:y'))!.opts.auth, false);
  } finally { env.cleanup(); }
});
