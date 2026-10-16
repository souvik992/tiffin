// Drives the real desktop app (Electron window, backend utility process, app:// scheme) with a temporary data folder.
// Needs `npm run build` first (npm test in desktop/ does not build; `npm run test:e2e` does).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
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

test('desktop app: opens the POS, talks to its backend, stays locked down, restarts a crashed backend, closes cleanly', { timeout: 180_000 }, async () => {
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
    assert.match(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getTitle()), /^Tiffin POS/);

    // a cashier bills a coffee: commands, the print queue and the live events stream, all through app://pos/api
    await page.getByRole('button', { name: /^Cashier/ }).click();
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
    await page.getByRole('button', { name: /^Manager/ }).click();
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
      popup: window.open('https://example.com') === null,
    }));
    assert.deepEqual(probe, { node: 'undefined/undefined', popup: true });
    await page.evaluate(() => { location.href = 'https://example.com/'; });
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
    const pid = await app.evaluate(({ app: a }) => a.getAppMetrics().find((m) => m.type === 'Utility' && m.name === 'Tiffin POS backend')?.pid);
    assert.ok(pid, 'backend utility process found');
    process.kill(pid!);
    await page.waitForEvent('load', { timeout: 60_000 });
    await page.getByRole('button', { name: /^Manager/ }).waitFor({ timeout: 60_000 }); // signed out after the restart; bills are safe
    assert.equal(await page.evaluate(async () => (await fetch('/api/ping')).status), 200);
    const newPid = await app.evaluate(({ app: a }) => a.getAppMetrics().find((m) => m.type === 'Utility' && m.name === 'Tiffin POS backend')?.pid);
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
