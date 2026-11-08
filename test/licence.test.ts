// P8-10 (fine-dine ADR-0007): Tiffin POS licensing. Keys from DinePOS Cloud (or the vendor's keygen), bound to this PC
// and labelled tiffin_qsr. Without a usable licence only the licence routes answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createServer, listen } from '../src/http/server.ts';
import { generateSigningKeyPair, loadSigningKey, publicKeyFromBase64 } from '../src/licence/signing.ts';
import { signKey, type TrustedKey } from '../src/licence/key.ts';
import type { LicenceConfig } from '../src/licence/service.ts';
import { renew } from '../src/licence/service.ts';
import { makeEnv, quickBill, rid, startShift } from './helpers.ts';
import type { Env } from './helpers.ts';

const DAY = 86_400_000;
const HW = 'AB12-CD34-EF56-7890-1A2B';
const cloudPair = generateSigningKeyPair();
const cloudKey = loadSigningKey(cloudPair.privateKeyPem);
const trusted: TrustedKey[] = [{ id: 'cloud', publicKey: publicKeyFromBase64(cloudPair.publicKeyBase64), maxDays: 400 }];

function key(env: Env, o: { days?: number; product?: string; hardwareId?: string; trial?: boolean; from?: number } = {}): string {
  const from = o.from ?? env.clock.now();
  return signKey({ kid: 'cloud', licensee: 'Chai Point', hardwareId: o.hardwareId ?? HW, issuedAt: new Date(from), expiresAt: new Date(from + (o.days ?? 30) * DAY),
    seats: { terminals: 1, captains: 0, kds: 1 }, features: o.trial === false ? [] : ['trial'], ...(o.product === undefined ? { product: 'tiffin_qsr' } : o.product === '' ? {} : { product: o.product }) }, cloudKey);
}

/** A stand-in DinePOS Cloud: /v1/activate and /v1/pos/licence. */
function fakeCloud(env: Env) {
  const st = { calls: [] as Array<{ url: string; body: any; auth: string | null }>, answer: null as null | { status: number; json: unknown }, slot: null as string | null };
  const f = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    st.calls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : null, auth: new Headers(init?.headers).get('authorization') });
    if (u.endsWith('/v1/pos/licence')) return Response.json({ key: st.slot });
    const a = st.answer ?? { status: 200, json: { kind: 'trial', product: 'tiffin_qsr', key: key(env), store: { slug: 'chai-point-1234', name: 'Chai Point' }, deviceKey: 'dk_test' } };
    return Response.json(a.json, { status: a.status });
  }) as typeof fetch;
  return { st, f };
}

interface Api { env: Env; call(method: string, path: string, o?: { body?: unknown; token?: string }): Promise<{ status: number; json: any }>; login(name: string, pin: string): Promise<{ status: number; json: any }>; close(): Promise<void>; cfg: LicenceConfig }

async function start(o: { seed?: boolean; enforced?: boolean; bills?: number; cloud?: typeof fetch } = {}): Promise<Api> {
  const env = makeEnv({ seed: o.seed ?? true });
  for (let i = 0; i < (o.bills ?? 0); i++) { if (i === 0) startShift(env); quickBill(env, [['Cheese Burger']]); }
  const cfg: LicenceConfig = { enforced: o.enforced ?? true, hardwareId: HW, cloudUrl: 'https://cloud.test', trusted, ...(o.cloud ? { fetch: o.cloud } : {}) };
  const server: Server = createServer(env.ctx, { licence: cfg });
  const base = `http://127.0.0.1:${await listen(server, 0)}`;
  const call: Api['call'] = async (method, path, x = {}) => {
    const headers: Record<string, string> = {};
    if (x.token) headers.authorization = `Bearer ${x.token}`;
    if (x.body !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET') headers['idempotency-key'] = rid('lic');
    const r = await fetch(base + path, { method, headers, body: x.body === undefined ? undefined : JSON.stringify(x.body) });
    return { status: r.status, json: await r.json() };
  };
  const login: Api['login'] = async (name, pin) => {
    const list = await call('GET', '/api/login-users');
    if (list.status !== 200) return list; // locked: the list is refused too
    const users = list.json as Array<{ id: string; name: string }>;
    return call('POST', '/api/auth/login', { body: { userId: users.find((u) => u.name === name)?.id ?? 'x', pin } });
  };
  return { env, call, login, cfg, close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); env.cleanup(); }) };
}

test('licence: a new install has no licence: everything but the licence routes is refused; signing in starts the 30-day trial', async () => {
  const cloud = fakeCloud(makeEnv());
  const api = await start({ cloud: cloud.f });
  try {
    const lic = (await api.call('GET', '/api/licence')).json;
    assert.deepEqual([lic.enforced, lic.usable, lic.state, lic.hardwareId], [true, false, 'none', HW]);
    assert.match(lic.message, /30-day free trial/);
    assert.equal(lic.renewUrl, 'https://portal.posinext.com/app/plans');
    // locked: sign-in and the rest answer LICENCE_REQUIRED with the licence; ping still answers
    const users = await api.call('GET', '/api/login-users');
    assert.deepEqual([users.status, users.json.error.code, users.json.error.details.licence.state], [403, 'LICENCE_REQUIRED', 'none']);
    assert.equal((await api.login('Owner', '1234')).json.error.code, 'LICENCE_REQUIRED');
    assert.equal((await api.call('GET', '/api/ping')).status, 200);
    // the lock screen signs in to DinePOS Cloud (no POS sign-in needed while locked)
    const act = await api.call('POST', '/api/licence/activate', { body: { mode: 'trial', email: 'owner@chaipoint.in', password: 'secret-123' } });
    assert.equal(act.status, 200, JSON.stringify(act.json));
    assert.deepEqual([act.json.usable, act.json.state, act.json.trial, act.json.linked], [true, 'ok', true, true]);
    const sent = cloud.st.calls[0]!;
    assert.equal(sent.url, 'https://cloud.test/v1/activate');
    assert.deepEqual([sent.body.product, sent.body.hardwareId, sent.body.mode, sent.body.link, sent.body.outletName], ['tiffin_qsr', HW, 'trial', true, 'Demo Burger Hub']);
    // the POS works now
    assert.equal((await api.login('Owner', '1234')).status, 200);
    // the password never reaches the audit log
    const auditText = JSON.stringify(api.env.ctx.db.prepare("SELECT action, detail FROM audit_log WHERE action LIKE 'licence.%'").all());
    assert.match(auditText, /licence\.activate/);
    assert.doesNotMatch(auditText, /secret-123/);
  } finally { await api.close(); }
});

test('licence: an install that already had bills keeps billing for 30 days, then locks; a pasted key opens it', async () => {
  const api = await start({ bills: 2 });
  try {
    const lic = (await api.call('GET', '/api/licence')).json;
    assert.deepEqual([lic.usable, lic.state, lic.daysLeft], [true, 'activate', 30]);
    assert.match(lic.message, /needs a licence\. Sign in with your account by/);
    assert.equal((await api.login('Owner', '1234')).status, 200);
    api.env.clock.advance(30 * DAY + 60_000);
    // the server works the licence out again at most every 30 seconds: a fresh server sees the change at once
  } finally { await api.close(); }
  // same data folder, 30 days later: locked
  const env2 = makeEnv({ seed: true });
  for (let i = 0; i < 1; i++) { startShift(env2); quickBill(env2, [['Cheese Burger']]); }
  const cfg: LicenceConfig = { enforced: true, hardwareId: HW, cloudUrl: 'https://cloud.test', trusted };
  const server = createServer(env2.ctx, { licence: cfg });
  const base = `http://127.0.0.1:${await listen(server, 0)}`;
  try {
    assert.equal((await (await fetch(`${base}/api/licence`)).json() as any).state, 'activate');
    env2.clock.advance(31 * DAY);
    const s2 = createServer(env2.ctx, { licence: cfg });
    const b2 = `http://127.0.0.1:${await listen(s2, 0)}`;
    try {
      const locked = await (await fetch(`${b2}/api/licence`)).json() as any;
      assert.deepEqual([locked.usable, locked.state], [false, 'none']);
      const wrongPc = await fetch(`${b2}/api/licence/install`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: key(env2, { hardwareId: '0000-1111-2222-3333-4444' }) }) });
      assert.equal(((await wrongPc.json()) as any).error.code, 'LICENCE_INVALID');
      const dinepos = await fetch(`${b2}/api/licence/install`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: key(env2, { product: 'fine_dine' }) }) });
      assert.match(((await dinepos.json()) as any).error.message, /another product/);
      const unlabelled = await fetch(`${b2}/api/licence/install`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: key(env2, { product: '' }) }) });
      assert.equal(unlabelled.status, 400, 'an unlabelled key is a DinePOS key');
      const ok = await fetch(`${b2}/api/licence/install`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: key(env2, { days: 365, trial: false }) }) });
      assert.deepEqual(((await ok.json()) as any).state, 'ok');
    } finally { await new Promise<void>((r) => { s2.close(() => r()); s2.closeAllConnections(); }); }
  } finally { await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }); env2.cleanup(); }
});

test('licence: warned before the end, 7 days of grace, then locked; turning the clock back does not help; renewals arrive by themselves', async () => {
  const cloud = fakeCloud(makeEnv());
  const api = await start({ cloud: cloud.f });
  try {
    await api.call('POST', '/api/licence/activate', { body: { mode: 'trial', email: 'owner@chaipoint.in', password: 'secret-123' } });
    const fresh = () => new Promise<any>((resolve) => {
      const s = createServer(api.env.ctx, { licence: api.cfg });
      void listen(s, 0).then(async (p) => { const j = await (await fetch(`http://127.0.0.1:${p}/api/licence`)).json(); s.close(); s.closeAllConnections(); resolve(j); });
    });
    api.env.clock.advance(28.5 * DAY);
    assert.equal((await fresh()).state, 'expiring');
    api.env.clock.advance(3 * DAY);
    const grace = await fresh();
    assert.deepEqual([grace.state, grace.usable], ['grace', true]);
    api.env.clock.advance(7 * DAY);
    assert.deepEqual([(await fresh()).state, (await fresh()).usable], ['expired', false]);
    api.env.clock.advance(-20 * DAY); // the PC's clock is turned back
    assert.equal((await fresh()).usable, false);
    // the cloud has a renewal (a paid plan): the hourly check installs it
    api.env.clock.advance(20 * DAY);
    cloud.st.slot = key(api.env, { days: 365, trial: false });
    assert.equal(await renew(api.env.ctx, api.cfg), true);
    const call = cloud.st.calls.at(-1)!;
    assert.deepEqual([call.url, call.auth], ['https://cloud.test/v1/pos/licence', 'Bearer dk_test']);
    assert.deepEqual([(await fresh()).state, (await fresh()).trial], ['ok', false]);
    // an older key in the slot never replaces a longer one
    cloud.st.slot = key(api.env, { days: 10 });
    assert.equal(await renew(api.env.ctx, api.cfg), false);
  } finally { await api.close(); }
});

test('licence: once it works, changing it needs an owner; the cloud\'s refusal is shown as it says; development runs are never locked', async () => {
  const cloud = fakeCloud(makeEnv());
  const api = await start({ cloud: cloud.f });
  try {
    cloud.st.answer = { status: 409, json: { error: { code: 'TRIAL_USED', message: 'This PC has already had a free Tiffin POS trial.' } } };
    const used = await api.call('POST', '/api/licence/activate', { body: { mode: 'trial', email: 'a@b.in', password: 'x' } });
    assert.deepEqual([used.status, used.json.error.code, used.json.error.message], [400, 'TRIAL_USED', 'This PC has already had a free Tiffin POS trial.']);
    cloud.st.answer = null;
    await api.call('POST', '/api/licence/activate', { body: { mode: 'trial', email: 'a@b.in', password: 'x' } });
    // usable now: a cashier (or nobody) cannot change the licence; the owner can
    const anon = await api.call('POST', '/api/licence/install', { body: { key: key(api.env, { days: 365 }) } });
    assert.equal(anon.status, 401);
    const cashier = (await api.login('Cashier', '1111')).json.token;
    assert.equal((await api.call('POST', '/api/licence/install', { token: cashier, body: { key: key(api.env, { days: 365 }) } })).status, 403);
    const owner = (await api.login('Owner', '1234')).json.token;
    assert.equal((await api.call('POST', '/api/licence/install', { token: owner, body: { key: key(api.env, { days: 365, trial: false }) } })).json.trial, false);
  } finally { await api.close(); }
  const dev = await start({ enforced: false });
  try {
    const lic = (await dev.call('GET', '/api/licence')).json;
    assert.deepEqual([lic.enforced, lic.usable, lic.state], [false, true, 'off']);
    assert.equal((await dev.login('Owner', '1234')).status, 200);
  } finally { await dev.close(); }
});
