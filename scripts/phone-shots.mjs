// Screenshots of every screen at phone and tablet sizes, to check the mobile layout (development only).
// Starts a seeded backend in a temp folder and the UI dev server, signs in as the owner and visits each screen.
// Usage: node scripts/phone-shots.mjs [outDir] [routes...]   Needs Edge or Chrome and `npm install` in desktop/ (playwright-core).
// Env: SHOT_SIZES="390x844,768x1024" (default), SHOT_BROWSER (path to a Chromium browser).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const { chromium } = createRequire(join(root, 'desktop', 'package.json'))('playwright-core');
const out = process.argv[2] ?? join(root, 'test-results', 'phone-shots');
const only = process.argv.slice(3);
mkdirSync(out, { recursive: true });
const sizes = (process.env.SHOT_SIZES ?? '390x844,768x1024').split(',').map((s) => s.split('x').map(Number));
const browserPath = process.env.SHOT_BROWSER ?? ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome'].find((p) => existsSync(p));

const dataDir = mkdtempSync(join(tmpdir(), 'pos-shots-'));
const env = { ...process.env, POS_DATA_DIR: dataDir, POS_PORT: '4871', UI_PORT: '5191' };
delete env.ELECTRON_RUN_AS_NODE;
const run = (args, opts = {}) => spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'], ...opts });
await new Promise((ok, bad) => run(['src/seed.ts']).on('exit', (c) => (c === 0 ? ok() : bad(new Error(`seed failed ${c}`)))));
const backend = run(['src/main.ts']);
const ui = run([join(root, 'ui', 'node_modules', 'vite', 'bin', 'vite.js'), '--port', '5191', '--strictPort'], { cwd: join(root, 'ui') });
const stop = () => { backend.kill(); ui.kill(); };
process.on('exit', stop);

async function waitFor(url) {
  for (let i = 0; i < 100; i++) { try { const r = await fetch(url); if (r.status < 500) return; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 300)); }
  throw new Error(`${url} did not start`);
}
await waitFor('http://127.0.0.1:4871/api/ping');
await waitFor('http://127.0.0.1:5191/');
const { token } = await (await fetch('http://127.0.0.1:4871/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mobile: '9000000001', pin: '1234' }) })).json();

await fetch('http://127.0.0.1:4871/api/shifts/open', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'idempotency-key': 'shots-shift' }, body: JSON.stringify({ openingCash: 100000 }) });

// 'bill' is billing with two items in the cart, the bill opened (on a phone it covers the menu)
const routes = only.length ? only : ['billing', 'bill', 'menu-items', 'menu-categories', 'stock', 'purchases', 'orders', 'reports', 'settings'];
const browser = await chromium.launch({ executablePath: browserPath, headless: true });
try {
  for (const [w, h] of sizes) {
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1, isMobile: w < 900, hasTouch: true });
    await page.addInitScript((t) => localStorage.setItem('pos.session', t), token);
    for (const r of routes) {
      await page.goto(`http://127.0.0.1:5191/#/${r === 'bill' ? 'billing' : r}`);
      await page.waitForTimeout(1200);
      if (r === 'bill') {
        for (const name of ['Brownie', 'Cola 300ml']) { await page.getByText(name, { exact: true }).first().click(); await page.waitForTimeout(400); }
        const view = page.getByRole('button', { name: /View bill/ });
        if (await view.isVisible()) await view.click();
        await page.waitForTimeout(500);
      }
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      await page.screenshot({ path: join(out, `${w}-${r}.png`), fullPage: false });
      console.log(`${w}x${h} ${r}${wide > 0 ? `  SIDEWAYS SCROLL ${wide}px` : ''}`);
    }
    await page.close();
  }
} finally { await browser.close(); stop(); }
process.exit(0);
