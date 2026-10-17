// Prepares the Android project for a build (run from the repo root: `node android/scripts/prepare.ts`).
//  1. Node 24 for Android (Termux's nodejs-lts and its libraries, pinned in android/node-runtime.json with SHA-256),
//     renamed to lib*.so and placed in app/src/main/jniLibs/<abi>/ (the only place Android lets an app run programs from).
//  2. The POS backend (src, contract, templates, android/backend) and the built UI (ui/dist) into app/src/main/assets/pos.
// `--lock` refreshes android/node-runtime.json from the current Termux index (then review and commit it).
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { apkName, readElf, renameLib } from './elf.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const ANDROID = join(ROOT, 'android');
const LOCK = join(ANDROID, 'node-runtime.json');
const CACHE = join(ANDROID, '.cache');
const APP = join(ANDROID, 'app', 'src', 'main');
const REPO = 'https://packages.termux.dev/apt/termux-main';
const ABIS: Record<string, string> = { 'arm64-v8a': 'aarch64', 'armeabi-v7a': 'arm', x86_64: 'x86_64' };
const SYSTEM = new Set(['libc.so', 'libm.so', 'libdl.so', 'liblog.so', 'libandroid.so']);
const NEEDED_PACKAGES = ['nodejs-lts'];

interface Pkg { name: string; version: string; filename: string; sha256: string }
interface Lock { repo: string; abis: Record<string, Pkg[]> }

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function lock() {
  const out: Lock = { repo: REPO, abis: {} };
  for (const [abi, arch] of Object.entries(ABIS)) {
    const r = await fetch(`${REPO}/dists/stable/main/binary-${arch}/Packages`);
    if (!r.ok) throw new Error(`Termux index for ${arch}: HTTP ${r.status}`);
    const pkgs = new Map<string, Record<string, string>>();
    for (const block of (await r.text()).split(/\n\n+/)) {
      const f = Object.fromEntries(block.split('\n').filter((l) => /^[A-Za-z0-9-]+: /.test(l)).map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 2)]));
      if (f.Package) pkgs.set(f.Package, f);
    }
    const want = new Set<string>();
    const visit = (n: string) => {
      if (want.has(n) || !pkgs.has(n)) return;
      want.add(n);
      for (const d of (pkgs.get(n)!.Depends ?? '').split(',').map((s) => s.trim().split(/[ (|]/)[0]!).filter(Boolean)) visit(d);
    };
    NEEDED_PACKAGES.forEach(visit);
    out.abis[abi] = [...want].sort().map((n) => { const p = pkgs.get(n)!; return { name: n, version: p.Version!, filename: p.Filename!, sha256: p.SHA256! }; });
  }
  writeFileSync(LOCK, JSON.stringify(out, null, 2) + '\n');
  console.log(`wrote ${LOCK}`);
}

/** The data.tar.* member of a .deb (an "ar" archive). */
function debData(deb: Buffer): { name: string; body: Buffer } {
  if (deb.toString('latin1', 0, 8) !== '!<arch>\n') throw new Error('not a .deb file');
  for (let o = 8; o < deb.length;) {
    const name = deb.toString('latin1', o, o + 16).trim().replace(/\/$/, '');
    const size = Number(deb.toString('latin1', o + 48, o + 58).trim());
    if (name.startsWith('data.tar')) return { name, body: deb.subarray(o + 60, o + 60 + size) };
    o += 60 + size + (size % 2);
  }
  throw new Error('no data in the .deb');
}

async function runtime(abi: string, pkgs: Pkg[], repo: string) {
  const dir = join(CACHE, abi);
  const root = join(dir, 'root');
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  for (const p of pkgs) {
    const file = join(dir, basename(p.filename).replace(/:/g, '_'));
    if (!existsSync(file) || sha256(readFileSync(file)) !== p.sha256) {
      const r = await fetch(`${repo}/${p.filename}`);
      if (!r.ok) throw new Error(`${p.name}: HTTP ${r.status}`);
      writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    }
    const deb = readFileSync(file);
    if (sha256(deb) !== p.sha256) throw new Error(`${p.name} ${p.version}: checksum does not match android/node-runtime.json; not used`);
    const data = debData(deb);
    const tarFile = join(dir, `${p.name}.${data.name}`);
    writeFileSync(tarFile, data.body);
    // relative paths from inside the folder: Git's tar on Windows reads "C:\..." as a remote host
    try { execFileSync('tar', ['-xf', basename(tarFile), '-C', 'root'], { cwd: dir, stdio: 'ignore' }); } catch { /* symbolic links cannot be made on Windows; only real files are needed */ }
  }
  const usr = join(root, 'data', 'data', 'com.termux', 'files', 'usr');
  const libs = readdirSync(join(usr, 'lib'));
  const out = join(APP, 'jniLibs', abi);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  // follow the needed libraries from node, renaming each to lib*.so
  const fileFor = (need: string) => libs.find((f) => f === need) ?? libs.filter((f) => f.startsWith(`${need}.`)).sort((a, z) => z.length - a.length)[0];
  const queue: Array<[string, string]> = [[join(usr, 'bin', 'node'), 'libposnode.so']];
  const done = new Set<string>();
  while (queue.length) {
    const [src, dst] = queue.shift()!;
    if (done.has(dst)) continue;
    done.add(dst);
    const info = readElf(src);
    const buf = Buffer.from(readFileSync(src));
    for (const need of info.needed) {
      if (SYSTEM.has(need)) continue;
      const f = fileFor(need);
      if (!f) throw new Error(`${basename(src)} needs ${need}, which is not in the Termux packages`);
      renameLib(buf, need, apkName(need));
      queue.push([join(usr, 'lib', f), apkName(need)]);
    }
    if (info.soname) renameLib(buf, info.soname, apkName(info.soname));
    writeFileSync(join(out, dst), buf);
  }
  console.log(`  ${abi}: ${[...done].join(', ')}`);
}

function assets() {
  const dest = join(APP, 'assets', 'pos');
  rmSync(dest, { recursive: true, force: true });
  const app = join(dest, 'app');
  for (const d of ['src', 'contract', 'templates']) cpSync(join(ROOT, d), join(app, d), { recursive: true, filter: (s) => !/[\\/](node_modules|test)[\\/]?/.test(s.slice(ROOT.length)) });
  cpSync(join(ANDROID, 'backend'), join(app, 'android', 'backend'), { recursive: true });
  cpSync(join(ROOT, 'package.json'), join(app, 'package.json'));
  const ui = join(ROOT, 'ui', 'dist');
  if (!existsSync(join(ui, 'index.html'))) throw new Error('Build the UI first: cd ui && npm run build');
  cpSync(ui, join(dest, 'ui'), { recursive: true });
  // a fingerprint of everything, so the app unpacks the files again only when they changed
  const h = createHash('sha256');
  const walk = (d: string) => { for (const f of readdirSync(d, { withFileTypes: true }).sort((a, z) => a.name.localeCompare(z.name))) { const p = join(d, f.name); if (f.isDirectory()) walk(p); else { h.update(p.slice(dest.length).replace(/\\/g, '/')); h.update(readFileSync(p)); } } };
  walk(dest);
  writeFileSync(join(dest, 'fingerprint.txt'), h.digest('hex').slice(0, 16));
  console.log(`  assets: backend + UI (${readFileSync(join(dest, 'fingerprint.txt'), 'utf8')})`);
}

async function main() {
  if (process.argv.includes('--lock')) return lock();
  if (!existsSync(LOCK)) throw new Error('android/node-runtime.json is missing: run with --lock first');
  const l = JSON.parse(readFileSync(LOCK, 'utf8')) as Lock;
  const only = process.argv.find((a) => a.startsWith('--abi='))?.slice(6);
  console.log('Node runtime:');
  for (const [abi, pkgs] of Object.entries(l.abis)) if (!only || only.split(',').includes(abi)) await runtime(abi, pkgs, l.repo);
  assets();
  void dirname;
}

main().catch((e: unknown) => { console.error((e as Error).message); process.exit(1); });
