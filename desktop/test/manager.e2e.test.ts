// Drives the real Tiffin Data Manager app (Electron window, backend utility process, app://manager) over a temporary
// shop's data folder. Needs `node scripts/build-manager.mjs` first (`npm run test:e2e:manager` does it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron } from 'playwright-core';
import { FakeClock, makeEnv, quickBill, startShift } from '../../test/helpers.ts';

const here = join(import.meta.dirname, '..');
// MANAGER_E2E_EXE: run against a packaged build instead (release-manager/win-unpacked/TiffinData.exe)
const packaged = process.env.MANAGER_E2E_EXE;
const electronExe = packaged ?? (createRequire(import.meta.url)('electron') as string);
const appArgs = packaged ? [] : [join(here, 'dist-manager', 'main.cjs')];

function envFor(home: string, dataDir: string, posExe: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
  return { ...env, MANAGER_HOME: home, POS_DATA_DIR: dataDir, MANAGER_POS_EXE: posExe };
}

test('Data Manager app: owner only, dashboard, all data, backup; view only while the POS runs', { timeout: 240_000 }, async () => {
  assert.ok(packaged ? existsSync(packaged) : existsSync(join(here, 'dist-manager', 'main.cjs')), 'run node scripts/build-manager.mjs first');
  const root = mkdtempSync(join(tmpdir(), 'mgr-e2e-'));
  const dataDir = join(root, 'data'), home = join(root, 'manager');
  // a shop with one bill today (demo users: owner 9000000001/1234, cashier 9000000003/1111)
  const env = makeEnv({ dir: dataDir, clock: new FakeClock(Date.now()) });
  startShift(env);
  quickBill(env, [['Cold Coffee', 1000]]);
  env.ctx.db.close();

  let app = await _electron.launch({ executablePath: electronExe, args: appArgs, cwd: here, env: envFor(home, dataDir, 'no-such-pos.exe') });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    assert.equal(page.url(), 'app://manager/manager.html');
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getTitle()), 'Tiffin Data Manager');

    const signIn = async (mobile: string, pin: string) => {
      await page.getByLabel('Mobile number').fill(mobile);
      await page.locator('h1').click();
      await page.keyboard.type(pin);
      await page.keyboard.press('Enter');
    };
    await page.getByText('Demo Burger Hub: sign in as the owner.').waitFor();
    await signIn('9000000003', '1111');
    await page.getByText('Only the owner can open Tiffin Data Manager.').waitFor();
    await signIn('9000000001', '1234');

    // dashboard: numbers from the backend's reports
    await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
    await page.getByText('You can make changes.').waitFor();
    const bills = page.locator('div', { has: page.locator('p', { hasText: /^Bills$/ }) }).locator('p.font-display').first();
    assert.equal((await bills.innerText()).trim(), '1');
    await page.getByRole('heading', { name: 'Best sellers' }).waitFor();
    await page.getByText('Cold Coffee').first().waitFor();

    // all data: every table, secrets hidden
    await page.getByRole('link', { name: 'All data' }).click();
    await page.getByRole('button', { name: /^Staff/ }).click();
    await page.getByRole('columnheader', { name: 'pin_hash' }).waitFor();
    assert.ok((await page.locator('tbody').innerText()).includes('(hidden)'));
    assert.ok(!(await page.locator('tbody').innerText()).includes('s1$'));

    // the POS's own menu screen, and bills view only
    await page.getByRole('link', { name: 'Menu' }).click();
    await page.getByText('Cold Coffee').first().waitFor();
    await page.getByRole('link', { name: 'Bills' }).click();
    await page.locator('tbody tr').first().click();
    await page.getByRole('button', { name: 'Print on screen' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Cancel bill' }).count(), 0, 'no cancelling here');
    assert.equal(await page.getByRole('button', { name: 'Reprint' }).count(), 0);
    await page.keyboard.press('Escape');

    // backup now
    await page.getByRole('link', { name: 'Backups' }).click();
    await page.getByRole('button', { name: 'Back up now' }).click();
    await page.getByText('Backup saved and checked.').waitFor({ timeout: 30_000 });
    assert.equal(readdirSync(join(dataDir, 'backups')).filter((f) => /^manual-.*\.db$/.test(f)).length, 1);

    // locked down like the POS window
    const probe = await page.evaluate(() => typeof (globalThis as { process?: unknown }).process + '/' + typeof (globalThis as { require?: unknown }).require);
    assert.equal(probe, 'undefined/undefined');
    assert.equal(await page.evaluate(async () => (await fetch('/../data/pos.db')).status), 404);
  } finally { await app.close(); }

  // "POS running" (any running program name works: this test's own node.exe): a copy, view only
  app = await _electron.launch({ executablePath: electronExe, args: appArgs, cwd: here, env: envFor(home, dataDir, 'node.exe') });
  try {
    const page = await app.firstWindow();
    await page.getByLabel('Mobile number').fill('9000000001');
    await page.locator('h1').click();
    await page.keyboard.type('1234');
    await page.keyboard.press('Enter');
    await page.getByText(/View only\. Tiffin POS is open on this computer/).waitFor();
    await page.getByRole('link', { name: 'Backups' }).click();
    assert.equal(await page.getByRole('button', { name: 'Restore from a file…' }).isDisabled(), true);
  } finally { await app.close(); }

  assert.deepEqual(readdirSync(join(home, 'snapshots')), [], 'copies are removed on close');
  rmSync(root, { recursive: true, force: true });
});
