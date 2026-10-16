import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get, AppError } from '../src/store/db.ts';
import { changePin, createUser, deactivateUser, listLoginUsers, listUsers, login, reactivateUser, updateUser } from '../src/services/auth.ts';
import { makeEnv, rid } from './helpers.ts';

const code = (fn: () => unknown): string => { try { fn(); } catch (e) { if (e instanceof AppError) return e.code; throw e; } return 'NO_ERROR'; };

test('owner creates users with a role and PIN; names must be unique among active users; only the owner can', () => {
  const env = makeEnv(); try {
    assert.equal(code(() => createUser(env.ctx, env.manager, rid(), { name: 'Ravi', role: 'cashier', pin: '4821' })), 'FORBIDDEN');
    assert.equal(code(() => listUsers(env.ctx, env.manager)), 'FORBIDDEN');
    assert.equal(code(() => createUser(env.ctx, env.owner, rid(), { name: 'Ravi', role: 'cashier', pin: '48a1' })), 'VALIDATION');
    assert.equal(code(() => createUser(env.ctx, env.owner, rid(), { name: 'Ravi', role: 'cashier', pin: '482' })), 'VALIDATION');
    const ravi = createUser(env.ctx, env.owner, rid(), { name: ' Ravi ', role: 'cashier', pin: '4821' });
    assert.deepEqual([ravi.name, ravi.role], ['Ravi', 'cashier']);
    assert.equal(code(() => createUser(env.ctx, env.owner, rid(), { name: 'ravi', role: 'manager', pin: '1357' })), 'NAME_TAKEN'); // the login screen picks people by name
    assert.ok(listLoginUsers(env.ctx).some((u) => u.name === 'Ravi'));
    assert.ok(login(env.ctx, ravi.id, '4821').token);
    const list = listUsers(env.ctx, env.owner);
    const r = list.find((u) => u.id === ravi.id)!;
    assert.deepEqual([r.name, r.role, r.active, r.locked], ['Ravi', 'cashier', true, false]);
    assert.ok(!('pinHash' in r) && !('pin_hash' in r), 'PIN hashes never leave the backend');
  } finally { env.cleanup(); }
});

test('owner changes a role or name, resets a PIN, deactivates and reactivates; the owner cannot lock themselves out', () => {
  const env = makeEnv(); try {
    const ravi = createUser(env.ctx, env.owner, rid(), { name: 'Ravi', role: 'cashier', pin: '4821' });
    updateUser(env.ctx, env.owner, rid(), { userId: ravi.id, name: 'Ravi K', role: 'manager' });
    assert.deepEqual(listUsers(env.ctx, env.owner).find((u) => u.id === ravi.id)!.role, 'manager');
    assert.equal(code(() => updateUser(env.ctx, env.owner, rid(), { userId: ravi.id, name: 'Manager', role: 'manager' })), 'NAME_TAKEN');
    assert.equal(code(() => updateUser(env.ctx, env.owner, rid(), { userId: env.owner.userId, name: 'Owner', role: 'manager' })), 'OWN_ROLE');
    assert.equal(code(() => deactivateUser(env.ctx, env.owner, rid(), env.owner.userId)), 'LAST_OWNER');
    const partner = createUser(env.ctx, env.owner, rid(), { name: 'Partner', role: 'owner', pin: '8642' });
    assert.equal(code(() => deactivateUser(env.ctx, env.owner, rid(), env.owner.userId)), 'SELF'); // not even with a second owner
    deactivateUser(env.ctx, env.owner, rid(), partner.id);

    changePin(env.ctx, env.owner, rid(), { userId: ravi.id, newPin: '9753' });
    assert.ok(login(env.ctx, ravi.id, '9753').token);

    deactivateUser(env.ctx, env.owner, rid(), ravi.id);
    assert.ok(!listLoginUsers(env.ctx).some((u) => u.id === ravi.id), 'not on the login screen');
    assert.equal(listUsers(env.ctx, env.owner).find((u) => u.id === ravi.id)!.active, false, 'still listed for the owner');
    assert.equal(code(() => login(env.ctx, ravi.id, '9753')), 'BAD_PIN'); // same answer as a wrong PIN: does not reveal the account
    // a new person can take the name of someone who left
    const other = createUser(env.ctx, env.owner, rid(), { name: 'Ravi K', role: 'cashier', pin: '2468' });
    assert.equal(code(() => reactivateUser(env.ctx, env.owner, rid(), ravi.id)), 'NAME_TAKEN');
    deactivateUser(env.ctx, env.owner, rid(), other.id);
    reactivateUser(env.ctx, env.owner, rid(), ravi.id);
    assert.ok(login(env.ctx, ravi.id, '9753').token);
    for (const a of ['user.create', 'user.update', 'user.change_pin', 'user.deactivate', 'user.reactivate']) assert.ok(get(env.ctx.db, 'SELECT 1 FROM audit_log WHERE action = ?', a), a);
  } finally { env.cleanup(); }
});
