// Started by the Android app (android/app/.../PosBackend.java) as a child process: the same POS backend as on Windows,
// plus the gatekeeper (front.ts) that the app's window talks to. Tells the app the port by writing POS_PORT_FILE.
import { randomBytes } from 'node:crypto';
import { renameSync, writeFileSync } from 'node:fs';
import { startBackend } from '../../src/app.ts';
import { startFront } from './front.ts';

async function main() {
  const dataDir = process.env.POS_DATA_DIR, uiDir = process.env.POS_UI_DIR, token = process.env.POS_APP_TOKEN, portFile = process.env.POS_PORT_FILE;
  if (!dataDir || !uiDir || !token || !portFile) throw new Error('POS_DATA_DIR, POS_UI_DIR, POS_APP_TOKEN and POS_PORT_FILE must be set by the Android app.');
  delete process.env.POS_APP_TOKEN;
  const secret = randomBytes(32).toString('base64url'); // never leaves this process
  const backend = await startBackend({ dataDir, port: 0, secret, addonsDir: process.env.POS_ADDONS_DIR || null, posVersion: process.env.POS_APP_VERSION });
  const front = await startFront({ uiDir, backendPort: backend.port, secret, token });
  writeFileSync(`${portFile}.tmp`, String(front.port));
  renameSync(`${portFile}.tmp`, portFile); // the app reads a complete file or none
  console.log(`READY ${front.port}`);
  let stopping = false;
  const stop = (why: string) => {
    if (stopping) return; stopping = true;
    void front.close().then(() => backend.shutdown(why)).finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => stop('android app closing'));
  process.on('SIGINT', () => stop('android app closing'));
  process.stdin.on('end', () => stop('android app gone')); // the app keeps stdin open; if the app dies, this ends
  process.stdin.resume();
}

main().catch((e: unknown) => {
  const err = e as { code?: string; message?: string };
  console.error(`FAILED ${err.code ?? 'STARTUP_FAILED'} ${err.message ?? String(e)}`);
  setTimeout(() => process.exit(1), 200);
});
