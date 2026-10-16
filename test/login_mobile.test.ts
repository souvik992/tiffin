import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError } from '../src/store/db.ts';
import { createCtx, silentLogger } from '../src/services/ctx.ts';
import { createUser, deactivateUser, listLoginUsers, listUsers, loginByMobile, setupFirstRun, updateUser } from '../src/services/auth.ts';
import { FakeClock, makeEnv, rid } from './helpers.ts';

const code = (fn: () => unknown): string => { try { fn(); } catch (e) { if (e instanceof AppError) return e.code; throw e; } return 'NO_ERROR'; };

test('users get a mobile number; staff sign in with mobile number and PIN', () => {
  const env = makeEnv(); try {
    assert.equal(code(() => createUser(env.ctx, env.owner, rid(), { name: 'Ravi', role: 'cashier', pin: '4821', mobile: '12345' })), 'VALIDATION');
    assert.equal(code(() => createUser(env.ctx, env.owner, rid(), { name: 'Ravi', role: 'cashier', pin: '4821', mobile: '1234567890' })), 'VALIDATION'); // Indian mobiles start with 6-9
    const ravi = createUser(env.ctx, env.owner, rid(), { name: 'Ravi', role: 'cashier', pin: '4821', mobile: '9812345678' });
    assert.equal(code(() => createUser(env.ctx, env.owner, rid(), { name: 'Sita', role: 'cashier', pin: '1357', mobile: '9812345678' })), 'MOBILE_TAKEN');

    const r = loginByMobile(env.ctx, '9812345678', '4821');
    assert.equal(r.user.userId, ravi.id);
    assert.ok(env.ctx.sessions.has(r.token));
    assert.equal(code(() => loginByMobile(env.ctx, '9812345678', '0000')), 'BAD_PIN');
    assert.equal(code(() => loginByMobile(env.ctx, '9000099999', '4821')), 'BAD_PIN'); // unknown number: same answer as a wrong PIN
    for (let i = 0; i < 5; i++) code(() => loginByMobile(env.ctx, '9812345678', '0000'));
    assert.equal(code(() => loginByMobile(env.ctx, '9812345678', '4821')), 'LOCKED'); // wrong PINs lock the account, as before

    // the owner sees the number; the public sign-in list only says whether one is set
    assert.equal(listUsers(env.ctx, env.owner).find((u) => u.id === ravi.id)!.mobile, '9812345678');
    const pub = listLoginUsers(env.ctx).find((u) => u.id === ravi.id)!;
    assert.equal(pub.hasMobile, true);
    assert.ok(!('mobile' in pub), 'mobile numbers are not shown before sign-in');

    // a deactivated user keeps their number, so it cannot be given to someone else
    deactivateUser(env.ctx, env.owner, rid(), ravi.id);
    assert.equal(code(() => loginByMobile(env.ctx, '9812345678', '4821')), 'BAD_PIN');
    assert.equal(code(() => createUser(env.ctx, env.owner, rid(), { name: 'Sita', role: 'cashier', pin: '1357', mobile: '9812345678' })), 'MOBILE_TAKEN');
  } finally { env.cleanup(); }
});

test('the owner adds or changes a mobile number for existing staff', () => {
  const env = makeEnv(); try {
    const old = createUser(env.ctx, env.owner, rid(), { name: 'Old Timer', role: 'cashier', pin: '2468' }); // made before mobile numbers existed
    assert.equal(listLoginUsers(env.ctx).find((u) => u.id === old.id)!.hasMobile, false);
    updateUser(env.ctx, env.owner, rid(), { userId: old.id, name: 'Old Timer', role: 'cashier', mobile: '7000000001' });
    assert.equal(loginByMobile(env.ctx, '7000000001', '2468').user.userId, old.id);
    updateUser(env.ctx, env.owner, rid(), { userId: old.id, name: 'Old Timer', role: 'manager' }); // mobile left out: kept
    assert.equal(listUsers(env.ctx, env.owner).find((u) => u.id === old.id)!.mobile, '7000000001');
    const other = createUser(env.ctx, env.owner, rid(), { name: 'Other', role: 'cashier', pin: '1357', mobile: '7000000002' });
    assert.equal(code(() => updateUser(env.ctx, env.owner, rid(), { userId: other.id, name: 'Other', role: 'cashier', mobile: '7000000001' })), 'MOBILE_TAKEN');
    assert.equal(code(() => updateUser(env.ctx, env.manager, rid(), { userId: other.id, name: 'Other', role: 'cashier', mobile: '7000000003' })), 'FORBIDDEN');
  } finally { env.cleanup(); }
});

test('first-run setup stores the owner mobile number', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pos-test-'));
  const ctx = createCtx({ dataDir: dir, clock: new FakeClock(), logger: silentLogger, scryptCost: 1024 });
  try {
    const base = { outlet: { name: 'Shop', stateCode: '29' }, device: { name: 'C1', seriesPrefix: 'B1' } };
    assert.equal(code(() => setupFirstRun(ctx, rid(), { ...base, owner: { name: 'Asha', pin: '4821', mobile: '98123' } })), 'VALIDATION');
    const { ownerId } = setupFirstRun(ctx, rid(), { ...base, owner: { name: 'Asha', pin: '4821', mobile: '9876500001' } });
    assert.equal(loginByMobile(ctx, '9876500001', '4821').user.userId, ownerId);
  } finally { ctx.db.close(); rmSync(dir, { recursive: true, force: true }); }
});
