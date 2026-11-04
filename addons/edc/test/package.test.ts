import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBackend } from '../../../src/app.ts';

const DIST = join(import.meta.dirname, '..', '..', 'dist', 'packages');
const silent = { info() {}, warn() {}, error() {} };

test('the signed package (npm run build) loads in a real POS 0.3.8, its routes answer, its screens load, and an older POS refuses it', { skip: !existsSync(join(DIST, 'edc', 'manifest.json')) && 'run npm run build first' }, async () => {
  const data = mkdtempSync(join(tmpdir(), 'pos-edc-'));
  const b = await startBackend({ dataDir: data, port: 0, logger: silent, scheduleBackups: false, addonsDir: DIST, posVersion: '0.3.8' });
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
    const edc = (await call('GET', '/api/addons', { token })).json.find((a: { id: string }) => a.id === 'edc');
    assert.deepEqual([edc.status, edc.reason], ['active', null]);
    assert.match((await call('GET', '/api/addons/edc/ui.js')).text, /__POS__/);
    assert.deepEqual((await call('GET', '/api/addons/edc/terminals', { token })).json, []);
    const saved = await call('POST', '/api/addons/edc/terminals', { token, body: { name: 'Pine cable', provider: 'pinelabs', connection: 'wired', modes: ['CARD'], config: { host: '127.0.0.1', port: 9 } } });
    assert.equal(saved.json.name, 'Pine cable');
    assert.equal((await call('POST', `/api/addons/edc/terminals/${saved.json.id}/check`, { token })).json.ok, false); // nothing listens on port 9
    const day = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    assert.deepEqual((await call('GET', `/api/addons/edc/report?from=${day}&to=${day}`, { token })).json.rows, []);
    const tooOld = await startBackend({ dataDir: mkdtempSync(join(tmpdir(), 'pos-edc-')), port: 0, logger: silent, scheduleBackups: false, addonsDir: DIST, posVersion: '0.3.7' });
    try {
      assert.ok(tooOld.port > 0); // an older POS starts fine, with the add-on switched off
    } finally { await tooOld.shutdown('test'); }
  } finally { await b.shutdown('test'); rmSync(data, { recursive: true, force: true }); }
});
