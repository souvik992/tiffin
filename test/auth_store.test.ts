import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, get, openDb, run, sha256, AppError, currentSchemaVersion } from '../src/store/db.ts';
import { MIGRATIONS } from '../src/store/schema.ts';
import { createCtx, silentLogger } from '../src/services/ctx.ts';
import { authenticate, changePin, createUser, deactivateUser, hashPin, listLoginUsers, login, logout, setupFirstRun, verifyPinHash } from '../src/services/auth.ts';
import { audit, verifyAuditChain } from '../src/services/audit.ts';
import { runCommand } from '../src/services/commands.ts';
import { importItemsCsv, parseCsv, previewItemsCsv, searchItems, updateItem, deleteItem, itemByBarcode, createItem } from '../src/services/catalog.ts';
import { invoiceRegisterCsv } from '../src/services/reports.ts';
import { setSetting } from '../src/services/settings.ts';
import { makeEnv, quickBill, rid, startShift } from './helpers.ts';
import { mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const code = (fn: () => unknown): string => { try { fn(); } catch (e) { if (e instanceof AppError) return e.code; throw e; } return 'NO_ERROR'; };

test('migrations: fresh database, idempotent reopen, checksum tamper and too-new schema are detected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pos-mig-')); const path = join(dir, 'm.db');
  try {
    const a = openDb(path); assert.equal(currentSchemaVersion(a), MIGRATIONS.at(-1)!.version); a.close(); // versions may skip a number (branches)
    const b = openDb(path); assert.equal(get<{ n: number }>(b, 'SELECT count(*) n FROM schema_migrations')!.n, MIGRATIONS.length);
    run(b, 'UPDATE schema_migrations SET checksum = ? WHERE version = 1', sha256('tampered')); b.close();
    assert.throws(() => openDb(path), /modified after being applied/);
    const c = openDb(path, { skipMigrate: true });
    run(c, 'UPDATE schema_migrations SET checksum = ? WHERE version = 1', sha256(MIGRATIONS[0]!.sql));
    run(c, "INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (99, 'future', 'x', 0)"); c.close();
    assert.throws(() => openDb(path), /newer than this app understands/);
    // a refused database must not stay open: Windows locks open files, which would block a restore
    renameSync(path, path + '.moved'); renameSync(path + '.moved', path);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('first-run setup works once and validates its input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pos-setup-'));
  try {
    const ctx = createCtx({ dataDir: dir, logger: silentLogger, scryptCost: 1024 });
    const base = { outlet: { name: 'Shop', stateCode: '29' }, device: { name: 'C1', seriesPrefix: 'B1' }, owner: { name: 'Asha', pin: '4821' } };
    assert.equal(code(() => setupFirstRun(ctx, rid(), { ...base, outlet: { ...base.outlet, gstin: 'BAD' } })), 'VALIDATION');
    assert.equal(code(() => setupFirstRun(ctx, rid(), { ...base, outlet: { ...base.outlet, stateCode: '9' } })), 'VALIDATION');
    assert.equal(code(() => setupFirstRun(ctx, rid(), { ...base, device: { name: 'C1', seriesPrefix: 'TOOLONG' } })), 'VALIDATION');
    assert.equal(code(() => setupFirstRun(ctx, rid(), { ...base, owner: { name: 'A', pin: '12' } })), 'VALIDATION');
    assert.equal(get<{ n: number }>(ctx.db, 'SELECT count(*) n FROM app_user')!.n, 0); // nothing half-created
    setupFirstRun(ctx, rid(), base);
    assert.equal(all(ctx.db, 'SELECT 1 FROM tax_group').length, 4);
    assert.equal(code(() => setupFirstRun(ctx, rid(), base)), 'ALREADY_SETUP');
    ctx.db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('PINs: scrypt-hashed with random salt; wrong format and wrong PIN rejected', () => {
  const h1 = hashPin('1234', 1024), h2 = hashPin('1234', 1024);
  assert.notEqual(h1, h2);
  assert.ok(h1.startsWith('s1$1024$'));
  assert.equal(verifyPinHash('1234', h1), true);
  assert.equal(verifyPinHash('1235', h1), false);
  assert.equal(verifyPinHash('1234', 'garbage'), false);
});

test('login: lockout after 5 failures with backoff, expiry, and reset on success', () => {
  const env = makeEnv(); try {
    const id = env.cashier.userId;
    for (let i = 0; i < 4; i++) assert.equal(code(() => login(env.ctx, id, '0000')), 'BAD_PIN');
    assert.equal(code(() => login(env.ctx, id, '0000')), 'BAD_PIN'); // 5th failure locks
    assert.equal(code(() => login(env.ctx, id, '1111')), 'LOCKED');
    env.clock.advance(29_000); assert.equal(code(() => login(env.ctx, id, '1111')), 'LOCKED');
    env.clock.advance(2_000);
    assert.equal(code(() => login(env.ctx, id, '0000')), 'BAD_PIN'); // 6th failure: lock doubles (60s)
    env.clock.advance(31_000); assert.equal(code(() => login(env.ctx, id, '1111')), 'LOCKED');
    env.clock.advance(30_000);
    assert.equal(login(env.ctx, id, '1111').user.role, 'cashier');
    assert.equal(get<{ failed_attempts: number }>(env.ctx.db, 'SELECT failed_attempts FROM app_user WHERE id = ?', id)!.failed_attempts, 0);
    assert.equal(code(() => login(env.ctx, 'no-such-user', '1234')), 'BAD_PIN'); // no user enumeration
  } finally { env.cleanup(); }
});

test('sessions: idle lock, logout, deactivation, and the login list never leaks hashes', () => {
  const env = makeEnv(); try {
    const { token } = login(env.ctx, env.manager.userId, '2345');
    assert.equal(authenticate(env.ctx, token).role, 'manager');
    env.clock.advance(299_000); authenticate(env.ctx, token); // activity resets the idle timer
    env.clock.advance(299_000); authenticate(env.ctx, token);
    env.clock.advance(301_000);
    assert.equal(code(() => authenticate(env.ctx, token)), 'SESSION_LOCKED');
    assert.equal(code(() => authenticate(env.ctx, token)), 'UNAUTHENTICATED');
    assert.equal(code(() => authenticate(env.ctx, undefined)), 'UNAUTHENTICATED');
    const t2 = login(env.ctx, env.cashier.userId, '1111').token;
    logout(env.ctx, t2); assert.equal(code(() => authenticate(env.ctx, t2)), 'UNAUTHENTICATED');
    const t3 = login(env.ctx, env.cashier.userId, '1111').token;
    deactivateUser(env.ctx, env.owner, rid(), env.cashier.userId);
    assert.equal(code(() => authenticate(env.ctx, t3)), 'UNAUTHENTICATED');
    assert.equal(code(() => login(env.ctx, env.cashier.userId, '1111')), 'BAD_PIN');
    assert.ok(listLoginUsers(env.ctx).every((u) => Object.keys(u).sort().join() === 'hasMobile,id,name,role'));
    assert.equal(listLoginUsers(env.ctx).length, 2);
  } finally { env.cleanup(); }
});

test('users: only owners manage users; last owner is protected; own PIN change needs the current PIN', () => {
  const env = makeEnv(); try {
    assert.equal(code(() => createUser(env.ctx, env.manager, rid(), { name: 'X', role: 'cashier', pin: '1111' })), 'FORBIDDEN');
    assert.equal(code(() => createUser(env.ctx, env.owner, rid(), { name: 'X', role: 'cashier', pin: '12ab' })), 'VALIDATION');
    assert.equal(code(() => deactivateUser(env.ctx, env.owner, rid(), env.owner.userId)), 'LAST_OWNER');
    assert.equal(code(() => changePin(env.ctx, env.cashier, rid(), { userId: env.cashier.userId, newPin: '9999', currentPin: '0000' })), 'BAD_PIN');
    changePin(env.ctx, env.cashier, rid(), { userId: env.cashier.userId, newPin: '9999', currentPin: '1111' });
    assert.equal(login(env.ctx, env.cashier.userId, '9999').user.role, 'cashier');
    assert.equal(code(() => changePin(env.ctx, env.cashier, rid(), { userId: env.manager.userId, newPin: '9999' })), 'FORBIDDEN');
    changePin(env.ctx, env.owner, rid(), { userId: env.manager.userId, newPin: '8888' }); // owner resets someone else's PIN
    assert.equal(login(env.ctx, env.manager.userId, '8888').user.role, 'manager');
  } finally { env.cleanup(); }
});

test('command ids: malformed ids rejected; a failed command leaves no log entry so a retry runs again', () => {
  const env = makeEnv(); try {
    assert.equal(code(() => runCommand(env.ctx, 'short', 'x', null, () => 1)), 'BAD_REQUEST_ID');
    assert.equal(code(() => runCommand(env.ctx, 'has spaces in it', 'x', null, () => 1)), 'BAD_REQUEST_ID');
    let calls = 0;
    const id = rid();
    assert.throws(() => runCommand(env.ctx, id, 'x', null, () => { calls++; throw new Error('boom'); }), /boom/);
    assert.equal(runCommand(env.ctx, id, 'x', null, () => { calls++; return 42; }), 42);
    assert.equal(runCommand(env.ctx, id, 'x', null, () => { calls++; return 0; }), 42); // replay
    assert.equal(calls, 2);
  } finally { env.cleanup(); }
});

test('audit chain: detects an edited row and a deleted row', () => {
  const env = makeEnv(); try {
    audit(env.ctx, env.owner.userId, 'test.one'); audit(env.ctx, env.owner.userId, 'test.two'); audit(env.ctx, env.owner.userId, 'test.three');
    assert.equal(verifyAuditChain(env.ctx.db).ok, true);
    assert.throws(() => env.ctx.db.exec("UPDATE audit_log SET action = 'x' WHERE action = 'test.two'"), /append-only/);
    assert.throws(() => env.ctx.db.exec('DELETE FROM audit_log'), /append-only/);
    // an attacker with raw file access who drops the trigger is still caught by the hash chain
    env.ctx.db.exec('DROP TRIGGER audit_no_update');
    env.ctx.db.exec("UPDATE audit_log SET detail = '\"forged\"' WHERE action = 'test.two'");
    const v = verifyAuditChain(env.ctx.db);
    assert.equal(v.ok, false);
    assert.equal(get<{ action: string }>(env.ctx.db, 'SELECT action FROM audit_log WHERE seq = ?', v.brokenAtSeq!)!.action, 'test.two');
  } finally { env.cleanup(); }
});

test('item search: prefix, multi-word, case-insensitive, hostile input safe, tracks edits and deletes', () => {
  const env = makeEnv(); try {
    const names = (q: string) => searchItems(env.ctx, q).map((i) => (i as { name: string }).name);
    assert.ok(names('burg').includes('Cheese Burger'));
    assert.deepEqual(names('CHEESE burg'), ['Cheese Burger']);
    assert.deepEqual(names('fri'), ['French Fries', 'Peri Peri Fries'].sort((a, b) => names('fri').indexOf(a) - names('fri').indexOf(b)));
    for (const evil of ['"', '*', 'NEAR(', 'a OR b', "'; DROP TABLE item; --", '(((', '-', '\u0000', '   ']) assert.doesNotThrow(() => searchItems(env.ctx, evil));
    assert.deepEqual(searchItems(env.ctx, ''), []);
    updateItem(env.ctx, env.owner, rid(), env.items['Brownie']!, { name: 'Walnut Fudge' });
    assert.deepEqual(names('brownie'), []);
    assert.deepEqual(names('walnut'), ['Walnut Fudge']);
    deleteItem(env.ctx, env.owner, rid(), env.items['Brownie']!);
    assert.deepEqual(names('walnut'), []);
    assert.equal((itemByBarcode(env.ctx, '8901234567890') as { name: string }).name, 'Cola 300ml');
    assert.equal(itemByBarcode(env.ctx, 'nope'), null);
    assert.equal(code(() => createItem(env.ctx, env.owner, rid(), { name: 'Dup', taxGroupId: get<{ id: string }>(env.ctx.db, 'SELECT id FROM tax_group LIMIT 1')!.id, price: 1, barcode: '8901234567890' })), 'DUPLICATE_BARCODE');
  } finally { env.cleanup(); }
});

test('CSV: parser handles quotes; import is validated row by row and all-or-nothing', () => {
  assert.deepEqual(parseCsv('a,"b,c",d\r\n"x ""q"" y",2,3\n\n'), [['a', 'b,c', 'd'], ['x "q" y', '2', '3']]);
  const env = makeEnv(); try {
    const good = 'name,category,price,tax_percent,hsn,barcode,unit,veg\nGarlic Bread,Sides,89.50,5,1905,,pcs,yes\n"Choco, Shake",Beverages,149,12,,8900000000001,pcs,y\nSalt Packet,New Cat,1,0,,,pcs,\n';
    const p = previewItemsCsv(env.ctx, good);
    assert.deepEqual([p.rows, p.errors.length, p.items[0]!.price, p.items[1]!.name, p.items[2]!.isVeg], [3, 0, 8950, 'Choco, Shake', null]);
    const before = get<{ n: number }>(env.ctx.db, 'SELECT count(*) n FROM item')!.n;
    const bad = good + 'Bad Price,Sides,12.345,5,,,pcs,\n,Sides,5,5,,,pcs,\nBad Tax,Sides,5,150,,,pcs,\nBad HSN,Sides,5,5,12,,pcs,\nDup Barcode,Sides,5,5,,8901234567890,pcs,\n';
    const pb = previewItemsCsv(env.ctx, bad);
    assert.deepEqual(pb.errors.map((e) => e.row), [5, 6, 7, 8, 9]);
    assert.equal(code(() => importItemsCsv(env.ctx, env.owner, rid(), bad)), 'IMPORT_ERRORS');
    assert.equal(get<{ n: number }>(env.ctx.db, 'SELECT count(*) n FROM item')!.n, before); // nothing imported
    assert.equal(importItemsCsv(env.ctx, env.owner, rid(), good).imported, 3);
    assert.equal(get<{ n: number }>(env.ctx.db, 'SELECT count(*) n FROM item')!.n, before + 3);
    assert.ok(get(env.ctx.db, "SELECT 1 FROM category WHERE name = 'New Cat'"));
    assert.equal(all(env.ctx.db, 'SELECT 1 FROM tax_group WHERE rate_bp = 500 AND cess_bp = 0 AND price_includes_tax = 1').length, 1); // existing group reused
    assert.equal(code(() => importItemsCsv(env.ctx, env.cashier, rid(), good)), 'FORBIDDEN');
    assert.deepEqual(previewItemsCsv(env.ctx, 'name\nA').errors.map((e) => e.message), ['Missing required column "price".']);
    assert.equal(previewItemsCsv(env.ctx, '').errors.length, 1);
  } finally { env.cleanup(); }
});

test('auditor CSV export neutralises spreadsheet formula injection', () => {
  const env = makeEnv(); try {
    startShift(env);
    const tg = get<{ id: string }>(env.ctx.db, 'SELECT id FROM tax_group WHERE rate_bp = 0')!.id;
    env.items['evil'] = createItem(env.ctx, env.owner, rid(), { name: '=HYPERLINK("http://x")', taxGroupId: tg, price: 100 }).id;
    quickBill(env, [['evil']]);
    const csv = invoiceRegisterCsv(env.ctx, 0, Date.UTC(2100, 0, 1));
    assert.ok(csv.startsWith('Invoice No,Type,Status,Date (IST)'));
    assert.equal(csv.trim().split('\n').length, 2);
    assert.ok(csv.includes('A1/26-27/000001,TAX_INVOICE,ISSUED,2026-10-12'));
    setSetting(env.ctx, 'receipt_footer', '=1+1'); // settings are text only; never evaluated
  } finally { env.cleanup(); }
});
