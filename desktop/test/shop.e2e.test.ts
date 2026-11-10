// Shop rehearsal: the real desktop app (Electron, temporary data) with the signed ODS add-on, a real order hub on this PC
// and two network (TCP) printers that record the exact ESC/POS bytes, decoded to text. Customers order through the hub
// API like the ordering website. Covers what a QSR shop relies on: the buzzer, printing the bill and kitchen ticket on
// accept (manual and automatic), notes on the kitchen ticket, the preparation clock and late alarm, category order on
// the POS and online, and the print alarm when the kitchen printer is off.
// Needs: `npm run build` here and `npm run build` in addons/ods (npm run test:e2e:shop does both). Nothing reaches a
// real printer; the sound plays through the speakers and is counted in the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { _electron } from 'playwright-core';
import type { Page } from 'playwright-core';
import { parseEscPos } from '../../src/services/printing/virtual.ts';

const here = join(import.meta.dirname, '..');
const repo = join(here, '..');
const electronExe = createRequire(import.meta.url)('electron') as string;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Recorder { port: number; jobs: string[]; close: () => void }
/** A network receipt printer (like port 9100): each connection is one job, kept as decoded text. */
async function printer(): Promise<Recorder> {
  const jobs: string[] = [];
  const srv = net.createServer((s) => {
    const chunks: Buffer[] = [];
    s.on('data', (d) => chunks.push(d));
    s.on('end', () => { const b = Buffer.concat(chunks); if (b.length) jobs.push(parseEscPos(new Uint8Array(b)).text); });
    s.on('error', () => {});
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { port: (srv.address() as net.AddressInfo).port, jobs, close: () => srv.close() };
}
async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const p = (s.address() as net.AddressInfo).port;
  await new Promise((r) => s.close(r));
  return p;
}
async function until(f: () => boolean | Promise<boolean>, what: string, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await f()) return; await sleep(250); }
  assert.fail(`timed out: ${what}`);
}

test('shop rehearsal: online orders, buzzer, bill + KOT with notes, preparation clock, late alarm, categories, print alarm', { timeout: 420_000 }, async () => {
  assert.ok(existsSync(join(here, 'dist', 'main.cjs')), 'run npm run build first');
  const ods = join(repo, 'addons', 'dist', 'packages', 'ods');
  assert.ok(existsSync(join(ods, 'manifest.json')), 'run npm run build in addons/ods first');

  const bills = await printer(), kitchen = await printer();
  const home = mkdtempSync(join(tmpdir(), 'pos-shop-'));
  execFileSync(process.execPath, [join(repo, 'src', 'seed.ts')], { env: { ...process.env, POS_DATA_DIR: join(home, 'data') }, stdio: 'ignore' });
  cpSync(ods, join(home, 'addons', 'ods'), { recursive: true });

  const hubDir = mkdtempSync(join(tmpdir(), 'hub-shop-'));
  const hubPort = await freePort();
  const HUB = `http://localhost:${hubPort}`;
  const hubProc = spawn(process.execPath, [join(repo, 'hub', 'scripts', 'dev.ts')], { cwd: join(repo, 'hub'), env: { ...process.env, HUB_DATA_DIR: hubDir, HUB_PORT: String(hubPort), HUB_ADMIN_KEY: 'shop-test' } });
  let hubOut = '';
  hubProc.stdout.on('data', (d) => { hubOut += d; });
  hubProc.stderr.on('data', (d) => { hubOut += d; });
  await until(() => /connect\/[A-Z0-9-]+/.test(hubOut), 'hub started');
  const link = new RegExp(`(http://localhost:${hubPort}/connect/[A-Z0-9-]+)`).exec(hubOut)![1]!;
  const hub = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(HUB + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json() as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
  const app = await _electron.launch({ executablePath: electronExe, args: [here], cwd: here, env: { ...env, POS_HOME: home } });
  try {
    const page = await app.firstWindow();
    // count every tone played (the real AudioContext still plays it)
    await app.context().addInitScript(() => {
      const w = window as unknown as { __tones: number };
      w.__tones = 0;
      const orig = AudioContext.prototype.createOscillator;
      AudioContext.prototype.createOscillator = function (this: AudioContext) {
        const o = orig.call(this); const start = o.start.bind(o);
        o.start = (...a: Parameters<OscillatorNode['start']>) => { w.__tones++; start(...a); };
        return o;
      };
    });
    await page.reload();
    const tones = () => page.evaluate(() => (window as unknown as { __tones: number }).__tones);
    const text = () => page.locator('body').innerText();
    const signIn = async (mobile: string, pin: string) => {
      await page.getByLabel('Mobile number').fill(mobile);
      await page.locator('h1').click();
      await page.keyboard.type(pin);
      await page.keyboard.press('Enter');
    };
    /** Signed in and past "Loading…" (also after a reload: the sign-in is kept). */
    const signedIn = async () => {
      await page.waitForFunction(() => !document.querySelector('input[aria-label="Mobile number"]') && !document.body.innerText.includes('Loading…') && document.querySelectorAll('a[href^="#/"]').length > 3, undefined, { timeout: 30_000 });
    };
    // SHOP_SHOTS=<folder>: screenshots of the main moments, to look at by eye
    const shot = async (name: string) => { if (process.env.SHOP_SHOTS) await page.screenshot({ path: join(process.env.SHOP_SHOTS, `${name}.png`) }); };
    await signIn('9000000001', '1234'); // owner
    await signedIn();

    // the owner's API, from inside the app (same origin, own token)
    const api = async (method: string, path: string, body?: unknown) => page.evaluate(async ([m, p, b]) => {
      const w = window as unknown as { __tok?: string };
      const json = { 'content-type': 'application/json', 'Idempotency-Key': crypto.randomUUID() };
      if (!w.__tok) w.__tok = (await (await fetch('/api/auth/login', { method: 'POST', headers: json, body: JSON.stringify({ mobile: '9000000001', pin: '1234' }) })).json()).token;
      const r = await fetch('/api' + p, { method: m as string, headers: { ...json, 'Idempotency-Key': crypto.randomUUID(), Authorization: 'Bearer ' + w.__tok }, body: b === undefined ? undefined : JSON.stringify(b) });
      return { status: r.status, json: await r.json().catch(() => null) };
    }, [method, path, body] as const);

    assert.equal((await api('POST', '/shifts/open', { openingCash: 100000 })).status, 200);
    const printers = (await api('GET', '/printers')).json as Array<{ id: string; isReceipt: boolean }>;
    for (const p of printers) assert.ok((await api('PATCH', `/printers/${p.id}`, { transport: 'tcp', address: `127.0.0.1:${p.isReceipt ? bills.port : kitchen.port}` })).status < 300);
    assert.ok((await api('POST', '/addons/ods/hub/pair', { hubUrl: link, code: '' })).status < 300, 'paired with the hub');
    const online = (acceptMode: 'manual' | 'auto') => api('PUT', '/addons/ods/config', { enabled: true, channels: { app: false, website: true, swiggy: false, zomato: false }, acceptMode, acceptTimeoutMin: 5, fulfilment: { pickup: true, delivery: false }, payments: { online: false, cod: true } });
    assert.ok((await online('manual')).status < 300);
    assert.ok((await api('PUT', '/addons/ods/print-options', { bill: true, kot: true })).status < 300);
    await page.reload(); // the buzzer starts once online orders are on
    await signedIn();

    let store = await hub('GET', '/v1/stores/demo?channel=website');
    await until(async () => { store = await hub('GET', '/v1/stores/demo?channel=website'); return store.json.open === true && store.json.menu?.items?.length > 0; }, 'menu published, store open');
    const items = store.json.menu.items as Array<{ id: string; name: string }>;
    const burger = items.find((i) => i.name === 'Cheese Burger')!, brownie = items.find((i) => i.name === 'Brownie')!;
    const place = async (mobile: string, burgerNote: string | null, note: string | null) => {
      const { json: s } = await hub('POST', '/v1/otp/send', { mobile });
      const { json: v } = await hub('POST', '/v1/otp/verify', { mobile, otp: s.devCode });
      const lines = [{ itemId: burger.id, qtyMilli: 2000, modifierIds: [], note: burgerNote }, { itemId: brownie.id, qtyMilli: 1000, modifierIds: [], note: null }];
      const q = await hub('POST', '/v1/stores/demo/quote', { fulfilment: 'PICKUP', lines, channel: 'website' });
      const r = await hub('POST', '/v1/stores/demo/orders', { fulfilment: 'PICKUP', payment: 'COD', customer: { name: 'Shop Test', mobile }, otpToken: v.otpToken, location: null, address: null, lines, note, menuVersion: store.json.menu.version, expectedTotal: q.json.total, channel: 'website' });
      assert.equal(r.status, 201, JSON.stringify(r.json));
      return r.json as { order: { id: string; number: string } };
    };

    // 1. manual accept: banner + buzzer on Billing until accepted; accept prints one bill and the KOTs with the notes
    let t0 = await tones();
    const o1 = await place('9811111111', 'NO ONION, extra spicy', 'Allergic to peanuts');
    await page.getByText(`New online order ${o1.order.number}`).waitFor({ timeout: 10_000 });
    await sleep(7000);
    assert.ok((await tones()) - t0 >= 12, 'the buzzer rings and repeats while the order waits');
    await page.goto('app://pos/index.html#/ods');
    await page.getByRole('button', { name: /^Accept$/ }).waitFor();
    assert.match(await text(), /Accept within \d+:\d\d/);
    await page.getByLabel(`Preparation time for ${o1.order.number}`).selectOption('10');
    await page.getByRole('button', { name: /^Accept$/ }).click();
    await until(() => bills.jobs.length === 1 && kitchen.jobs.length === 2, 'bill and two station KOTs printed');
    t0 = await tones(); await sleep(3500);
    assert.equal(await tones(), t0, 'the buzzer stops once accepted');
    assert.match(bills.jobs[0]!, /TAX INVOICE/);
    assert.match(bills.jobs[0]!, /Note: NO ONION, extra spicy/);
    const kot = kitchen.jobs.join('\n');
    assert.match(kot, />> NO ONION, extra spicy/, 'item note on the KOT');
    assert.match(kot, /Allergic to peanuts/, 'order note on the KOT');
    assert.match(kot, /ONLINE ORDER - KOT/);
    // the preparation clock counts down on the accepted card
    await page.getByLabel(new RegExp(`Preparation time for ${o1.order.number}: Ready in (9:\\d\\d|10:00)`)).waitFor({ timeout: 5000 });
    await shot('1-ods-preparation-clock');

    // 2. automatic accept: rings, banner on Billing, bill + KOT print by themselves
    assert.ok((await online('auto')).status < 300);
    await page.goto('app://pos/index.html#/billing');
    t0 = await tones();
    const before = { b: bills.jobs.length, k: kitchen.jobs.length };
    const o2 = await place('9822222222', 'Less salt', null);
    await page.getByText(/Accepted automatically/).waitFor({ timeout: 10_000 });
    await until(() => bills.jobs.length === before.b + 1 && kitchen.jobs.length === before.k + 2, `order ${o2.order.number} printed`);
    assert.match(kitchen.jobs.slice(before.k).join('\n'), />> Less salt/);
    await sleep(2000);
    assert.ok((await tones()) - t0 >= 6, 'an order accepted automatically still rings');

    // 3. late alarm: accept with 1 minute; after it passes, a red banner on Billing and the late alarm sounds
    assert.ok((await online('manual')).status < 300);
    const o3 = await place('9833333333', null, null);
    await page.getByText(`New online order ${o3.order.number}`).waitFor({ timeout: 10_000 });
    assert.ok((await api('POST', `/addons/ods/orders/${o3.order.id}/accept`, { prepMinutes: 1 })).status < 300);
    await page.getByText(new RegExp(`Running late: .*${o3.order.number}`)).waitFor({ timeout: 75_000 });
    await shot('2-billing-running-late');
    await page.goto('app://pos/index.html#/ods');
    await page.getByLabel(new RegExp(`Preparation time for ${o3.order.number}: Late by 1 min`)).waitFor({ timeout: 5000 });
    await shot('3-ods-late-card');
    assert.ok((await api('POST', `/addons/ods/orders/${o3.order.id}/step`, { to: 'READY' })).status < 300);
    await page.goto('app://pos/index.html#/billing');
    await until(async () => !(await text()).includes('Running late'), 'late banner gone once Ready');

    // 4. category order: on the POS at once, online within one menu publish
    const cats = ((await api('GET', '/catalog')).json as { categories: Array<{ id: string; name: string }> }).categories;
    const reversed = [...cats].reverse();
    assert.ok((await api('PUT', '/categories/order', { ids: reversed.map((c) => c.id) })).status < 300);
    await page.reload();
    await signedIn();
    const shown = await text();
    const at = reversed.map((c) => shown.indexOf(c.name));
    assert.ok(at.every((p, i) => p >= 0 && (i === 0 || p > at[i - 1]!)), 'Billing shows the new category order');
    await until(async () => {
      const m = (await hub('GET', '/v1/stores/demo?channel=website')).json.menu as { categories: Array<{ name: string; sort: number }> };
      return JSON.stringify([...m.categories].sort((a, b) => a.sort - b.sort).map((c) => c.name)) === JSON.stringify(reversed.map((c) => c.name));
    }, 'online menu follows the category order', 40_000);

    // 5. kitchen printer off: the print alarm (banner + sound) on every screen, Retry prints once it is back
    const kitchenPrinter = printers.find((p) => !p.isReceipt)!;
    kitchen.close();
    const dead = await freePort();
    assert.ok((await api('PATCH', `/printers/${kitchenPrinter.id}`, { address: `127.0.0.1:${dead}` })).status < 300);
    assert.ok((await online('auto')).status < 300);
    await page.goto('app://pos/index.html#/reports'); // not the Billing screen: the alarm shows everywhere
    await page.getByRole('heading', { name: 'Sales summary' }).waitFor();
    t0 = await tones();
    await place('9844444444', 'Extra cheese please', null);
    await page.getByRole('alert', { name: 'Printing failed' }).waitFor({ timeout: 40_000 });
    assert.match(await page.getByRole('alert', { name: 'Printing failed' }).innerText(), /Kitchen ticket \(token \d+, bill .+\) did not print on Kitchen/);
    await sleep(4500);
    assert.ok((await tones()) - t0 >= 8, 'the print alarm sounds and repeats');
    await shot('4-reports-print-alarm');
    const back = await printer();
    assert.ok((await api('PATCH', `/printers/${kitchenPrinter.id}`, { address: `127.0.0.1:${back.port}` })).status < 300);
    await page.getByRole('button', { name: 'Retry' }).click();
    await until(() => back.jobs.length === 2, 'both kitchen tickets printed after Retry', 20_000);
    assert.match(back.jobs.join('\n'), />> Extra cheese please/);
    await page.getByRole('alert', { name: 'Printing failed' }).waitFor({ state: 'detached', timeout: 15_000 });
    back.close();
  } finally {
    await app.close();
    hubProc.kill();
    bills.close(); kitchen.close();
    await sleep(500);
    rmSync(home, { recursive: true, force: true });
    try { rmSync(hubDir, { recursive: true, force: true }); } catch { /* the hub may still hold its file for a moment */ }
  }
});
