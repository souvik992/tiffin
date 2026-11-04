// Builds Tiffin Data Manager into desktop/dist-manager (a separate app from the POS, same Electron and backend code):
//   main.cjs     its Electron main process   (src/manager/main.ts)
//   backend.cjs  ../src/manager/server.ts with the POS backend (zero runtime dependencies)
//   ui/          its screens                 (vite build of ../ui with vite.manager.config.ts)
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const here = join(import.meta.dirname, '..');
const dist = join(here, 'dist-manager');
const ui = join(here, '..', 'ui');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const common = { bundle: true, platform: 'node', target: 'node24', format: 'cjs', sourcemap: 'linked', legalComments: 'none', logLevel: 'warning' };
await build({ ...common, entryPoints: [join(here, 'src', 'manager', 'main.ts')], outfile: join(dist, 'main.cjs'), external: ['electron'] });
await build({ ...common, entryPoints: [join(here, 'src', 'manager', 'backend.ts')], outfile: join(dist, 'backend.cjs'), external: ['electron'] });

if (!existsSync(join(ui, 'node_modules'))) { console.error('Install the UI first: cd ui && npm install'); process.exit(1); }
execFileSync(process.execPath, [join(ui, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.manager.config.ts', '--logLevel', 'warn'], { cwd: ui, stdio: 'inherit' });
cpSync(join(ui, 'dist-manager'), join(dist, 'ui'), { recursive: true });
cpSync(join(here, 'build', 'manager-icon.png'), join(dist, 'icon.png'));
console.log('desktop/dist-manager ready');
