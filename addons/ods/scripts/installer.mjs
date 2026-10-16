// Builds the ODS installer: addons/dist/installers/TiffinPOS-ODS-Setup-<version>.exe
// Run `npm run build` first (or `npm run installer`, which does both). Uses makensis from electron-builder's cache
// (it is downloaded when the POS installer is built in desktop/).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const here = join(import.meta.dirname, '..');
const version = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).version;
const src = join(here, '..', 'dist', 'packages', 'ods');
const outDir = join(here, '..', 'dist', 'installers');
const icon = join(here, '..', '..', 'desktop', 'release', '.icon-ico', 'icon.ico');
if (!existsSync(join(src, 'manifest.json'))) { console.error('Build the add-on first: npm run build'); process.exit(1); }
if (!existsSync(icon)) { console.error('Build the POS installer once first (desktop: npm run dist) - it makes the icon and downloads NSIS.'); process.exit(1); }

const cache = join(process.env.LOCALAPPDATA ?? '', 'electron-builder', 'Cache');
const find = (dir, depth = 0) => {
  if (depth > 4 || !existsSync(dir)) return null;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase() === 'makensis.exe') return p;
    if (e.isDirectory()) { const r = find(p, depth + 1); if (r) return r; }
  }
  return null;
};
const makensis = process.env.MAKENSIS ?? find(cache);
if (!makensis) { console.error('makensis.exe not found. Build the POS installer once (desktop: npm run dist), or set MAKENSIS.'); process.exit(1); }

mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `TiffinPOS-ODS-Setup-${version}.exe`);
execFileSync(makensis, ['-V2', `-DVERSION=${version}`, `-DSRC=${src}`, `-DOUTFILE=${outFile}`, `-DICON=${icon}`, join(here, 'installer', 'ods.nsi')], { stdio: 'inherit' });
console.log(`Installer: ${outFile}`);
