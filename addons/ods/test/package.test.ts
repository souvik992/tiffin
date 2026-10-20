import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBackend } from '../../../src/app.ts';

const DIST = join(import.meta.dirname, '..', '..', 'dist', 'packages');
const silent = { info() {}, warn() {}, error() {} };

test('the signed package (npm run build) loads in a real POS with its built-in trusted key, and its routes answer', { skip: !existsSync(join(DIST, 'ods', 'manifest.json')) && 'run npm run build first' }, async () => {
  const data = mkdtempSync(join(tmpdir(), 'pos-oo-'));
  const b = await startBackend({ dataDir: data, port: 0, logger: silent, scheduleBackups: false, addonsDir: DIST, posVersion: '0.3.4' });
  const base = `http://127.0.0.1:${b.port}`;
  const call = async (method: string, path: string, o: { token?: string; body?: unknown } = {}) => {
    const r = await fetch(base + path, { method, headers: { ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'idempotency-key': crypto.randomUUID() } : {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
    const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, text };
  };
  try {
    await call('POST', '/api/setup', { body: { outlet: { name: 'Cafe', stateCode: '29' }, device: { name: 'Counter', seriesPrefix: 'A1' }, owner: { name: 'Owner', pin: '1234' } } });
    const owner = (await call('GET', '/api/login-users')).json[0];
    const token = (await call('POST', '/api/auth/login', { body: { userId: owner.id, pin: '1234' } })).json.token as string;
    const list = (await call('GET', '/api/addons', { token })).json;
    const ods = list.find((a: { id: string }) => a.id === 'ods'); // other add-ons may be built next to it
    assert.deepEqual([ods.id, ods.status, ods.reason], ['ods', 'active', null]);
    assert.match((await call('GET', '/api/addons/ods/ui.js')).text, /__POS__/);
    assert.equal((await call('GET', '/api/addons/ods/config', { token })).json.mode, 'offline');
    assert.equal((await call('GET', '/api/addons/ods/serviceability', { token })).json.zones.length, 2);
    assert.equal((await call('GET', '/api/addons/ods/tiles/12/2925/1880.png')).status, 409); // offline mode: no map download
    const tooOld = await startBackend({ dataDir: mkdtempSync(join(tmpdir(), 'pos-oo-')), port: 0, logger: silent, scheduleBackups: false, addonsDir: DIST, posVersion: '0.1.7' });
    try { assert.ok(tooOld.port > 0); } finally { await tooOld.shutdown('test'); } // an older POS starts fine without it
  } finally { await b.shutdown('test'); rmSync(data, { recursive: true, force: true }); }
});
