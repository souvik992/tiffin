// Drives the real desktop app (Electron window, backend utility process, app:// scheme) with a temporary data folder.
// Needs `npm run build` first (npm test in desktop/ does not build; `npm run test:e2e` does).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron } from 'playwright-core';

const here = join(import.meta.dirname, '..');
// POS_E2E_EXE: run against a packaged build instead (release/win-unpacked/TiffinPOS.exe or the installed app)
const packaged = process.env.POS_E2E_EXE;
const electronExe = packaged ?? (createRequire(import.meta.url)('electron') as string);
const appArgs = packaged ? [] : [here];

function envFor(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
  return { ...env, POS_HOME: home };
}

// A packaged build always checks the licence (main.ts), so with no key it opens on the licence screen: check that much.
test('packaged app: opens on the licence screen without a key, backend up, closes cleanly', { skip: !packaged, timeout: 120_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'pos-desktop-'));
  const app = await _electron.launch({ executablePath: electronExe, args: appArgs, cwd: here, env: envFor(home) });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    assert.equal(page.url(), 'app://pos/index.html');
    await page.getByRole('button', { name: 'Start 30-day free trial' }).waitFor({ timeout: 60_000 });
    assert.equal(await page.evaluate(async () => (await fetch('/api/ping')).status), 200);
  } finally {
    await app.close();
  }
  assert.match(readFileSync(join(home, 'logs', 'pos.log'), 'utf8'), /POS backend listening[\s\S]*backend exited with code 0/);
  rmSync(home, { recursive: true, force: true });
});

test('desktop app: opens the POS, talks to its backend, stays locked down, restarts a crashed backend, closes cleanly', { skip: !!packaged && 'a packaged build needs a licence key: run without POS_E2E_EXE', timeout: 180_000 }, async () => {
  assert.ok(packaged ? existsSync(packaged) : existsSync(join(here, 'dist', 'main.cjs')), 'run npm run build first');
  const home = mkdtempSync(join(tmpdir(), 'pos-desktop-'));
  const dataDir = join(home, 'data');
  // dev seed: three users, virtual (memory) printers only, so nothing reaches a real printer
  execFileSync(process.execPath, [join(here, '..', 'src', 'seed.ts')], { env: { ...process.env, POS_DATA_DIR: dataDir }, stdio: 'ignore' });

  const app = await _electron.launch({ executablePath: electronExe, args: appArgs, cwd: here, env: envFor(home) });
  const consoleErrors: string[] = [];
  try {
    const page = await app.firstWindow();
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    await page.waitForLoadState('domcontentloaded');
    assert.equal(page.url(), 'app://pos/index.html');
    assert.match(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getTitle()), /^quickPOS/);

    // a cashier bills a coffee: commands, the print queue and the live events stream, all through app://pos/api
    await page.getByLabel('Mobile number').fill('9000000003'); // demo cashier
    await page.locator('h1').click(); // leave the field so the keys go to the PIN pad
    await page.keyboard.type('1111');
    await page.keyboard.press('Enter');
    await page.getByLabel('Opening cash in rupees').fill('1000');
    await page.getByRole('button', { name: 'Open shift' }).click();
    await page.locator('.item-card', { hasText: 'Cold Coffee' }).click();
    await page.waitForFunction(() => document.querySelector('aside')?.textContent?.includes('Cold Coffee') && !document.body.textContent?.includes('Updating…'));
    await page.getByLabel('Cash received').fill('500');
    await page.getByRole('button', { name: /^Charge ₹/ }).click();
    await page.getByText('Bill saved').waitFor();
    await page.getByText(/Receipt on Counter receipt \(virtual\): printed/).waitFor({ timeout: 20_000 }); // pushed by the events stream
    await page.locator('header button[aria-haspopup="menu"]').click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();

    // the manager sees that bill in Reports
    await page.getByLabel('Mobile number').fill('9000000002'); // demo manager
    await page.locator('h1').click();
    await page.keyboard.type('2345');
    await page.keyboard.press('Enter');
    await page.getByRole('link', { name: 'Reports' }).click();
    await page.getByRole('heading', { name: 'Sales summary' }).waitFor();
    await page.getByRole('button', { name: 'Download CSV' }).waitFor();
    await page.locator('tbody tr').first().waitFor();
    assert.deepEqual((await page.getByLabel('Summary').innerText()).split(/\s+/).slice(0, 2), ['Bills', '1']);

    // the page has no Node, no popups, no way out of the app
    const probe = await page.evaluate(() => ({
      node: typeof (globalThis as { process?: unknown }).process + '/' + typeof (globalThis as { require?: unknown }).require,
      popup: window.open('http://example.invalid/') === null, // not https: blocked without being handed to the real browser (https links open there by design)
    }));
    assert.deepEqual(probe, { node: 'undefined/undefined', popup: true });
    await page.evaluate(() => { location.href = 'https://example.invalid/'; });
    await page.waitForTimeout(500);
    assert.ok(page.url().startsWith('app://pos/'), 'navigation away is blocked');
    // a page cannot reach the backend directly: it does not know the port or the secret, and file:// is not served
    assert.equal(await page.evaluate(async () => (await fetch('/api/ping')).status), 200);
    assert.equal(await page.evaluate(async () => (await fetch('/../../data/pos.db')).status), 404);

    // second copy: exits at once, the first keeps running
    const second = spawnSync(electronExe, appArgs, { env: envFor(home), timeout: 30_000 });
    assert.equal(second.status, 0);
    assert.equal(await page.evaluate(async () => (await fetch('/api/ping')).status), 200);

    // backend crash: it is restarted and the window reloads
    const pid = await app.evaluate(({ app: a }) => a.getAppMetrics().find((m) => m.type === 'Utility' && m.name === 'quickPOS backend')?.pid);
    assert.ok(pid, 'backend utility process found');
    process.kill(pid!);
    await page.waitForEvent('load', { timeout: 60_000 });
    await page.getByRole('heading', { name: 'Sales summary' }).waitFor({ timeout: 60_000 }); // still signed in, on the same screen, after the restart (sign-ins are kept); bills are safe
    assert.equal(await page.getByLabel('Mobile number').count(), 0, 'no sign-in screen after a backend restart');
    assert.equal(await page.evaluate(async () => (await fetch('/api/ping')).status), 200);
    const newPid = await app.evaluate(({ app: a }) => a.getAppMetrics().find((m) => m.type === 'Utility' && m.name === 'quickPOS backend')?.pid);
    assert.ok(newPid && newPid !== pid);
  } finally {
    await app.close();
  }
  assert.deepEqual(consoleErrors.filter((e) => /Content Security Policy|Refused to/.test(e)), [], 'no CSP violations');
  // closing stops the backend cleanly: a closing backup exists
  assert.ok(readdirSync(join(dataDir, 'backups')).some((f) => f.startsWith('close-')), 'closing backup taken');
  assert.match(readFileSync(join(home, 'logs', 'pos.log'), 'utf8'), /POS backend listening/);
  rmSync(home, { recursive: true, force: true });
});

test('desktop app: the owner installs an add-on from a .tiffinaddon file and removes it (Settings > Add-ons)', { skip: !!packaged && 'needs a licence key', timeout: 180_000 }, async () => {
  assert.ok(existsSync(join(here, 'dist', 'main.cjs')), 'run npm run build first');
  const home = mkdtempSync(join(tmpdir(), 'pos-desktop-'));
  execFileSync(process.execPath, [join(here, '..', 'src', 'seed.ts')], { env: { ...process.env, POS_DATA_DIR: join(home, 'data') }, stdio: 'ignore' });
  // an unsigned package: it installs, then the POS switches it off for its signature (as it would a tampered one)
  const { zip } = await import('../../addons/ods/scripts/zip.mjs' as string) as { zip: (f: Array<[string, Buffer]>) => Buffer };
  const file = join(home, 'TiffinPOS-Demo-1.0.0.tiffinaddon');
  writeFileSync(file, zip([['manifest.json', Buffer.from(JSON.stringify({ id: 'demo', name: 'Demo add-on', version: '1.0.0' }))], ['backend.cjs', Buffer.from('exports.register = () => {};')]]));

  const app = await _electron.launch({ executablePath: electronExe, args: appArgs, cwd: here, env: envFor(home) });
  try {
    // the file picker answers with our file; the "restart now?" question answers Later
    await app.evaluate(({ dialog }, f) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [f] })) as typeof dialog.showOpenDialog;
      dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox;
    }, file);
    const page = await app.firstWindow();
    await page.getByLabel('Mobile number').fill('9000000001'); // demo owner
    await page.locator('h1').click();
    await page.keyboard.type('1234');
    await page.keyboard.press('Enter');
    await page.getByRole('link', { name: 'Settings' }).click();
    await page.getByRole('button', { name: /^Add-ons/ }).click();
    await page.getByText('No add-ons installed.').waitFor();
    await page.getByRole('button', { name: 'Install from file' }).click();
    await page.getByText('Demo add-on 1.0.0 is installed. Restart the POS to use it').waitFor();
    assert.deepEqual(readdirSync(join(home, 'addons', 'demo')).sort(), ['backend.cjs', 'manifest.json']);

    // the page's own fetch carries no sign-in: refused
    assert.equal(await page.evaluate(async () => (await fetch('/__desktop/remove-addon?id=demo', { method: 'POST' })).status), 403);
  } finally {
    await app.close();
  }

  // after a restart the POS lists it, switched off (not signed); the owner removes it
  const again = await _electron.launch({ executablePath: electronExe, args: appArgs, cwd: here, env: envFor(home) });
  try {
    await again.evaluate(({ dialog }) => { dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox; });
    const page = await again.firstWindow();
    await page.getByRole('link', { name: 'Settings' }).click(); // still signed in after a restart
    await page.evaluate(() => { window.confirm = () => true; }); // Electron's confirm box is native: answer "OK"
    await page.getByRole('button', { name: /^Add-ons/ }).click();
    const row = page.locator('li', { hasText: 'Demo add-on' });
    await row.getByText('Switched off').waitFor();
    await row.getByRole('button', { name: 'Remove' }).click();
    await page.getByText('Demo add-on removed. Restart the POS to finish.').waitFor();
    assert.equal(existsSync(join(home, 'addons', 'demo')), false);
  } finally {
    await again.close();
  }
  rmSync(home, { recursive: true, force: true });
});
