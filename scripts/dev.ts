// Starts the backend and the UI dev server together (development only). Ctrl+C stops both.
// Usage: `npm run dev` in the repo root, or `npm start` in ui/. Env: POS_PORT (backend, default 4800),
// UI_PORT (UI, default 5173), POS_DATA_DIR (default ./data in the repo root).
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';

const root = join(import.meta.dirname, '..');
const vite = join(root, 'ui', 'node_modules', 'vite', 'bin', 'vite.js');
const backendPort = Number(process.env.POS_PORT ?? 4800);
const uiPort = Number(process.env.UI_PORT ?? 5173);

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer().once('error', () => resolve(false)).once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

if (!existsSync(vite)) {
  console.error('The UI is not installed yet. Run this once, then try again:\n  cd ui\n  npm install');
  process.exit(1);
}
for (const [what, port] of [['backend', backendPort], ['UI', uiPort]] as const) {
  if (!(await portFree(port))) {
    console.error(`Port ${port} is already in use, so the ${what} cannot start. Close the other window that is running it (Ctrl+C), then try again.`);
    process.exit(1);
  }
}

// Add-ons built with `npm run build` in addons/<name> are loaded from addons/dist/packages (any version: dev POS).
const env = { ...process.env, POS_PORT: String(backendPort), POS_DATA_DIR: process.env.POS_DATA_DIR ?? join(root, 'data'), POS_ADDONS_DIR: process.env.POS_ADDONS_DIR ?? join(root, 'addons', 'dist', 'packages') };
const children: ChildProcess[] = [];
let stopping = false;
function stopAll(code: number) {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill();
  setTimeout(() => process.exit(code), 500).unref();
}
function run(name: string, args: string[], cwd: string) {
  const c = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = (chunk: Buffer) => chunk.toString('utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => `[${name}] ${l}`).join('\n');
  c.stdout!.on('data', (d: Buffer) => console.log(tag(d)));
  c.stderr!.on('data', (d: Buffer) => console.error(tag(d)));
  c.on('exit', (code) => { if (!stopping) { console.error(`[${name}] stopped (exit ${code}). Stopping the other one too.`); stopAll(code ?? 1); } });
  children.push(c);
}

run('backend', [join(root, 'src', 'main.ts')], root);
run('ui', [vite, '--port', String(uiPort), '--strictPort'], join(root, 'ui'));
console.log(`Starting... open http://127.0.0.1:${uiPort} when the UI says ready. Press Ctrl+C to stop both.`);
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
