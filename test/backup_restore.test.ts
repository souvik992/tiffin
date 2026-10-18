import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { get } from '../src/store/db.ts';
import { createCtx, silentLogger } from '../src/services/ctx.ts';
import { COPY_FOLDER, listBackups, runBackup } from '../src/services/backup.ts';
import { performRestore } from '../src/services/restore.ts';
import { serverUrl, uploadIfDue } from '../src/services/cloudBackup.ts';
import { setSetting, getSetting } from '../src/services/settings.ts';
import { setItemImage } from '../src/services/images.ts';
import { startBackend } from '../src/app.ts';
import { Hub } from '../hub/src/hub.ts';
import { createHubServer } from '../hub/src/http.ts';
import { makeEnv, quickBill, rid, startShift } from './helpers.ts';

const png = (fill: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(400, fill)]);
const count = (ctx: { db: Parameters<typeof get>[0] }, sql: string) => get<{ n: number }>(ctx.db, sql)!.n;

test('offline copy: every backup is also copied (checked) to the chosen folder with its photos; a missing USB drive is reported, never fatal', async () => {
  const env = makeEnv();
  const usb = mkdtempSync(join(tmpdir(), 'pos-usb-'));
  try {
    const photo = setItemImage(env.ctx, env.manager, rid(), env.items['Brownie']!, png(3).toString('base64')).imageFile;
    setSetting(env.ctx, 'backup_copy_dir', usb);
    const b = await runBackup(env.ctx, 'hourly');
    const copies = listBackups(join(usb, COPY_FOLDER));
    assert.deepEqual(copies.map((f) => f.file), [b.file.split(/[\\/]/).pop()]);
    assert.ok(existsSync(join(usb, COPY_FOLDER, 'images', photo)));
    assert.equal(getSetting(env.ctx, 'backup_copy_error'), '');
    assert.ok(Number(getSetting(env.ctx, 'backup_copy_last_at')) > 0);

    rmSync(usb, { recursive: true, force: true }); // the USB drive was pulled out
    const again = await runBackup(env.ctx, 'hourly');
    assert.equal(again.verified, true, 'the backup on this device still succeeds');
    assert.match(getSetting(env.ctx, 'backup_copy_error'), /not available/);
  } finally { env.cleanup(); rmSync(usb, { recursive: true, force: true }); }
});

test('restore (same shop): the current database is kept aside, the backup comes back, later bills are replayed from the journal', async () => {
  const env = makeEnv();
  try {
    startShift(env);
    quickBill(env, [['Masala Chai']]); quickBill(env, [['Brownie']]);
    const b = await runBackup(env.ctx, 'manual');
    quickBill(env, [['Cold Coffee']]); // after the backup: only in the journal
    setSetting(env.ctx, 'receipt_footer', 'changed after the backup'); // not journaled: goes back to the backup's value
    env.ctx.db.close();
    const r = performRestore(env.dir, b.file);
    assert.equal(r.journal.replayed > 0, true);
    assert.equal(r.journal.keptAside, false);
    assert.ok(r.aside && existsSync(join(r.aside, 'pos.db')), 'the previous database is kept');
    const ctx = createCtx({ dataDir: env.dir, logger: silentLogger, scryptCost: 1024 });
    try {
      assert.equal(count(ctx, "SELECT count(*) n FROM invoice"), 3, 'no bill lost');
      assert.equal(getSetting(ctx, 'receipt_footer'), 'Thank you! Visit again.');
    } finally { ctx.db.close(); }
  } finally { env.cleanup(); }
});

test('restore (another shop\'s backup, e.g. onto a new PC that was set up first): its journal is kept aside, not replayed', async () => {
  const oldPc = makeEnv(), newPc = makeEnv();
  try {
    startShift(oldPc); quickBill(oldPc, [['Masala Chai']]); quickBill(oldPc, [['Masala Chai']]);
    const b = await runBackup(oldPc.ctx, 'manual');
    startShift(newPc); quickBill(newPc, [['Brownie']]); // a test bill on the new PC
    newPc.ctx.db.close();
    const r = performRestore(newPc.dir, b.file);
    assert.equal(r.journal.keptAside, true);
    assert.equal(r.journal.replayed, 0);
    assert.ok(existsSync(join(r.aside!, 'journal')));
    const ctx = createCtx({ dataDir: newPc.dir, logger: silentLogger, scryptCost: 1024 });
    try { assert.equal(count(ctx, 'SELECT count(*) n FROM invoice'), 2, 'exactly the old PC\'s bills'); } finally { ctx.db.close(); }
  } finally { oldPc.cleanup(); newPc.cleanup(); }
});

test('restore: a damaged backup changes nothing', async () => {
  const env = makeEnv();
  try {
    startShift(env); quickBill(env, [['Masala Chai']]);
    env.ctx.db.close();
    const junk = join(env.dir, 'backups', 'manual-20261012T043000000Z.db');
    execFileSync(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(junk)}, 'x'.repeat(5000))`]);
    assert.throws(() => performRestore(env.dir, junk), /not usable/);
    assert.ok(existsSync(join(env.dir, 'pos.db')));
    assert.ok(!readdirSync(env.dir).some((f) => f.startsWith('pre-restore-')));
  } finally { env.cleanup(); }
});

// ---------------------------------------------------------------- through the API, with the in-place restart

async function pos(dir: string) {
  execFileSync(process.execPath, [join(import.meta.dirname, '..', 'src', 'seed.ts')], { env: { ...process.env, POS_DATA_DIR: dir }, stdio: 'ignore' });
  const b = await startBackend({ dataDir: dir, port: 0, logger: silentLogger, scheduleBackups: false });
  const base = `http://127.0.0.1:${b.port}`;
  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const r = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'idempotency-key': crypto.randomUUID() } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null) as any };
  };
  const login = async (mobile: string, pin: string) => (await call('POST', '/api/auth/login', { mobile, pin })).json.token as string;
  /** Waits until the POS has restarted itself: the old sign-in no longer works (sessions start fresh) and it answers again. */
  const back = async (oldToken: string) => {
    for (let i = 0; i < 300; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try { if ((await fetch(base + '/api/me', { headers: { authorization: `Bearer ${oldToken}` } })).status === 401) return; } catch { /* restarting */ }
    }
    throw new Error('the POS did not restart');
  };
  return { b, base, call, login, back };
}

test('Settings > Backups: only the owner, with the PIN again; the POS restarts itself on the same port with the backup restored', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pos-restore-api-'));
  const p = await pos(dir);
  try {
    const owner = await p.login('9000000001', '1234'), cashier = await p.login('9000000003', '1111');
    assert.equal((await p.call('GET', '/api/backup/overview', undefined, cashier)).status, 403);
    const made = await p.call('POST', '/api/backup', {}, owner);
    const name = made.json.file.split(/[\\/]/).pop();
    await p.call('PUT', '/api/settings', { receipt_footer: 'after the backup' }, owner);

    assert.equal((await p.call('POST', '/api/restore', { source: 'device', name, pin: '9999' }, owner)).status, 401);
    assert.equal((await p.call('POST', '/api/restore', { source: 'device', name, pin: '1111' }, cashier)).status, 403);
    assert.equal((await p.call('POST', '/api/restore', { source: 'device', name: '../pos.db', pin: '1234' }, owner)).status, 400);
    const ov = (await p.call('GET', '/api/backup/overview', undefined, owner)).json;
    assert.equal(ov.canRestartItself, true);
    assert.equal(ov.files[0].file, name);

    const r = await p.call('POST', '/api/restore', { source: 'device', name, pin: '1234' }, owner);
    assert.deepEqual(r.json, { restarting: true });
    await p.back(owner);
    const owner2 = await p.login('9000000001', '1234'); // sessions start fresh after the restart
    assert.equal((await p.call('GET', '/api/settings', undefined, owner2)).json.receipt_footer, 'Thank you! Visit again.');
    const after = (await p.call('GET', '/api/backup/overview', undefined, owner2)).json;
    assert.equal(after.lastRestore.ok, true);
    assert.equal(after.lastRestore.label, `device ${name}`);
    await p.call('POST', '/api/restore/dismiss', {}, owner2);
    assert.equal((await p.call('GET', '/api/backup/overview', undefined, owner2)).json.lastRestore, null);
    assert.ok(readdirSync(dir).some((f) => f.startsWith('pre-restore-')));
  } finally { await p.b.shutdown('test'); rmSync(dir, { recursive: true, force: true }); }
});

test('online backup: pair with the Tiffin backup server, upload (photos too), then restore from it on a POS that lost its photos', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pos-cloud-'));
  const hub = new Hub({ dbPath: join(dir, 'hub.db') });
  const hs: Server = createHubServer(hub, { adminKey: 'k' });
  await new Promise<void>((r) => hs.listen(0, '127.0.0.1', () => r()));
  const HUB = `http://127.0.0.1:${(hs.address() as { port: number }).port}`;
  const p = await pos(join(dir, 'pos'));
  try {
    assert.throws(() => serverUrl('http://backup.example.in'), /https/);
    assert.equal(serverUrl('https://backup.example.in/'), 'https://backup.example.in');
    const owner = await p.login('9000000001', '1234');
    const items = (await p.call('GET', '/api/catalog', undefined, owner)).json.items as Array<{ id: string; name: string }>;
    const photo = (await p.call('PUT', `/api/items/${items[0]!.id}/image`, { dataBase64: png(9).toString('base64') }, owner)).json.imageFile as string;

    assert.equal((await p.call('POST', '/api/backup/cloud/pair', { url: HUB, code: 'WRONG-CODE' }, owner)).status, 502);
    const code = hub.createStore('chai-point', 'Chai Point').pairingCode;
    const paired = (await p.call('POST', '/api/backup/cloud/pair', { url: HUB, code }, owner)).json;
    assert.equal(paired.cloud.connected, true);
    assert.equal(paired.cloud.on, true);
    assert.equal(paired.cloud.store, 'chai-point'.replace('chai-point', 'Chai Point'));
    assert.ok(!JSON.stringify(paired).includes('tpk_'), 'the device key never reaches the screen');
    assert.ok(!JSON.stringify((await p.call('GET', '/api/settings', undefined, owner)).json).includes('tpk_'));

    const up = (await p.call('POST', '/api/backup/cloud/now', {}, owner)).json;
    assert.ok(up.cloud.lastAt > 0 && up.cloud.error === null);
    const online = (await p.call('GET', '/api/backup/cloud/list', undefined, owner)).json.backups as Array<{ name: string }>;
    assert.equal(online.length, 1);
    assert.equal(online[0]!.name, `${up.cloud.lastFile}`);

    // the shop loses its photos and changes something; then restores the online backup
    await p.call('PUT', '/api/settings', { receipt_footer: 'after the upload' }, owner);
    for (const d of [join(dir, 'pos', 'images'), join(dir, 'pos', 'backups', 'images')]) for (const f of readdirSync(d)) unlinkSync(join(d, f));
    const r = await p.call('POST', '/api/restore', { source: 'online', name: online[0]!.name, pin: '1234' }, owner);
    assert.deepEqual(r.json, { restarting: true });
    await p.back(owner);
    const owner2 = await p.login('9000000001', '1234');
    assert.equal((await p.call('GET', '/api/settings', undefined, owner2)).json.receipt_footer, 'Thank you! Visit again.');
    assert.ok(existsSync(join(dir, 'pos', 'images', photo)), 'the photo came back from the server');
    assert.equal((await p.call('GET', '/api/backup/overview', undefined, owner2)).json.lastRestore.ok, true);

    const off = (await p.call('DELETE', '/api/backup/cloud', undefined, owner2)).json;
    assert.equal(off.cloud.connected, false);
  } finally {
    await p.b.shutdown('test');
    await new Promise<void>((r) => { hs.close(() => r()); hs.closeAllConnections(); });
    hub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('online backup schedule: uploads the newest backup only when on, new, and older than the chosen interval', async () => {
  const env = makeEnv();
  const hubDir = mkdtempSync(join(tmpdir(), 'hub-sched-'));
  const hub = new Hub({ dbPath: join(hubDir, 'hub.db') });
  const hs: Server = createHubServer(hub, {});
  await new Promise<void>((r) => hs.listen(0, '127.0.0.1', () => r()));
  try {
    const key = hub.pair(hub.createStore('chai-point', 'Chai Point').pairingCode, 'POS').deviceKey;
    setSetting(env.ctx, 'cloud_backup_url', `http://127.0.0.1:${(hs.address() as { port: number }).port}`);
    setSetting(env.ctx, 'cloud_backup_key', key);
    await runBackup(env.ctx, 'hourly');
    assert.equal(await uploadIfDue(env.ctx), false, 'off until switched on');
    setSetting(env.ctx, 'cloud_backup_on', '1');
    assert.equal(await uploadIfDue(env.ctx), true);
    assert.equal(await uploadIfDue(env.ctx), false, 'nothing new');
    env.clock.advance(60 * 60_000);
    await runBackup(env.ctx, 'hourly');
    assert.equal(await uploadIfDue(env.ctx), false, 'within the 3-hour default');
    env.clock.advance(2 * 60 * 60_000);
    assert.equal(await uploadIfDue(env.ctx), true);
    assert.equal(hub.backups.list({ deviceId: '', storeId: hub.device(key).storeId, slug: '' }).length, 2);
  } finally {
    env.cleanup();
    await new Promise<void>((r) => { hs.close(() => r()); hs.closeAllConnections(); });
    hub.close(); rmSync(hubDir, { recursive: true, force: true });
  }
});
