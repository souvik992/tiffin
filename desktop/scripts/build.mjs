// Builds everything the desktop app runs into desktop/dist:
//   main.cjs     Electron main process      (esbuild bundle of src/main.ts)
//   backend.cjs  the POS backend            (esbuild bundle of src/backend.ts + ../src, zero runtime dependencies)
//   ui/          the React UI               (vite build of ../ui)
//   icon.png     window icon
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const here = join(import.meta.dirname, '..');
const dist = join(here, 'dist');
const ui = join(here, '..', 'ui');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const common = { bundle: true, platform: 'node', target: 'node24', format: 'cjs', sourcemap: 'linked', legalComments: 'none', logLevel: 'warning' };
await build({ ...common, entryPoints: [join(here, 'src', 'main.ts')], outfile: join(dist, 'main.cjs'), external: ['electron', 'electron-updater'] });
await build({ ...common, entryPoints: [join(here, 'src', 'backend.ts')], outfile: join(dist, 'backend.cjs'), external: ['electron'] });

if (!existsSync(join(ui, 'node_modules'))) { console.error('Install the UI first: cd ui && npm install'); process.exit(1); }
execFileSync(process.execPath, [join(ui, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--logLevel', 'warn'], { cwd: ui, stdio: 'inherit' });
cpSync(join(ui, 'dist'), join(dist, 'ui'), { recursive: true });
cpSync(join(here, 'build', 'icon.png'), join(dist, 'icon.png'));
console.log('desktop/dist ready');
