// Real Windows installer test for the rename (Tiffin POS -> quickPOS, 0.3.15): node scripts/test-installers.mjs
//
// Safe on a PC with a real POS installed: the POS installers built here have their own app id, program name and
// shortcut names ("Tiffin POS Test" -> "quickPOS Test", TiffinPOSTest.exe), so they never see, update, close or remove
// the real install, its shortcuts or its data. The installed test app runs on a temporary POS_HOME. The add-on
// installers are built with a temporary Programs folder and their own Windows Apps entry, and install into a temp folder.
// Everything this test installs is removed at the end, also when a check fails.
//
// Checks:
//  1. "old" (productName "Tiffin POS Test", 0.3.14) installs to Programs\TiffinPOSTest (electron-builder names the
//     folder after the program file, not the product name: the real POS lives in Programs\TiffinPOS) with that shortcut;
//  2. "new" (productName "quickPOS Test", 0.3.15) over it, silently as an update: stays in the same folder, the old
//     Desktop and Start menu shortcuts are replaced by "quickPOS Test", the Apps entry and the program's name change,
//     the program keeps its file name, and the shop's data folder is still there with the same rows;
//  3. a fresh install of "new" goes to the same Programs\TiffinPOSTest (the program file name did not change);
//  4. the ODS and payment machines add-on installers refuse without a POS and accept a POS in Programs\TiffinPOS
//     (and Programs\quickPOS or Programs\Tiffin POS, should a build ever use those); their uninstallers remove them.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

if (process.platform !== 'win32') { console.error('Windows only.'); process.exit(1); }
const here = join(import.meta.dirname, '..');
const repo = join(here, '..');
const require = createRequire(import.meta.url);
const base = require(join(here, 'electron-builder.config.cjs'));
const { _electron } = require('playwright-core');

const APP_ID = 'co.palletnow.tiffinpos.installtest';
const EXE = 'TiffinPOSTest';
const OLD = 'Tiffin POS Test', NEW = 'quickPOS Test';
const ADDON_KEY = 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\quickPOS-AddonInstallTest';
const local = process.env.LOCALAPPDATA;
const programs = join(local, 'Programs');
const appDir = join(programs, EXE); // the test program's folder
const work = mkdtempSync(join(tmpdir(), 'pos-installers-'));
const posHome = join(work, 'pos-home'); // the test app's data, never %LOCALAPPDATA%\TiffinPOS
const ps = (script) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }).trim();
const desktop = ps('[Environment]::GetFolderPath("Desktop")');
const startMenu = ps('[Environment]::GetFolderPath("Programs")');
const env = { ...process.env, POS_HOME: posHome };
delete env.ELECTRON_RUN_AS_NODE;

let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failed++; };
const lnk = (dir, name) => join(dir, `${name}.lnk`);
const target = (file) => ps(`(New-Object -ComObject WScript.Shell).CreateShortcut('${file.replace(/'/g, "''")}').TargetPath`);
const productName = (file) => ps(`(Get-Item -LiteralPath '${file.replace(/'/g, "''")}').VersionInfo.ProductName`);
/** The test app's Windows Apps entry (electron-builder names it by a GUID made from the app id). */
function appsEntry() {
  const r = spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s', '/f', 'POS Test', '/d'], { encoding: 'utf8' });
  const m = /DisplayName\s+REG_SZ\s+(.+)/.exec(r.stdout ?? '');
  return m ? m[1].trim() : null;
}
const killTestApp = () => spawnSync('taskkill', ['/F', '/IM', `${EXE}.exe`], { stdio: 'ignore' }); // only the test program name
const items = () => { const db = new DatabaseSync(join(posHome, 'data', 'pos.db'), { readOnly: true }); try { return db.prepare('SELECT COUNT(*) AS n FROM item').get().n; } finally { db.close(); } };

/** Opens the installed program on the test data: it must start its backend on POS_HOME (licence screen, no key). */
async function openApp(exe) {
  if (!existsSync(exe)) throw new Error(`${exe} is not there`);
  const app = await _electron.launch({ executablePath: exe, args: [], env });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Start 30-day free trial' }).waitFor({ timeout: 90_000 });
    return { title: await page.title(), ping: await page.evaluate(async () => (await fetch('/api/ping')).status) };
  } finally { await app.close(); }
}

function buildPos(name, version, out) {
  const cfg = join(work, `${out}.cjs`);
  const c = {
    ...base, appId: APP_ID, productName: name, extraMetadata: { version },
    directories: { ...base.directories, output: join(work, out) },
    win: { ...base.win, executableName: EXE },
    nsis: { ...base.nsis, shortcutName: name, artifactName: `${out}-setup.\${ext}` },
    publish: null,
  };
  writeFileSync(cfg, `module.exports = ${JSON.stringify(c)};`);
  console.log(`building the "${name}" ${version} test installer...`);
  execFileSync(process.execPath, [require.resolve('electron-builder/cli.js'), '--win', 'nsis', '--config', cfg], { cwd: here, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });
  return join(work, out, `${out}-setup.exe`);
}
const install = (setup) => { const r = spawnSync(setup, ['/S'], { env, stdio: 'ignore' }); killTestApp(); return r.status; };
function uninstallPos() {
  for (const dir of [appDir, join(programs, OLD), join(programs, NEW)]) {
    const u = existsSync(dir) ? readdirSync(dir).find((f) => /^Uninstall .*\.exe$/.test(f)) : null;
    if (u) spawnSync(join(dir, u), ['/S', `_?=${dir}`], { stdio: 'ignore' });
    rmSync(dir, { recursive: true, force: true });
  }
  for (const n of [OLD, NEW]) for (const d of [desktop, startMenu]) rmSync(lnk(d, n), { force: true });
  const r = spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s', '/f', 'POS Test', '/d'], { encoding: 'utf8' });
  for (const key of (r.stdout ?? '').split(/\r?\n/).filter((l) => l.startsWith('HKEY_CURRENT_USER'))) spawnSync('reg', ['delete', key, '/f'], { stdio: 'ignore' });
}

function makensis() {
  const find = (dir, depth = 0) => {
    if (depth > 4 || !existsSync(dir)) return null;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isFile() && e.name.toLowerCase() === 'makensis.exe') return p;
      if (e.isDirectory()) { const r = find(p, depth + 1); if (r) return r; }
    }
    return null;
  };
  return process.env.MAKENSIS ?? find(join(local, 'electron-builder', 'Cache'));
}

function addonInstallers(icon) {
  const nsis = makensis();
  for (const id of ['ods', 'edc']) {
    const src = join(repo, 'addons', 'dist', 'packages', id);
    if (!existsSync(join(src, 'manifest.json'))) execFileSync('npm', ['run', 'build'], { cwd: join(repo, 'addons', id), stdio: 'ignore', shell: true });
    const fake = join(work, `programs-${id}`);
    const setup = join(work, `${id}-setup.exe`);
    execFileSync(nsis, ['-V1', '-DVERSION=1.0.0', `-DSRC=${src}`, `-DOUTFILE=${setup}`, `-DICON=${icon}`, `-DPROGRAMS=${fake}`, `-DREGKEY=${ADDON_KEY}`, join(repo, 'addons', id, 'installer', `${id}.nsi`)], { stdio: 'inherit' });
    const dest = join(work, `addon-${id}`);
    const run = () => spawnSync(setup, ['/S', `/D=${dest}`], { stdio: 'ignore' }).status;
    mkdirSync(fake, { recursive: true });
    check(run() !== 0 && !existsSync(join(dest, 'manifest.json')), `${id} add-on installer: refuses when no POS is installed`);
    for (const folder of ['quickPOS', 'Tiffin POS', 'TiffinPOS']) {
      rmSync(fake, { recursive: true, force: true });
      mkdirSync(join(fake, folder), { recursive: true });
      writeFileSync(join(fake, folder, 'TiffinPOS.exe'), '');
      const status = run();
      check(status === 0 && existsSync(join(dest, 'manifest.json')), `${id} add-on installer: finds the POS in Programs\\${folder}`);
      spawnSync(join(dest, 'uninstall.exe'), ['/S', `_?=${dest}`], { stdio: 'ignore' });
      check(!existsSync(join(dest, 'manifest.json')) && spawnSync('reg', ['query', `HKCU\\${ADDON_KEY}`], { stdio: 'ignore' }).status !== 0, `${id} add-on uninstaller: removes it and its Apps entry`);
      rmSync(dest, { recursive: true, force: true });
    }
  }
}

// a crash anywhere (also inside Playwright) still removes what this test installed
const emergency = (e) => { console.error('FAIL ', e instanceof Error ? e.message : e); try { killTestApp(); uninstallPos(); rmSync(work, { recursive: true, force: true }); } finally { process.exit(1); } };
process.on('uncaughtException', emergency);
process.on('unhandledRejection', emergency);
try {
  if (existsSync(appDir) || appsEntry()) uninstallPos(); // a run that was stopped half-way
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: here, stdio: 'inherit' });
  const oldSetup = buildPos(OLD, '0.3.14', 'old');
  const newSetup = buildPos(NEW, '0.3.15', 'new');
  execFileSync(process.execPath, [join(repo, 'src', 'seed.ts')], { env: { ...env, POS_DATA_DIR: join(posHome, 'data') }, stdio: 'ignore' });
  const rows = items();

  // 1. the old name
  check(install(oldSetup) === 0, `"${OLD}" installer runs`);
  const oldExe = join(appDir, `${EXE}.exe`);
  check(existsSync(oldExe), `installed to Programs\\${EXE}`);
  check(existsSync(lnk(desktop, OLD)) && existsSync(lnk(startMenu, OLD)), `Desktop and Start menu shortcuts "${OLD}"`);
  check(appsEntry()?.startsWith(OLD) ?? false, `Windows Apps entry "${appsEntry()}"`);
  const before = await openApp(oldExe);
  check(before.ping === 200, 'the old program opens and its backend answers');

  // 2. the update to the new name
  check(install(newSetup) === 0, `"${NEW}" installer runs over it (silent, as an update)`);
  check(existsSync(oldExe) && !existsSync(join(programs, NEW)) && !existsSync(join(programs, OLD)), `the update stays in Programs\\${EXE} (program still ${EXE}.exe)`);
  check(!existsSync(lnk(desktop, OLD)) && !existsSync(lnk(startMenu, OLD)), `old shortcuts "${OLD}" are gone`);
  check(existsSync(lnk(desktop, NEW)) && existsSync(lnk(startMenu, NEW)), `new shortcuts "${NEW}" are there`);
  check(target(lnk(desktop, NEW)).toLowerCase() === oldExe.toLowerCase(), 'the new Desktop shortcut opens the installed program');
  check(appsEntry()?.startsWith(NEW) ?? false, `Windows Apps entry now "${appsEntry()}"`);
  check(productName(oldExe) === NEW, `the program's name (Task Manager, file properties) is "${productName(oldExe)}"`);
  const after = await openApp(oldExe);
  check(after.ping === 200 && after.title.startsWith('quickPOS'), `the updated program opens on the same data, window "${after.title}"`);
  check(items() === rows, `the shop's data is still there (${items()} menu items, before ${rows})`);
  check(readFileSync(join(posHome, 'logs', 'pos.log'), 'utf8').includes(`data=${join(posHome, 'data')}`), 'it used the same data folder');

  // 3. a fresh install under the new name
  uninstallPos();
  check(install(newSetup) === 0 && existsSync(oldExe) && !existsSync(join(programs, NEW)), `a fresh install goes to Programs\\${EXE}`);
  check(existsSync(lnk(desktop, NEW)), `fresh install: Desktop shortcut "${NEW}"`);
  uninstallPos();

  // 4. add-on installers
  addonInstallers(join(work, 'new', '.icon-ico', 'icon.ico'));
} catch (e) {
  failed++;
  console.error('FAIL ', e instanceof Error ? e.message : e);
} finally {
  killTestApp();
  uninstallPos();
  check(!existsSync(appDir) && !appsEntry() && !existsSync(lnk(desktop, NEW)), 'clean-up: nothing of the test left in Programs, Apps, Desktop');
  rmSync(work, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
