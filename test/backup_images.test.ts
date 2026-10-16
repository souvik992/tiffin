import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { all, get, openDb } from '../src/store/db.ts';
import { createCtx, silentLogger } from '../src/services/ctx.ts';
import { pruneBackups, restoreBackup, runBackup } from '../src/services/backup.ts';
import { setItemImage } from '../src/services/images.ts';
import { makeEnv, quickBill, rid, startShift } from './helpers.ts';

const png = (fill: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(400, fill)]);
const photo = (env: ReturnType<typeof makeEnv>, item: string, fill: number) => setItemImage(env.ctx, env.manager, rid(), env.items[item]!, png(fill).toString('base64')).imageFile;

test('backup: copies the photos the menu uses, only new ones each time, verified by fingerprint', async () => {
  const env = makeEnv(); try {
    const a = photo(env, 'Brownie', 1), b = photo(env, 'Cheese Burger', 2);
    const first = await runBackup(env.ctx, 'manual');
    assert.deepEqual(first.images, { referenced: 2, copied: 2, missing: [] });
    const store = join(env.ctx.backupDir, 'images');
    assert.deepEqual(readdirSync(store).sort(), [a, b].sort());
    assert.deepEqual(readFileSync(join(store, a)), png(1));

    const c = photo(env, 'Cola 300ml', 3);
    const second = await runBackup(env.ctx, 'hourly');
    assert.deepEqual(second.images, { referenced: 3, copied: 1, missing: [] }); // incremental: photos never change

    // a photo lost from the live folder is reported, but the bills are still backed up
    unlinkSync(join(env.ctx.dataDir, 'images', c));
    unlinkSync(join(store, c));
    const third = await runBackup(env.ctx, 'hourly');
    assert.equal(third.verified, true);
    assert.deepEqual(third.images.missing, [c]);

    // backups to another folder (a USB drive) carry their own photos
    const usb = mkdtempSync(join(tmpdir(), 'pos-usb-'));
    try {
      const ext = await runBackup(env.ctx, 'manual', usb);
      assert.equal(ext.images.copied, 2);
      assert.ok(existsSync(join(usb, 'images', a)));
    } finally { rmSync(usb, { recursive: true, force: true }); }
  } finally { env.cleanup(); }
});

test('backup: photos no remaining backup uses are pruned with old backups; nothing is pruned if a backup cannot be read', async () => {
  const env = makeEnv(); try {
    const old = photo(env, 'Brownie', 4);
    await runBackup(env.ctx, 'manual');
    photo(env, 'Brownie', 5); // replaces the photo; the old one is now only in the first backup
    const kept = get<{ f: string }>(env.ctx.db, 'SELECT image_file f FROM item WHERE id = ?', env.items['Brownie']!)!.f;
    for (let i = 0; i < 21; i++) { env.clock.advance(1000); await runBackup(env.ctx, 'manual'); } // manual keeps 20
    const store = join(env.ctx.backupDir, 'images');
    assert.ok(!existsSync(join(store, old)), 'the old photo left with the last backup that used it');
    assert.ok(existsSync(join(store, kept)));

    // an unreadable backup file: keep every photo (better a few extra files than a backup missing its photos)
    writeFileSync(join(store, `${'d'.repeat(64)}.png`), png(9));
    writeFileSync(join(env.ctx.backupDir, 'manual-99999999T999999999Z.db'), 'not a database');
    pruneBackups(env.ctx.backupDir);
    assert.ok(existsSync(join(store, `${'d'.repeat(64)}.png`)));
  } finally { env.cleanup(); }
});

test('restore: photos come back with the backup; a missing photo is reported but never blocks the bills', async () => {
  const env = makeEnv(); try {
    const a = photo(env, 'Brownie', 6), b = photo(env, 'Cheese Burger', 7);
    const bk = await runBackup(env.ctx, 'manual');
    const fresh = mkdtempSync(join(tmpdir(), 'pos-restore-img-'));
    try {
      const r = restoreBackup(bk.file, join(fresh, 'pos.db'));
      assert.deepEqual(r.images, { referenced: 2, restored: 2, alreadyPresent: 0, missing: [] });
      assert.deepEqual(readFileSync(join(fresh, 'images', a)), png(6));
      assert.deepEqual(readFileSync(join(fresh, 'images', b)), png(7));

      // a damaged copy in the target is replaced; a photo missing from the backup store is reported
      writeFileSync(join(fresh, 'images', a), 'damaged');
      unlinkSync(join(env.ctx.backupDir, 'images', b));
      rmSync(join(fresh, 'images', b));
      const r2 = restoreBackup(bk.file, join(fresh, 'pos.db'), { force: true });
      assert.deepEqual(r2.images.missing, [b]);
      assert.deepEqual(readFileSync(join(fresh, 'images', a)), png(6));
      const db = openDb(join(fresh, 'pos.db'), { readOnly: true });
      try { assert.equal(all(db, 'SELECT id FROM item').length > 0, true); } finally { db.close(); }
    } finally { rmSync(fresh, { recursive: true, force: true }); }
  } finally { env.cleanup(); }
});

const script = join(import.meta.dirname, '..', 'scripts', 'restore.ts');
const runRestore = (dataDir: string, args: string[], port: number) =>
  spawnSync(process.execPath, [script, ...args], { env: { ...process.env, POS_DATA_DIR: dataDir, POS_PORT: String(port) }, encoding: 'utf8' });
const freePort = () => new Promise<number>((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => r(p)); }); });

test('npm run restore: lists backups, keeps the current database aside, restores photos and replays later bills', async () => {
  const env = makeEnv(); try {
    startShift(env);
    quickBill(env, [['Cheese Burger']]);
    const img = photo(env, 'Brownie', 8);
    const bk = await runBackup(env.ctx, 'manual');
    quickBill(env, [['Brownie']]); // after the backup: only in the journal
    const bills = all<{ invoice_no: string }>(env.ctx.db, 'SELECT invoice_no FROM invoice ORDER BY seq_no').map((r) => r.invoice_no);
    env.ctx.db.close();
    // disaster: the database and the photos are damaged
    writeFileSync(join(env.dir, 'pos.db'), 'garbage');
    rmSync(join(env.dir, 'images'), { recursive: true, force: true });
    const port = await freePort();

    const list = runRestore(env.dir, [], port);
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, new RegExp(bk.file.split(/[\\/]/).pop()!.replace('.', '\\.')));

    const r = runRestore(env.dir, [bk.file.split(/[\\/]/).pop()!], port);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Restored/);
    assert.ok(readdirSync(env.dir).some((f) => f.startsWith('pre-restore-')), 'the damaged database was kept aside');
    const kept = readdirSync(env.dir).find((f) => f.startsWith('pre-restore-'))!;
    assert.equal(readFileSync(join(env.dir, kept, 'pos.db'), 'utf8'), 'garbage');
    assert.deepEqual(readFileSync(join(env.dir, 'images', img)), png(8));
    const ctx = createCtx({ dataDir: env.dir, logger: silentLogger, scryptCost: 1024, clock: env.clock });
    try {
      assert.deepEqual(all<{ invoice_no: string }>(ctx.db, 'SELECT invoice_no FROM invoice ORDER BY seq_no').map((x) => x.invoice_no), bills);
    } finally { ctx.db.close(); }
  } finally { env.cleanup(); }
});

test('npm run restore: refuses while the POS is running, and refuses a damaged backup without touching anything', async () => {
  const env = makeEnv(); try {
    const bk = await runBackup(env.ctx, 'manual');
    env.ctx.db.close();
    const busy = net.createServer();
    const port = await new Promise<number>((r) => busy.listen(0, '127.0.0.1', () => r((busy.address() as net.AddressInfo).port)));
    try {
      const r = runRestore(env.dir, [bk.file.split(/[\\/]/).pop()!], port);
      assert.equal(r.status, 1);
      assert.match(r.stdout + r.stderr, /still running/);
    } finally { busy.close(); }
    const before = readFileSync(join(env.dir, 'pos.db'));
    const bad = join(env.ctx.backupDir, 'manual-20000101T000000000Z.db');
    writeFileSync(bad, 'not a backup');
    const r2 = runRestore(env.dir, ['manual-20000101T000000000Z.db'], await freePort());
    assert.equal(r2.status, 1);
    assert.match(r2.stdout + r2.stderr, /not usable/);
    assert.deepEqual(readFileSync(join(env.dir, 'pos.db')), before);
    assert.ok(!readdirSync(env.dir).some((f) => f.startsWith('pre-restore-')));
  } finally { env.cleanup(); }
});
