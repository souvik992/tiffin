// Builds the Windows installers on this PC and uploads them to DinePOS Cloud (fine-dine cloud/hub, roadmap P8-11), which
// offers them in the customer portal (Client area > Downloads). CI does not publish installers; they are built here.
//
//   npm run release                 build Tiffin POS + ODS, then upload both
//   npm run release -- --no-build   upload the installers already built (the newest version of each)
//   npm run release -- --only tiffin    (or --only ods)
//   npm run release -- --allow-dirty    build even with uncommitted changes (not recommended)
//
// Where to upload: %USERPROFILE%\.dinepos\release.json  {"hubUrl": "https://cloud.example.com", "adminKey": "..."}
// (or DINEPOS_HUB_URL and DINEPOS_HUB_ADMIN_KEY): the same file fine-dine's `npm run release` uses. Never in the
// repository: the admin key runs the whole cloud. ODS is signed with %USERPROFILE%\.tiffinpos\addon-signing\private.pem
// (or POS_ADDON_SIGNING_KEY); without the key it is skipped. Each file is sent with its SHA-256; the cloud keeps it only
// if the bytes match. Building never installs anything on this PC.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;

// what CI's Windows job does (build.yml); unsigned until there is a code-signing certificate
const POS_BUILD = [
  { cwd: 'desktop', cmd: 'node', args: ['scripts/build.mjs'] },
  { cwd: 'desktop', cmd: 'npx', args: ['electron-builder', '--win', '--config', 'electron-builder.config.cjs', '--publish', 'never'], env: { CSC_IDENTITY_AUTO_DISCOVERY: 'false' } },
];
// The ODS installer uses the icon and NSIS that a Tiffin POS build leaves behind (addons/ods/scripts/installer.mjs)
const POS_ICON = path.join(repo, 'desktop', 'release', '.icon-ico', 'icon.ico');
const ITEMS = [
  { id: 'tiffin', name: 'Tiffin POS', dir: path.join(repo, 'desktop', 'release'), file: /^TiffinPOS-Setup-(.+)\.exe$/, build: POS_BUILD },
  {
    id: 'tiffin-ods', name: 'ODS', dir: path.join(repo, 'addons', 'dist', 'installers'), file: /^TiffinPOS-ODS-Setup-(.+)\.exe$/,
    build: [{ cwd: 'addons/ods', cmd: 'npm', args: ['run', 'installer'] }],
    before: () => (existsSync(POS_ICON) ? [] : (console.warn('(Tiffin POS is built first: the ODS installer needs its icon and NSIS)'), POS_BUILD)),
    needs: () => process.env.POS_ADDON_SIGNING_KEY ?? path.join(homedir(), '.tiffinpos', 'addon-signing', 'private.pem'),
  },
].filter((i) => !only || i.id === only || i.id === `tiffin-${only}`);
if (!ITEMS.length) fail('--only must be tiffin or ods');

function fail(msg) { console.error(`\n✖ ${msg}\n`); process.exit(1); }

function target() {
  let cfg = {};
  const file = path.join(homedir(), '.dinepos', 'release.json');
  if (existsSync(file)) {
    // a BOM (PowerShell 5.1's Set-Content -Encoding utf8 writes one) is not JSON; trimStart() drops it
    try { cfg = JSON.parse(readFileSync(file, 'utf8').trimStart()); } catch (e) { fail(`${file} is not valid JSON (${e.message}).`); }
  }
  const hubUrl = (process.env.DINEPOS_HUB_URL ?? cfg.hubUrl ?? '').replace(/\/+$/, '');
  const adminKey = process.env.DINEPOS_HUB_ADMIN_KEY ?? cfg.adminKey ?? '';
  if (!hubUrl || !adminKey) {
    fail(`Say where to upload. Create ${file} with:\n  {"hubUrl": "https://<your DinePOS Cloud address>", "adminKey": "<HUB_ADMIN_KEY of that server>"}`);
  }
  if (!/^https:\/\//.test(hubUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(hubUrl)) fail('hubUrl must be https:// (the admin key must not travel unencrypted).');
  return { hubUrl, adminKey };
}

/** The newest installer in a folder (by its file's time). */
function newest(item) {
  if (!existsSync(item.dir)) return null;
  const files = readdirSync(item.dir).filter((f) => item.file.test(f)).map((f) => ({ f, t: statSync(path.join(item.dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  return files[0] ? path.join(item.dir, files[0].f) : null;
}

const sha256 = (file) => new Promise((resolve, reject) => {
  const h = createHash('sha256');
  createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
});

/** PUT the file to the cloud, with progress. */
async function upload({ hubUrl, adminKey }, item, file) {
  const name = path.basename(file);
  const size = statSync(file).size;
  const hash = await sha256(file);
  const url = new URL(`${hubUrl}/v1/admin/downloads/${item.id}/${encodeURIComponent(name)}`);
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream', 'content-length': size, 'x-content-sha256': hash, 'x-admin-key': adminKey },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        process.stdout.write('\n');
        let body = null;
        try { body = JSON.parse(text); } catch { /* not JSON */ }
        if (res.statusCode === 200) resolve(body.file);
        else reject(new Error(`${res.statusCode}: ${body?.error?.message ?? text.slice(0, 200)}`));
      });
    });
    req.on('error', reject);
    let sent = 0, last = 0;
    const started = Date.now();
    createReadStream(file).on('data', (c) => {
      sent += c.length;
      if (Date.now() - last > 500 || sent === size) {
        last = Date.now();
        const mbps = sent / 1e6 / Math.max(0.001, (Date.now() - started) / 1000);
        process.stdout.write(`\r  uploading ${name}: ${Math.round((sent / size) * 100)}% of ${(size / 1e6).toFixed(1)} MB (${mbps.toFixed(1)} MB/s)   `);
      }
    }).pipe(req);
  });
}

const run = (step) => execFileSync(step.cmd, step.args, { cwd: path.join(repo, step.cwd), stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, ...step.env } });
const git = (a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();

const t = target();
// the address and the key, before a long build and before sending 150 MB
try {
  const r = await fetch(`${t.hubUrl}/v1/admin/downloads`, { headers: { 'x-admin-key': t.adminKey }, signal: AbortSignal.timeout(20_000) });
  if (r.status === 403 || r.status === 429) fail(`${t.hubUrl} refused the admin key (check adminKey in release.json).`);
  if (!r.ok) fail(`${t.hubUrl} answered ${r.status}; is it DinePOS Cloud, and updated?`);
} catch (e) { fail(`Cannot reach ${t.hubUrl}: ${e.cause?.code || e.cause?.message || e.message}`); }
const built = [];
if (!flag('--no-build')) {
  if (process.platform !== 'win32') fail('The Windows installers are built on Windows.');
  const dirty = git(['status', '--porcelain']);
  if (dirty && !flag('--allow-dirty')) fail(`There are uncommitted changes; commit them first so the installer matches a commit:\n${dirty}`);
  console.warn(`Building from ${git(['rev-parse', '--abbrev-ref', 'HEAD'])} @ ${git(['rev-parse', '--short', 'HEAD'])}`);
  for (const item of ITEMS) {
    if (item.needs && !existsSync(item.needs())) { console.warn(`\n! ${item.name} skipped: its signing key (${item.needs()}) is not on this PC.`); continue; }
    console.warn(`\n=== Building ${item.name}`);
    for (const step of [...(item.before?.() ?? []), ...item.build]) run(step);
    built.push(item.id);
  }
}

console.warn(`\n=== Uploading to ${t.hubUrl}`);
let failed = 0;
for (const item of ITEMS) {
  if (!flag('--no-build') && !built.includes(item.id)) continue;
  const file = newest(item);
  if (!file) { console.warn(`! ${item.name}: no installer in ${item.dir}`); continue; }
  try {
    const f = await upload(t, item, file);
    console.warn(`✔ ${item.name} ${f.version} is live (${(f.size / 1e6).toFixed(1)} MB, sha256 ${f.sha256.slice(0, 12)}…)`);
  } catch (e) { failed++; console.error(`✖ ${item.name}: ${e.message}`); }
}
if (failed) process.exit(1);
console.warn('\nCustomers now get these from the portal: Client area > Downloads.');
