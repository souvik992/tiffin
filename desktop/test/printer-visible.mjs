// Manual check (not part of npm test): opens the desktop app on a temporary data folder and reads the
// "USB printers plugged into this PC" list in Settings > Printer setup. Looks only: nothing is printed.
// Usage: node test/printer-visible.mjs [path to TiffinPOS.exe]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron } from 'playwright-core';

const here = join(import.meta.dirname, '..');
const exe = process.argv[2] ?? createRequire(import.meta.url)('electron');
const home = mkdtempSync(join(tmpdir(), 'pos-desktop-'));
execFileSync(process.execPath, [join(here, '..', 'src', 'seed.ts')], { env: { ...process.env, POS_DATA_DIR: join(home, 'data') }, stdio: 'ignore' });
const env = { ...process.env, POS_HOME: home };
delete env.ELECTRON_RUN_AS_NODE;
const app = await _electron.launch({ executablePath: exe, args: process.argv[2] ? [] : [here], env });
try {
  const page = await app.firstWindow();
  await page.getByRole('button', { name: /^Owner/ }).click();
  await page.keyboard.type('1234');
  await page.keyboard.press('Enter');
  await page.getByRole('link', { name: 'Settings' }).click();
  const usb = page.locator('section[aria-label="USB printers plugged into this PC"]');
  await usb.getByText(/No USB printer found|Not set up|Set up as/).first().waitFor({ timeout: 60_000 });
  console.log((await usb.innerText()).replace(/\n+/g, ' | '));
  await page.screenshot({ path: join(home, '..', 'pos-printer-setup.png') });
} finally {
  await app.close();
  rmSync(home, { recursive: true, force: true });
}
