// End-to-end test of the iPhone/iPad app in the iOS simulator (a Mac with Xcode; CI runs it after building):
//   node ios/scripts/simulator-test.ts <path to TiffinPOS.app> <output folder>
// For an iPhone and an iPad simulator: installs the debug app, starts it with a known pass (POS_TEST_TOKEN, debug
// builds only), waits for Node for iOS to start the POS inside the app, takes a screenshot (first-run setup), then runs
// the first day at the counter (flow.ts) against the app itself, restarts the app and takes another screenshot (sign-in).
// The screenshots and the backend log land in the output folder.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { billingFlow } from './flow.ts';

const [app, out] = process.argv.slice(2);
if (!app || !out) { console.error('usage: node ios/scripts/simulator-test.ts <TiffinPOS.app> <output folder>'); process.exit(2); }
mkdirSync(out, { recursive: true });
const BUNDLE = 'com.tiffinpos.pos';
const simctl = (...a: string[]) => execFileSync('xcrun', ['simctl', ...a], { encoding: 'utf8' }).trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Runtime { identifier: string; name: string; isAvailable: boolean; platform?: string; supportedDeviceTypes?: Array<{ identifier: string; name: string; productFamily: string }> }
const runtimes = (JSON.parse(simctl('list', 'runtimes', '-j')) as { runtimes: Runtime[] }).runtimes.filter((r) => r.isAvailable && /iOS/.test(r.name));
const runtime = runtimes.at(-1);
if (!runtime) throw new Error('no iOS simulator runtime on this Mac');
const types = runtime.supportedDeviceTypes ?? [];
const pick = (family: string, prefer: RegExp) => types.filter((t) => t.productFamily === family).sort((a, b) => Number(prefer.test(b.name)) - Number(prefer.test(a.name)))[0];
const devices = [pick('iPhone', /^iPhone \d+$/), pick('iPad', /^iPad Air/)].filter((d): d is NonNullable<typeof d> => !!d);
console.log(`runtime ${runtime.name}; devices: ${devices.map((d) => d.name).join(', ')}`);

let failed = false;
for (const type of devices) {
  const tag = type.productFamily.toLowerCase();
  const udid = simctl('create', `tiffin-ci-${tag}`, type.identifier, runtime.identifier);
  try {
    simctl('boot', udid);
    simctl('bootstatus', udid, '-b');
    simctl('install', udid, app);
    const token = randomBytes(32).toString('base64url');
    const launch = () => execFileSync('xcrun', ['simctl', 'launch', udid, BUNDLE], { env: { ...process.env, SIMCTL_CHILD_POS_TEST_TOKEN: token }, encoding: 'utf8' });
    const started = Date.now();
    launch();
    const data = simctl('get_app_container', udid, BUNDLE, 'data');
    const portFile = join(data, 'tmp', 'pos-port');
    let port = 0;
    while (!port && Date.now() - started < 180_000) {
      if (existsSync(`${portFile}.error`)) throw new Error(readFileSync(`${portFile}.error`, 'utf8'));
      if (existsSync(portFile)) port = Number(readFileSync(portFile, 'utf8'));
      else await sleep(250);
    }
    if (!port) throw new Error('the POS did not start within 3 minutes');
    console.log(`${type.name}: POS started inside the app in ${Date.now() - started} ms`);
    await sleep(6000); // the window loads the screens
    simctl('io', udid, 'screenshot', join(out, `${tag}-1-first-run.png`));
    const what = await billingFlow(`http://127.0.0.1:${port}`, token);
    console.log(`${type.name}: ${what}`);
    simctl('terminate', udid, BUNDLE);
    await sleep(1000);
    launch();
    await sleep(15_000);
    simctl('io', udid, 'screenshot', join(out, `${tag}-2-sign-in.png`));
    console.log(`${type.name}: passed`);
  } catch (e) {
    failed = true;
    console.error(`${type.name}: FAILED ${e instanceof Error ? e.message : String(e)}`);
    try { simctl('io', udid, 'screenshot', join(out, `${tag}-failed.png`)); } catch { /* no screen */ }
  } finally {
    try {
      const data = simctl('get_app_container', udid, BUNDLE, 'data');
      const log = join(data, 'Library', 'Application Support', 'TiffinPOS', 'pos-backend.log');
      if (existsSync(log)) copyFileSync(log, join(out, `${tag}-pos-backend.log`));
    } catch { /* not installed */ }
    try { simctl('shutdown', udid); } catch { /* already off */ }
    simctl('delete', udid);
  }
}
if (failed) process.exit(1);
console.log('iOS simulator test passed');
