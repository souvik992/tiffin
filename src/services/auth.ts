import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { all, get, run, AppError } from '../store/db.ts';
import type { Actor, Ctx, Role } from './ctx.ts';
import { getDevice } from './ctx.ts';
import { audit } from './audit.ts';
import { emit } from './outbox.ts';
import { runCommand } from './commands.ts';
import { assertPerm, can } from './permissions.ts';
import type { Permission } from './permissions.ts';
import { loadSettings, setSetting } from './settings.ts';
import { validDevicePrefix } from '../core/numbering.ts';

export function validPinFormat(pin: string): boolean { return /^\d{4,6}$/.test(pin); }

export function hashPin(pin: string, cost: number): string {
  const salt = randomBytes(16);
  const h = scryptSync(pin, salt, 32, { N: cost, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  return `s1$${cost}$${salt.toString('hex')}$${h.toString('hex')}`;
}
export function verifyPinHash(pin: string, stored: string): boolean {
  const [tag, n, salt, hash] = stored.split('$');
  if (tag !== 's1' || !n || !salt || !hash) return false;
  const h = scryptSync(pin, Buffer.from(salt, 'hex'), 32, { N: Number(n), r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  const expected = Buffer.from(hash, 'hex');
  return h.length === expected.length && timingSafeEqual(h, expected);
}

interface UserRow { id: string; name: string; role: Role; pin_hash: string; failed_attempts: number; locked_until: number | null; active: number; deleted_at: number | null }

const MAX_FAILS = 5;
function recordFailure(ctx: Ctx, u: UserRow): void {
  const fails = u.failed_attempts + 1;
  const lockMs = fails >= MAX_FAILS ? Math.min(15 * 60_000, 30_000 * 2 ** (fails - MAX_FAILS)) : 0;
  run(ctx.db, 'UPDATE app_user SET failed_attempts = ?, locked_until = ? WHERE id = ?', fails, lockMs ? ctx.clock.now() + lockMs : null, u.id);
  audit(ctx, u.id, 'auth.fail', 'user', u.id, { fails, lockedMs: lockMs });
}

/** Checks a PIN with lockout/backoff. Failure bookkeeping survives a surrounding transaction rollback. */
function checkPin(ctx: Ctx, u: UserRow | undefined, pin: string, insideTx: boolean): UserRow {
  if (!u || !u.active || u.deleted_at) throw new AppError('BAD_PIN', 'Incorrect user or PIN.', 401);
  const now = ctx.clock.now();
  if (u.locked_until && u.locked_until > now) {
    throw new AppError('LOCKED', `Too many wrong PINs. Try again in ${Math.ceil((u.locked_until - now) / 1000)} seconds.`, 429, { retryAfterMs: u.locked_until - now });
  }
  if (!validPinFormat(pin) || !verifyPinHash(pin, u.pin_hash)) {
    const err = new AppError('BAD_PIN', 'Incorrect user or PIN.', 401);
    if (insideTx) err.afterRollback = () => recordFailure(ctx, u);
    else recordFailure(ctx, u);
    throw err;
  }
  if (u.failed_attempts > 0 || u.locked_until) run(ctx.db, 'UPDATE app_user SET failed_attempts = 0, locked_until = NULL WHERE id = ?', u.id);
  return u;
}
const userRow = (ctx: Ctx, id: string) => get<UserRow>(ctx.db, 'SELECT * FROM app_user WHERE id = ?', id);

export interface Override { userId: string; pin: string }

/** Manager/owner approval for actions a cashier cannot do alone. Returns who approved. */
export function requireApproval(ctx: Ctx, actor: Actor, perm: Permission, override: Override | undefined | null, insideTx = true): string {
  if (can(actor.role, perm)) return actor.userId;
  if (!override) throw new AppError('APPROVAL_REQUIRED', 'A manager or owner must approve this.', 403, { permission: perm });
  const u = checkPin(ctx, userRow(ctx, override.userId), override.pin, insideTx);
  if (!can(u.role, perm)) throw new AppError('APPROVAL_REQUIRED', 'That user cannot approve this action.', 403, { permission: perm });
  audit(ctx, u.id, 'approval.granted', 'user', actor.userId, { permission: perm });
  return u.id;
}

export function login(ctx: Ctx, userId: string, pin: string): { token: string; user: Actor } {
  const u = checkPin(ctx, userRow(ctx, userId), pin, false);
  const token = randomBytes(32).toString('hex');
  const actor: Actor = { userId: u.id, role: u.role, name: u.name };
  ctx.sessions.set(token, { ...actor, token, lastSeen: ctx.clock.now() });
  audit(ctx, u.id, 'auth.login', 'user', u.id);
  return { token, user: actor };
}
export function logout(ctx: Ctx, token: string): void { ctx.sessions.delete(token); }

export function authenticate(ctx: Ctx, token: string | undefined): Actor {
  const s = token ? ctx.sessions.get(token) : undefined;
  if (!s) throw new AppError('UNAUTHENTICATED', 'Please sign in.', 401);
  const idleMs = loadSettings(ctx).idleLockSeconds * 1000;
  const now = ctx.clock.now();
  if (idleMs > 0 && now - s.lastSeen > idleMs) {
    ctx.sessions.delete(s.token);
    throw new AppError('SESSION_LOCKED', 'Locked after inactivity. Enter your PIN.', 401);
  }
  s.lastSeen = now;
  const u = userRow(ctx, s.userId);
  if (!u || !u.active || u.deleted_at) { ctx.sessions.delete(s.token); throw new AppError('UNAUTHENTICATED', 'Please sign in.', 401); }
  return { userId: s.userId, role: u.role, name: u.name };
}

export function listLoginUsers(ctx: Ctx) {
  return all<{ id: string; name: string; role: Role }>(ctx.db, 'SELECT id, name, role FROM app_user WHERE active = 1 AND deleted_at IS NULL ORDER BY name');
}

/** The login screen picks people by name, so two active users may not share one (case-insensitive). */
function assertNameFree(ctx: Ctx, name: string, exceptId: string | null) {
  const clash = get<{ id: string }>(ctx.db, "SELECT id FROM app_user WHERE active = 1 AND deleted_at IS NULL AND lower(name) = lower(?) AND id <> ?", name, exceptId ?? '');
  if (clash) throw new AppError('NAME_TAKEN', `Someone called "${name}" already signs in here. Add a surname or initial so the login screen tells them apart.`, 409);
}

/** Everyone who has an account (also deactivated ones), for the owner's Users screen. PIN hashes never leave the backend. */
export function listUsers(ctx: Ctx, actor: Actor) {
  assertPerm(actor, 'user.manage');
  const now = ctx.clock.now();
  return all<{ id: string; name: string; role: Role; active: number; locked_until: number | null; created_at: number }>(ctx.db,
    'SELECT id, name, role, active, locked_until, created_at FROM app_user WHERE deleted_at IS NULL ORDER BY active DESC, lower(name)')
    .map((u) => ({ id: u.id, name: u.name, role: u.role, active: u.active === 1, locked: u.locked_until !== null && u.locked_until > now, createdAt: u.created_at, you: u.id === actor.userId }));
}

export function createUser(ctx: Ctx, actor: Actor, requestId: string, input: { name: string; role: Role; pin: string }) {
  return runCommand(ctx, requestId, 'user.create', actor, () => {
    assertPerm(actor, 'user.manage');
    if (!input.name.trim() || input.name.length > 60) throw new AppError('VALIDATION', 'Name must be 1-60 characters.');
    if (!['owner', 'manager', 'cashier'].includes(input.role)) throw new AppError('VALIDATION', 'Invalid role.');
    if (!validPinFormat(input.pin)) throw new AppError('VALIDATION', 'PIN must be 4-6 digits.');
    assertNameFree(ctx, input.name.trim(), null);
    const id = ctx.ids.next();
    const now = ctx.clock.now();
    run(ctx.db, 'INSERT INTO app_user(id, name, role, pin_hash, created_at, updated_at) VALUES (?,?,?,?,?,?)', id, input.name.trim(), input.role, hashPin(input.pin, ctx.scryptCost), now, now);
    audit(ctx, actor.userId, 'user.create', 'user', id, { role: input.role });
    emit(ctx, 'user', id, 'upsert', { id, name: input.name.trim(), role: input.role });
    return { id, name: input.name.trim(), role: input.role };
  });
}

export function changePin(ctx: Ctx, actor: Actor, requestId: string, input: { userId: string; newPin: string; currentPin?: string }) {
  return runCommand(ctx, requestId, 'user.change_pin', actor, () => {
    if (!validPinFormat(input.newPin)) throw new AppError('VALIDATION', 'PIN must be 4-6 digits.');
    const target = userRow(ctx, input.userId);
    if (!target || target.deleted_at) throw new AppError('NOT_FOUND', 'User not found.', 404);
    if (input.userId === actor.userId) checkPin(ctx, target, input.currentPin ?? '', true);
    else assertPerm(actor, 'user.manage');
    run(ctx.db, 'UPDATE app_user SET pin_hash = ?, failed_attempts = 0, locked_until = NULL, version = version + 1, updated_at = ? WHERE id = ?', hashPin(input.newPin, ctx.scryptCost), ctx.clock.now(), input.userId);
    audit(ctx, actor.userId, 'user.change_pin', 'user', input.userId);
    return { ok: true };
  });
}

/** Changes a person's name or role (owner only). Takes effect on their next action (roles are read on every request). */
export function updateUser(ctx: Ctx, actor: Actor, requestId: string, input: { userId: string; name: string; role: Role }) {
  return runCommand(ctx, requestId, 'user.update', actor, () => {
    assertPerm(actor, 'user.manage');
    const u = userRow(ctx, input.userId);
    if (!u || u.deleted_at) throw new AppError('NOT_FOUND', 'User not found.', 404);
    const name = input.name.trim();
    if (!name || name.length > 60) throw new AppError('VALIDATION', 'Name must be 1-60 characters.');
    if (!['owner', 'manager', 'cashier'].includes(input.role)) throw new AppError('VALIDATION', 'Invalid role.');
    if (u.id === actor.userId && input.role !== u.role) throw new AppError('OWN_ROLE', 'You cannot change your own role. Another owner can.', 409);
    if (u.role === 'owner' && input.role !== 'owner' && u.active) {
      const owners = get<{ n: number }>(ctx.db, "SELECT count(*) n FROM app_user WHERE role='owner' AND active=1 AND deleted_at IS NULL")!.n;
      if (owners <= 1) throw new AppError('LAST_OWNER', 'The shop needs at least one owner.', 409);
    }
    if (u.active) assertNameFree(ctx, name, u.id);
    if (name === u.name && input.role === u.role) return { id: u.id, name, role: u.role };
    run(ctx.db, 'UPDATE app_user SET name = ?, role = ?, version = version + 1, updated_at = ? WHERE id = ?', name, input.role, ctx.clock.now(), u.id);
    audit(ctx, actor.userId, 'user.update', 'user', u.id, { before: { name: u.name, role: u.role }, after: { name, role: input.role } });
    emit(ctx, 'user', u.id, 'upsert', { id: u.id, name, role: input.role });
    return { id: u.id, name, role: input.role };
  });
}

/** Lets someone who left sign in again (owner only). Their old PIN works; the lock is cleared. */
export function reactivateUser(ctx: Ctx, actor: Actor, requestId: string, userId: string) {
  return runCommand(ctx, requestId, 'user.reactivate', actor, () => {
    assertPerm(actor, 'user.manage');
    const u = userRow(ctx, userId);
    if (!u || u.deleted_at) throw new AppError('NOT_FOUND', 'User not found.', 404);
    if (u.active) return { ok: true };
    assertNameFree(ctx, u.name, u.id);
    run(ctx.db, 'UPDATE app_user SET active = 1, failed_attempts = 0, locked_until = NULL, version = version + 1, updated_at = ? WHERE id = ?', ctx.clock.now(), userId);
    audit(ctx, actor.userId, 'user.reactivate', 'user', userId);
    return { ok: true };
  });
}

export function deactivateUser(ctx: Ctx, actor: Actor, requestId: string, userId: string) {
  return runCommand(ctx, requestId, 'user.deactivate', actor, () => {
    assertPerm(actor, 'user.manage');
    const u = userRow(ctx, userId);
    if (!u || u.deleted_at) throw new AppError('NOT_FOUND', 'User not found.', 404);
    if (u.role === 'owner') {
      const owners = get<{ n: number }>(ctx.db, "SELECT count(*) n FROM app_user WHERE role='owner' AND active=1 AND deleted_at IS NULL")!.n;
      if (owners <= 1) throw new AppError('LAST_OWNER', 'The last active owner cannot be deactivated.', 409);
    }
    if (userId === actor.userId) throw new AppError('SELF', 'You cannot deactivate yourself.', 409);
    run(ctx.db, 'UPDATE app_user SET active = 0, version = version + 1, updated_at = ? WHERE id = ?', ctx.clock.now(), userId);
    for (const [t, s] of ctx.sessions) if (s.userId === userId) ctx.sessions.delete(t);
    audit(ctx, actor.userId, 'user.deactivate', 'user', userId);
    return { ok: true };
  });
}

export interface SetupInput {
  outlet: { name: string; gstin?: string | null; fssaiNo?: string | null; stateCode: string; address?: string | null; phone?: string | null };
  device: { name: string; seriesPrefix: string };
  owner: { name: string; pin: string };
}

/** First-run setup. Only allowed while no user exists. Creates outlet, device, owner and starter GST groups. */
export function setupFirstRun(ctx: Ctx, requestId: string, input: SetupInput) {
  return runCommand(ctx, requestId, 'setup.first_run', null, () => {
    if (get<{ n: number }>(ctx.db, 'SELECT count(*) n FROM app_user')!.n > 0) throw new AppError('ALREADY_SETUP', 'Setup has already been completed.', 409);
    if (!input.outlet.name.trim()) throw new AppError('VALIDATION', 'Business name is required.');
    if (!/^\d{2}$/.test(input.outlet.stateCode)) throw new AppError('VALIDATION', 'State code must be 2 digits (for example 29).');
    if (input.outlet.gstin && !/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(input.outlet.gstin)) throw new AppError('VALIDATION', 'GSTIN format is invalid.');
    if (!validDevicePrefix(input.device.seriesPrefix)) throw new AppError('VALIDATION', 'Series prefix must be 1-2 capital letters or digits.');
    if (!validPinFormat(input.owner.pin)) throw new AppError('VALIDATION', 'PIN must be 4-6 digits.');
    const now = ctx.clock.now();
    const outletId = ctx.ids.next();
    const deviceId = ctx.ids.next();
    const ownerId = ctx.ids.next();
    run(ctx.db, 'INSERT INTO outlet(id, name, gstin, fssai_no, state_code, address, phone, created_at) VALUES (?,?,?,?,?,?,?,?)',
      outletId, input.outlet.name.trim(), input.outlet.gstin ?? null, input.outlet.fssaiNo ?? null, input.outlet.stateCode, input.outlet.address ?? null, input.outlet.phone ?? null, now);
    run(ctx.db, 'INSERT INTO device(id, outlet_id, name, series_prefix, created_at) VALUES (?,?,?,?,?)', deviceId, outletId, input.device.name, input.device.seriesPrefix, now);
    run(ctx.db, 'INSERT INTO app_user(id, name, role, pin_hash, created_at, updated_at) VALUES (?,?,?,?,?,?)', ownerId, input.owner.name.trim(), 'owner', hashPin(input.owner.pin, ctx.scryptCost), now, now);
    for (const [name, bp] of [['GST 0%', 0], ['GST 5%', 500], ['GST 12%', 1200], ['GST 18%', 1800]] as const) {
      run(ctx.db, 'INSERT INTO tax_group(id, name, rate_bp, cess_bp, price_includes_tax, updated_at) VALUES (?,?,?,?,1,?)', ctx.ids.next(), name, bp, 0, now);
    }
    setSetting(ctx, 'device_id', deviceId);
    audit(ctx, ownerId, 'setup.first_run', 'outlet', outletId);
    emit(ctx, 'outlet', outletId, 'upsert', { id: outletId, name: input.outlet.name, stateCode: input.outlet.stateCode });
    ctx.deviceCache = null;
    return { outletId, deviceId, ownerId };
  });
}
export { getDevice };
