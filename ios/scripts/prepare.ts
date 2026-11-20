// Prepares the iOS project for a build (run from the repo root after `cd ui && npm run build`: `node ios/scripts/prepare.ts`).
//  1. Node 24 for iOS (NodeMobile.xcframework, pinned with SHA-256 in ios/node-runtime.json) into ios/Frameworks/.
//  2. The POS backend (ios/backend/main.ts with src/, contract/, android/backend/front.ts) bundled into one plain
//     JavaScript file: Node for iOS has no JIT, so the phone should not strip TypeScript at every start.
//  3. The built screens (ui/dist) next to it, in ios/TiffinPOS/pos/ (the app copies the folder as is).
//  4. ios/Version.xcconfig: the version of desktop/package.json, so all apps of one commit carry the same number.
// `--bundle-only` skips the download (for checking the bundle on Windows or Linux).
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = join(import.meta.dirname, '..', '..');
const IOS = join(ROOT, 'ios');
const CACHE = join(IOS, '.cache');
const OUT = join(IOS, 'TiffinPOS', 'pos');
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

interface Runtime { version: string; url: string; sha256: string }

async function runtime() {
  const rt = JSON.parse(readFileSync(join(IOS, 'node-runtime.json'), 'utf8')) as Runtime;
  const target = join(IOS, 'Frameworks', 'NodeMobile.xcframework');
  const stamp = join(IOS, 'Frameworks', 'node-runtime.sha256');
  if (existsSync(target) && existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === rt.sha256) { console.log(`Node for iOS ${rt.version}: ready`); return; }
  mkdirSync(CACHE, { recursive: true });
  const zip = join(CACHE, `nodejs-mobile-ios-${rt.version}.zip`);
  if (!existsSync(zip) || sha256(readFileSync(zip)) !== rt.sha256) {
    console.log(`downloading Node for iOS ${rt.version}…`);
    const r = await fetch(rt.url);
    if (!r.ok) throw new Error(`Node for iOS: HTTP ${r.status}`);
    writeFileSync(zip, Buffer.from(await r.arrayBuffer()));
  }
  if (sha256(readFileSync(zip)) !== rt.sha256) throw new Error('Node for iOS: checksum does not match ios/node-runtime.json; not used');
  const unpack = join(CACHE, 'unpacked');
  rmSync(unpack, { recursive: true, force: true });
  mkdirSync(unpack, { recursive: true });
  // relative paths from inside the folder: Git's tar on Windows reads "C:\..." as a remote host
  try { execFileSync('unzip', ['-q', '-o', join('..', `nodejs-mobile-ios-${rt.version}.zip`)], { cwd: unpack, stdio: 'inherit' }); } catch { execFileSync('tar', ['-xf', join('..', `nodejs-mobile-ios-${rt.version}.zip`)], { cwd: unpack, stdio: 'inherit' }); }
  if (!existsSync(join(unpack, 'NodeMobile.xcframework'))) throw new Error('Node for iOS: no NodeMobile.xcframework in the download');
  rmSync(target, { recursive: true, force: true });
  mkdirSync(join(IOS, 'Frameworks'), { recursive: true });
  cpSync(join(unpack, 'NodeMobile.xcframework'), target, { recursive: true, verbatimSymlinks: true });
  writeFileSync(stamp, rt.sha256 + '\n');
  rmSync(unpack, { recursive: true, force: true });
  console.log(`Node for iOS ${rt.version}: ready`);
}

async function bundle() {
  // esbuild comes with the UI's (vite) or the desktop app's packages; the backend itself has no dependencies
  const from = [join(ROOT, 'ui', 'package.json'), join(ROOT, 'desktop', 'package.json')];
  type Esbuild = { build(o: Record<string, unknown>): Promise<unknown> };
  const load = (p: string): Esbuild | null => { try { return createRequire(p)('esbuild') as Esbuild; } catch { return null; } };
  const esbuild = from.map(load).find((e) => e !== null);
  if (!esbuild) throw new Error('esbuild not found: run npm install in ui/ first');
  if (!existsSync(join(ROOT, 'ui', 'dist', 'index.html'))) throw new Error('Build the screens first: cd ui && npm run build');
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  await esbuild.build({
    entryPoints: [join(IOS, 'backend', 'main.ts')], outfile: join(OUT, 'main.cjs'),
    bundle: true, platform: 'node', target: 'node24', format: 'cjs', legalComments: 'none', logLevel: 'warning',
  });
  cpSync(join(ROOT, 'ui', 'dist'), join(OUT, 'ui'), { recursive: true });
  const version = (JSON.parse(readFileSync(join(ROOT, 'desktop', 'package.json'), 'utf8')) as { version: string }).version;
  const [a, b, c] = version.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const build = a! * 10000 + b! * 100 + c!;
  writeFileSync(join(IOS, 'Version.xcconfig'), `// written by ios/scripts/prepare.ts from desktop/package.json\nMARKETING_VERSION = ${version}\nCURRENT_PROJECT_VERSION = ${build}\n`);
  writeFileSync(join(OUT, 'fingerprint.txt'), sha256(readFileSync(join(OUT, 'main.cjs'))) + '\n');
  console.log(`backend bundle and screens: ready (version ${version}, build ${build})`);
}

await bundle();
if (!process.argv.includes('--bundle-only')) await runtime();
