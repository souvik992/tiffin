import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startManager } from '../src/manager/server.ts';
import type { Manager } from '../src/manager/server.ts';
import { VIEW_ONLY, schemaOf } from '../src/manager/source.ts';
import { MIGRATIONS, SCHEMA_VERSION } from '../src/store/schema.ts';
import { sha256, run } from '../src/store/db.ts';
import { silentLogger } from '../src/services/ctx.ts';
import { makeEnv, quickBill, rid, startShift } from './helpers.ts';

interface T { m: Manager; dir: string; home: string; pos: { running: boolean }; call(method: string, path: string, o?: { body?: unknown; token?: string; secret?: string | null }): Promise<{ status: number; json: any; text: string }>; owner(): Promise<string>; done(): Promise<void> }

const SECRET = 'test-secret-123';

/** A shop with bills, menu photos and a secret setting, then Tiffin Data Manager over its data folder. */
async function shop(o: { dir?: string } = {}): Promise<T> {
  let dir = o.dir;
  if (!dir) {
    const env = makeEnv({ seed: true });
    startShift(env);
    quickBill(env, [['Cheese Burger', 2000]]);
    run(env.ctx.db, "INSERT INTO settings(key, value, updated_at) VALUES ('hub_device_key', 'very-secret', 1)");
    env.ctx.db.close();
    dir = env.dir;
  }
  mkdirSync(join(dir, 'images'), { recursive: true });
  writeFileSync(join(dir, 'images', 'keep-me.txt'), 'a photo');
  const home = mkdtempSync(join(tmpdir(), 'mgr-home-'));
  const pos = { running: false };
  const m = await startManager({ home, dataDir: dir, secret: SECRET, logger: silentLogger, isPosRunning: async () => pos.running });
  const call: T['call'] = async (method, path, c = {}) => {
    const headers: Record<string, string> = {};
    if (c.secret !== null) headers['x-pos-secret'] = c.secret ?? SECRET;
    if (c.token) headers.authorization = `Bearer ${c.token}`;
    if (c.body !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET') headers['idempotency-key'] = rid('mgr');
    const r = await fetch(`http://127.0.0.1:${m.port}${path}`, { method, headers, body: c.body === undefined ? undefined : JSON.stringify(c.body) });
    const text = await r.text();
    let json: any = null; try { json = JSON.parse(text); } catch { /* csv */ }
    return { status: r.status, json, text };
  };
  const owner = async () => {
    const r = await call('POST', '/api/auth/login', { body: { mobile: '9000000001', pin: '1234' } });
    assert.equal(r.status, 200, r.text);
    return r.json.token as string;
  };
  return { m, dir, home, pos, call, owner, done: async () => { await m.close(); rmSync(home, { recursive: true, force: true }); if (!o.dir) rmSync(dir!, { recursive: true, force: true }); } };
}

const itemPrice = (dir: string, name: string) => {
  const db = new DatabaseSync(join(dir, 'pos.db'), { readOnly: true });
  try { return (db.prepare('SELECT price FROM item WHERE name = ?').get(name) as { price: number }).price; } finally { db.close(); }
};

test('Data Manager: only the owner signs in; menu changes go through the POS rules; bills and billing are never changed here', async () => {
  const t = await shop();
  try {
    assert.equal((await t.call('GET', '/mgr/status', { secret: null })).status, 403, 'only the desktop window (with the secret) gets in');
    const st = (await t.call('GET', '/mgr/status')).json;
    assert.equal(st.source.kind, 'live');
    assert.equal(st.source.editable, true);
    assert.equal(st.source.store, 'Demo Burger Hub');
    assert.equal(st.signedIn, false);

    assert.equal((await t.call('GET', '/api/catalog')).status, 401);
    assert.deepEqual((await t.call('GET', '/api/login-users')).json.map((u: any) => u.role), ['owner'], 'only owners are offered');
    const cashier = await t.call('POST', '/api/auth/login', { body: { mobile: '9000000003', pin: '1111' } });
    assert.equal(cashier.json.error.code, 'OWNER_ONLY');
    assert.equal((await t.call('POST', '/api/auth/login', { body: { mobile: '9000000001', pin: '9999' } })).json.error.code, 'BAD_PIN');
    const token = await t.owner();
    assert.equal((await t.call('GET', '/mgr/status', { token })).json.signedIn, true);

    const cat = (await t.call('GET', '/api/catalog', { token })).json;
    const burger = cat.items.find((i: any) => i.name === 'Cheese Burger');
    const r = await t.call('PATCH', `/api/items/${burger.id}`, { token, body: { price: burger.price + 1000 } });
    assert.equal(r.status, 200, r.text);

    // bills: view only; billing, cancelling and printing are POS work
    const bills = (await t.call('GET', '/api/invoices', { token })).json;
    assert.equal(bills.length, 1);
    assert.equal((await t.call('GET', `/api/invoices/${bills[0].id}`, { token })).status, 200);
    assert.equal((await t.call('POST', `/api/invoices/${bills[0].id}/cancel`, { token, body: { reason: 'test' } })).json.error.code, 'NOT_HERE');
    assert.equal((await t.call('POST', '/api/orders', { token, body: {} })).json.error.code, 'NOT_HERE');
    assert.equal((await t.call('POST', '/api/auth/lock', { token })).json.error.code, 'NOT_HERE');
    assert.equal((await t.call('GET', '/api/reports/view/sales-summary?from=2026-10-12&to=2026-10-12', { token })).json.totals.bills, 1);

    // all data: every table, secrets hidden
    const tables = (await t.call('GET', '/mgr/tables', { token })).json;
    assert.ok(tables.find((x: any) => x.name === 'invoice' && x.rows === 1));
    const users = (await t.call('GET', '/mgr/tables/app_user', { token })).json;
    const hashCol = users.columns.indexOf('pin_hash');
    assert.ok(hashCol >= 0 && users.rows.every((row: any[]) => row[hashCol] === '(hidden)'));
    const settings = (await t.call('GET', '/mgr/tables/settings?q=hub_device', { token })).json;
    assert.equal(settings.total, 1);
    assert.equal(settings.rows[0][settings.columns.indexOf('value')], '(hidden)');
    assert.ok(!(await t.call('GET', '/mgr/tables/settings/csv', { token })).text.includes('very-secret'));
    assert.equal((await t.call('GET', '/mgr/tables/no_such_table', { token })).status, 404);
    assert.equal((await t.call('GET', '/mgr/tables/app_session', { token })).status, 200);

    await t.call('POST', '/api/auth/logout', { token });
    assert.equal((await t.call('GET', '/api/catalog', { token })).status, 401);
  } finally { await t.done(); }
});

test('Data Manager: while the POS is open it shows a copy (view only), and goes back to the data when the POS closes', async () => {
  const t = await shop();
  try {
    const token = await t.owner();
    const before = itemPrice(t.dir, 'Cheese Burger');
    t.pos.running = true;
    await t.m.refresh();
    const st = (await t.call('GET', '/mgr/status', { token })).json;
    assert.equal(st.source.kind, 'snapshot');
    assert.equal(st.source.viewOnly, VIEW_ONLY.posOpen);
    assert.equal(st.signedIn, true, 'the owner stays signed in');
    const cat = (await t.call('GET', '/api/catalog', { token })).json;
    const burger = cat.items.find((i: any) => i.name === 'Cheese Burger');
    const r = await t.call('PATCH', `/api/items/${burger.id}`, { token, body: { price: 1 } });
    assert.equal(r.json.error.code, 'VIEW_ONLY');
    assert.equal((await t.call('POST', '/mgr/restore', { token, body: { path: join(t.dir, 'pos.db'), pin: '1234' } })).json.error.code, 'VIEW_ONLY');
    assert.equal(itemPrice(t.dir, 'Cheese Burger'), before);

    // the POS starting while the screen is live: the next change is refused and the data reopened as a copy
    t.pos.running = false;
    await t.m.refresh();
    assert.equal(t.m.source?.kind, 'live');
    t.pos.running = true;
    assert.equal((await t.call('PATCH', `/api/items/${burger.id}`, { token, body: { price: 1 } })).json.error.code, 'VIEW_ONLY');
    assert.equal(itemPrice(t.dir, 'Cheese Burger'), before);
  } finally { await t.done(); }
});

test('Data Manager: data from an older POS is shown from an upgraded copy and never upgraded in place', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-old-'));
  const db = new DatabaseSync(join(dir, 'pos.db'));
  db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)');
  for (const m of MIGRATIONS.slice(0, -1)) {
    if (m.foreignKeysOff) db.exec('PRAGMA foreign_keys = OFF');
    db.exec(m.sql);
    db.prepare('INSERT INTO schema_migrations VALUES (?,?,?,?)').run(m.version, m.name, sha256(m.sql), 1);
  }
  db.close();
  const old = schemaOf(join(dir, 'pos.db'));
  assert.ok(old < SCHEMA_VERSION);
  const t = await shop({ dir });
  try {
    const st = (await t.call('GET', '/mgr/status')).json;
    assert.equal(st.source.kind, 'snapshot');
    assert.equal(st.source.viewOnly, VIEW_ONLY.older);
    assert.equal(st.source.schema, old);
  } finally { await t.done(); }
  assert.equal(schemaOf(join(dir, 'pos.db')), old, 'the shop\'s own database is untouched');
  assert.deepEqual(readdirSync(dir).sort(), ['images', 'pos.db'], 'no -wal/-shm left behind');
  rmSync(dir, { recursive: true, force: true });
});

test('Data Manager: backup (with a copy to a drive), open a backup file to look, restore it with the owner PIN', async () => {
  const t = await shop();
  const drive = mkdtempSync(join(tmpdir(), 'mgr-usb-'));
  try {
    const token = await t.owner();
    const price = itemPrice(t.dir, 'Cheese Burger');
    const b = await t.call('POST', '/mgr/backup', { token, body: { copyTo: drive } });
    assert.equal(b.status, 200, b.text);
    assert.ok(existsSync(b.json.file) && existsSync(b.json.copy));
    assert.ok(b.json.copy.startsWith(join(drive, 'TiffinPOS-backups')));
    assert.equal((await t.call('POST', '/mgr/backup', { token, body: { copyTo: join(drive, 'missing') } })).json.error.code, 'COPY_FOLDER_MISSING');
    const list = (await t.call('GET', '/mgr/backups', { token })).json;
    assert.equal(list.files.length, 1);
    assert.equal(list.canRestore, true);

    const cat = (await t.call('GET', '/api/catalog', { token })).json;
    const burger = cat.items.find((i: any) => i.name === 'Cheese Burger');
    assert.equal((await t.call('PATCH', `/api/items/${burger.id}`, { token, body: { price: price + 500 } })).status, 200);

    // look inside the backup on the drive: view only, same owner still signed in
    const opened = (await t.call('POST', '/mgr/open', { token, body: { origin: 'file', path: b.json.copy } })).json;
    assert.equal(opened.source.viewOnly, VIEW_ONLY.file);
    assert.equal(opened.signedIn, true);
    const inBackup = (await t.call('GET', '/api/catalog', { token })).json.items.find((i: any) => i.name === 'Cheese Burger');
    assert.equal(inBackup.price, price);
    assert.equal((await t.call('POST', '/mgr/backup', { token, body: {} })).json.error.code, 'NOT_HERE');
    assert.equal((await t.call('POST', '/mgr/open', { token, body: { origin: 'data' } })).json.source.kind, 'live');

    assert.equal((await t.call('POST', '/mgr/restore', { token, body: { path: b.json.copy, pin: '0000' } })).json.error.code, 'BAD_PIN');
    const r = await t.call('POST', '/mgr/restore', { token, body: { path: b.json.copy, pin: '1234' } });
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.aside, 'the database before the restore is kept aside');
    assert.equal((await t.call('GET', '/mgr/status', { token })).json.signedIn, true);
    assert.equal((await t.call('GET', '/api/catalog', { token })).json.items.find((i: any) => i.name === 'Cheese Burger').price, price);
  } finally { await t.done(); rmSync(drive, { recursive: true, force: true }); }
});

test('Data Manager: closing a copy removes it but never the shop\'s photos it links to', async () => {
  const t = await shop();
  try {
    t.pos.running = true;
    await t.m.refresh();
    assert.equal(t.m.source?.kind, 'snapshot');
    const work = t.m.source!.work!;
    assert.ok(existsSync(join(work, 'images', 'keep-me.txt')), 'photos are reachable from the copy');
    t.pos.running = false;
    await t.m.refresh();
    assert.ok(!existsSync(work), 'the copy is gone');
    assert.ok(existsSync(join(t.dir, 'images', 'keep-me.txt')), 'the photo is still in the shop\'s data');
  } finally { await t.done(); }
});

test('Data Manager: no data on this computer is a plain message, not a crash', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'mgr-empty-'));
  const home = mkdtempSync(join(tmpdir(), 'mgr-home-'));
  const m = await startManager({ home, dataDir: empty, logger: silentLogger });
  try {
    const st = await (await fetch(`http://127.0.0.1:${m.port}/mgr/status`)).json() as any;
    assert.equal(st.source, null);
    assert.equal(st.error.code, 'NO_DATA');
    const login = await fetch(`http://127.0.0.1:${m.port}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"mobile":"9000000001","pin":"1234"}' });
    assert.equal(login.status, 409);
  } finally { await m.close(); rmSync(empty, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});
