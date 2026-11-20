// Runs the iOS backend bundle (ios/TiffinPOS/pos/main.cjs) the way the iPhone app does: one file, Node without a JIT
// (--jitless, as Node for iOS), settings in environment variables, the port read from the port file. Then the first
// day at the counter (flow.ts) through the gatekeeper. Run after prepare.ts, on any computer (CI runs it too):
//   node ios/scripts/smoke.ts
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { billingFlow } from './flow.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const POS = join(ROOT, 'ios', 'TiffinPOS', 'pos');
const home = mkdtempSync(join(tmpdir(), 'ios-smoke-'));
const token = randomBytes(32).toString('base64url');
const portFile = join(home, 'pos-port');
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, TZ: 'Asia/Kolkata',
  POS_DATA_DIR: join(home, 'pos-data'), POS_UI_DIR: join(POS, 'ui'), POS_APP_TOKEN: token, POS_PORT_FILE: portFile,
  POS_ADDONS_DIR: join(home, 'pos-addons'), POS_APP_VERSION: 'smoke',
};
const started = Date.now();
const child = spawn(process.execPath, ['--jitless', join(POS, 'main.cjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
child.stdout.on('data', (c: Buffer) => { log += c.toString(); });
child.stderr.on('data', (c: Buffer) => { log += c.toString(); });
const exited = new Promise<void>((r) => child.on('exit', () => r()));
const cleanup = async () => { child.kill(); await exited; rmSync(home, { recursive: true, force: true }); };
const fail = async (why: string): Promise<never> => { console.error(`iOS backend smoke test FAILED: ${why}\n--- backend output ---\n${log}`); await cleanup(); process.exit(1); };

let port = 0;
for (let i = 0; i < 600 && !port; i++) {
  if (existsSync(`${portFile}.error`)) await fail(readFileSync(`${portFile}.error`, 'utf8'));
  if (existsSync(portFile)) port = Number(readFileSync(portFile, 'utf8'));
  else await new Promise((r) => setTimeout(r, 100));
}
if (!port) await fail('no port after 60 s');
const startMs = Date.now() - started;
try {
  const what = await billingFlow(`http://127.0.0.1:${port}`, token);
  console.log(`iOS backend smoke test passed: started in ${startMs} ms without a JIT; ${what}`);
} catch (e) {
  await fail(String(e));
}
await cleanup();
