import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBackend } from '../src/app.ts';
import { compareVersions, canonical, sha256hex, signManifest } from '../src/addons/manifest.ts';
import type { Backend } from '../src/app.ts';

const silent = { info() {}, warn() {}, error() {} };
const keyPair = () => { const k = generateKeyPairSync('ed25519'); return { priv: k.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, pub: k.publicKey.export({ type: 'spki', format: 'pem' }) as string }; };
const TRUSTED = keyPair(), STRANGER = keyPair();

const BACKEND = `
exports.register = (host) => {
  host.migrations([
    { version: 1, name: 'notes', sql: 'CREATE TABLE fx_note (id INTEGER PRIMARY KEY, text TEXT NOT NULL)' },
    { version: 2, name: 'notes_by', sql: 'ALTER TABLE fx_note ADD COLUMN by_user TEXT' },
  ]);
  host.route('GET', '/notes', {}, () => host.db.all('SELECT text, by_user AS by FROM fx_note ORDER BY id'));
  host.route('POST', '/notes', {}, (c) => host.runCommand(host.ctx, c.requestId, 'fx.note', c.actor, () => {
    host.assertPerm(c.actor, 'settings.write');
    host.db.run('INSERT INTO fx_note (text, by_user) VALUES (?, ?)', String(c.body.text), c.actor.name);
    return { ok: true };
  }));
  host.route('GET', '/crash', {}, () => { throw new host.AppError('FX_DOWN', 'Fixture says no.', 418); });
  host.route('GET', '/public', { auth: false }, () => ({ hello: require('node:path').basename('/a/b') }));
};`;
const UI = 'window.__fixtureLoaded = true;';

function writeAddon(dir: string, o: { id?: string; version?: string; minPosVersion?: string; backend?: string; ui?: string | null; key?: string; tamper?: boolean }) {
  const id = o.id ?? 'fixture';
  const root = join(dir, id);
  mkdirSync(root, { recursive: true });
  const files: Record<string, string> = {};
  const backend = o.backend ?? BACKEND;
  writeFileSync(join(root, 'backend.cjs'), backend); files['backend.cjs'] = sha256hex(backend);
  if (o.ui !== null) { const ui = o.ui ?? UI; writeFileSync(join(root, 'ui.js'), ui); files['ui.js'] = sha256hex(ui); }
  const m = signManifest({ id, name: 'Fixture', version: o.version ?? '1.0.0', minPosVersion: o.minPosVersion ?? '0.2.0', backend: 'backend.cjs', ...(o.ui !== null ? { ui: 'ui.js' } : {}), files }, o.key ?? TRUSTED.priv);
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(m, null, 2));
  if (o.tamper) writeFileSync(join(root, 'backend.cjs'), backend + '\n// changed');
}

async function boot(addonsDir: string, dataDir: string, posVersion = '0.2.0'): Promise<Backend & { base: string; call: (m: string, p: string, o?: { token?: string; body?: unknown }) => Promise<{ status: number; json: any; text: string }>; token: () => Promise<string> }> {
  const b = await startBackend({ dataDir, port: 0, logger: silent, scheduleBackups: false, addonsDir, posVersion, trustedAddonKeys: [TRUSTED.pub] });
  const base = `http://127.0.0.1:${b.port}`;
  const call = async (method: string, path: string, o: { token?: string; body?: unknown } = {}) => {
    const r = await fetch(base + path, { method, headers: { ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'idempotency-key': crypto.randomUUID() } : {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
    const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* text */ }
    return { status: r.status, json, text };
  };
  const token = async () => {
    const setup = await call('POST', '/api/setup', { body: { outlet: { name: 'Fixture Cafe', stateCode: '29' }, device: { name: 'Counter', seriesPrefix: 'A1' }, owner: { name: 'Owner', pin: '1234' } } });
    assert.ok(setup.status === 200 || setup.json?.error?.code === 'ALREADY_SETUP', JSON.stringify(setup.json));
    const owner = (await call('GET', '/api/login-users')).json.find((u: { name: string }) => u.name === 'Owner');
    return (await call('POST', '/api/auth/login', { body: { userId: owner.id, pin: '1234' } })).json.token as string;
  };
  return { ...b, base, call, token };
}

test('add-ons: a signed add-on loads; its routes, database steps (once, in order) and screens work; restart keeps its data', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pos-addons-'));
  const addons = join(dir, 'addons'), data = join(dir, 'data');
  writeAddon(addons, {});
  let b = await boot(addons, data);
  try {
    const t = await b.token();
    const list = (await b.call('GET', '/api/addons', { token: t })).json;
    assert.deepEqual(list, [{ id: 'fixture', name: 'Fixture', version: '1.0.0', status: 'active', reason: null, hasUi: true, ui: '/api/addons/fixture/ui.js?v=1.0.0' }]);
    assert.equal((await b.call('GET', '/api/addons/fixture/ui.js')).text, UI); // no sign-in needed for the screens' code
    assert.equal((await b.call('POST', '/api/addons/fixture/notes', { token: t, body: { text: 'hello' } })).status, 200);
    assert.deepEqual((await b.call('GET', '/api/addons/fixture/notes', { token: t })).json, [{ text: 'hello', by: 'Owner' }]);
    assert.equal((await b.call('GET', '/api/addons/fixture/notes')).status, 401); // add-on routes need sign-in unless they say otherwise
    assert.deepEqual((await b.call('GET', '/api/addons/fixture/public')).json, { hello: 'b' });
    const crash = await b.call('GET', '/api/addons/fixture/crash', { token: t });
    assert.deepEqual([crash.status, crash.json.error.code], [418, 'FX_DOWN']);
  } finally { await b.shutdown('test'); }
  b = await boot(addons, data); // steps are not re-run; data stays
  try {
    const t = await b.token();
    assert.deepEqual((await b.call('GET', '/api/addons/fixture/notes', { token: t })).json, [{ text: 'hello', by: 'Owner' }]);
  } finally { await b.shutdown('test'); rmSync(dir, { recursive: true, force: true }); }
});

test('add-ons: changed files, unknown publishers, a too-old POS, crashing code and bad packages are switched off with a reason; the POS keeps working', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pos-addons-'));
  const addons = join(dir, 'addons');
  writeAddon(addons, { id: 'changed', tamper: true });
  writeAddon(addons, { id: 'stranger', key: STRANGER.priv });
  writeAddon(addons, { id: 'too-new', minPosVersion: '9.0.0' });
  writeAddon(addons, { id: 'crashes', backend: "exports.register = () => { throw new Error('boom'); };" });
  writeAddon(addons, { id: 'bad-step', backend: "exports.register = (h) => { h.migrations([{ version: 1, name: 'x', sql: 'CREATE TABLE broken (' }]); h.route('GET', '/x', {}, () => 1); };" });
  writeAddon(addons, { id: 'escapes', backend: "require('leaflet'); exports.register = () => {};" });
  writeAddon(addons, { id: 'fine', ui: null });
  mkdirSync(join(addons, 'empty-folder'));
  const b = await boot(addons, join(dir, 'data'));
  try {
    const t = await b.token();
    const list = (await b.call('GET', '/api/addons', { token: t })).json as Array<{ id: string; status: string; reason: string | null }>;
    const reason = (id: string) => list.find((a) => a.id === id)!;
    assert.match(reason('changed').reason!, /changed after it was signed/);
    assert.match(reason('stranger').reason!, /Not signed by a trusted publisher/);
    assert.match(reason('too-new').reason!, /Needs Tiffin POS 9\.0\.0 or newer/);
    assert.match(reason('crashes').reason!, /could not start: boom/);
    assert.match(reason('bad-step').reason!, /could not start/);
    assert.match(reason('escapes').reason!, /only require Node built-in modules/);
    assert.match(reason('empty-folder').reason!, /manifest.json is missing/);
    assert.equal(reason('fine').status, 'active');
    for (const a of list) if (a.id !== 'fine') assert.equal(a.status, 'off', a.id);
    assert.equal((await b.call('GET', '/api/addons/bad-step/x', { token: t })).status, 404); // routes of a switched-off add-on do not exist
    assert.equal((await b.call('GET', '/api/addons/changed/ui.js')).status, 404);
    assert.equal((await b.call('GET', '/api/ping')).status, 200);
  } finally { await b.shutdown('test'); rmSync(dir, { recursive: true, force: true }); }
});

test('add-ons: a changed database step is refused on the next start; no folder means no add-ons; versions and signing bytes are stable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pos-addons-'));
  const addons = join(dir, 'addons'), data = join(dir, 'data');
  writeAddon(addons, {});
  await (await boot(addons, data)).shutdown('test');
  rmSync(join(addons, 'fixture'), { recursive: true });
  writeAddon(addons, { backend: BACKEND.replace('by_user TEXT', 'by_user INTEGER') });
  const b = await boot(addons, data);
  try {
    const t = await b.token();
    assert.match((await b.call('GET', '/api/addons', { token: t })).json[0].reason, /database step 2 \(notes_by\) was changed/);
  } finally { await b.shutdown('test'); }
  const none = await boot(join(dir, 'nothing-here'), join(dir, 'data2'));
  try { assert.deepEqual((await none.call('GET', '/api/addons', { token: await none.token() })).json, []); } finally { await none.shutdown('test'); rmSync(dir, { recursive: true, force: true }); }
  assert.equal(compareVersions('0.2.0', '0.2.0'), 0);
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('0.2.0-dev', '0.3.0'), -1);
  assert.equal(canonical({ b: 1, a: [2, { d: 3, c: undefined }] }), '{"a":[2,{"d":3}],"b":1}');
});
