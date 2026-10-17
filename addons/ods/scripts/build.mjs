// Builds and signs the ODS add-on package into addons/dist/ods/:
//   backend.cjs  (routes; bundled with the contract)     ui.js  (screens; React comes from the POS, Leaflet is bundled)
//   manifest.json (file fingerprints + Ed25519 signature)
// Signing key: POS_ADDON_SIGNING_KEY (path), default %USERPROFILE%\.tiffinpos\addon-signing\private.pem (never in the repo).
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sha256hex, signManifest } from '../../../src/addons/manifest.ts';
import { zip } from './zip.mjs';

const here = join(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));
const out = join(here, '..', 'dist', 'packages', 'ods'); // packages/ only: the POS loads every folder in it
const keyPath = process.env.POS_ADDON_SIGNING_KEY ?? join(homedir(), '.tiffinpos', 'addon-signing', 'private.pem');
if (!existsSync(keyPath)) { console.error(`Signing key not found: ${keyPath}`); process.exit(1); }

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [join(here, 'backend', 'index.ts')], outfile: join(out, 'backend.cjs'),
  bundle: true, platform: 'node', target: 'node24', format: 'cjs', legalComments: 'none', logLevel: 'warning',
});

/** react and react/jsx-runtime come from the POS window (window.__POS__), so add-on screens share its React and session. */
const fromPos = {
  name: 'from-pos',
  setup(b) {
    const map = { react: 'React', 'react/jsx-runtime': 'jsxRuntime' };
    b.onResolve({ filter: /^react(\/jsx-runtime)?$/ }, (a) => ({ path: a.path, namespace: 'pos' }));
    b.onLoad({ filter: /.*/, namespace: 'pos' }, (a) => ({ contents: `module.exports = window.__POS__.${map[a.path]};`, loader: 'js' }));
  },
};
// The add-on's own style sheet: Tailwind utilities for the classes its screens use, with the POS's colours and fonts
// (copied from ui/src/styles.css at build time). No base reset: the POS has it. Injected by ui/index.tsx.
const theme = /@theme inline \{[\s\S]*?\n\}/.exec(readFileSync(join(here, '..', '..', 'ui', 'src', 'styles.css'), 'utf8'))?.[0];
if (!theme) { console.error('Could not read the POS theme from ui/src/styles.css'); process.exit(1); }
mkdirSync(join(here, '.build'), { recursive: true });
const cssIn = join(here, '.build', 'addon.tw.css'); // inside the add-on folder, so Tailwind finds its own node_modules
const uiDir = join(here, 'ui').replaceAll('\\', '/');
writeFileSync(cssIn, [
  '@import "tailwindcss/theme" layer(theme);',
  '@import "tailwindcss/utilities" layer(utilities);',
  `@source "${uiDir}";`,
  theme, '',
].join('\n'));
const cssOut = join(here, '.build', 'addon.css');
execFileSync(process.execPath, [join(here, 'node_modules', '@tailwindcss', 'cli', 'dist', 'index.mjs'), '-i', cssIn, '-o', cssOut, '--minify'], { cwd: here, stdio: ['ignore', 'ignore', 'inherit'] });
rmSync(cssIn);

await build({
  entryPoints: [join(here, 'ui', 'index.tsx')], outfile: join(out, 'ui.js'),
  bundle: true, platform: 'browser', target: 'es2022', format: 'iife', jsx: 'automatic', minify: true, legalComments: 'none', logLevel: 'warning',
  loader: { '.css': 'text', '.png': 'dataurl' }, plugins: [fromPos],
  define: { __ADDON_CSS__: JSON.stringify(readFileSync(cssOut, 'utf8')) },
});

const files = {};
rmSync(cssOut);
for (const f of ['backend.cjs', 'ui.js']) files[f] = sha256hex(readFileSync(join(out, f)));
const manifest = signManifest({
  id: 'ods', name: 'ODS', version: pkg.version, minPosVersion: '0.3.4',
  description: 'Online orders settings, serviceability (delivery areas, fees, hours) and the ODS.',
  backend: 'backend.cjs', ui: 'ui.js', files,
}, readFileSync(keyPath, 'utf8'));
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
const kb = (f) => `${Math.round(readFileSync(join(out, f)).length / 1024)} KB`;
console.log(`ODS ${pkg.version} built and signed: ${out} (backend ${kb('backend.cjs')}, ui ${kb('ui.js')})`);
// the same signed files as one file for the Android app (Settings > This device > Add-ons > Install from file)
const installers = join(here, '..', 'dist', 'installers');
mkdirSync(installers, { recursive: true });
const addonFile = join(installers, `TiffinPOS-ODS-${pkg.version}.tiffinaddon`);
writeFileSync(addonFile, zip(['manifest.json', 'backend.cjs', 'ui.js'].map((n) => [n, readFileSync(join(out, n))])));
console.log(`Android add-on file: ${addonFile}`);
