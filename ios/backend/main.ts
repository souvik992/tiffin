// Started by the iPhone/iPad app (ios/TiffinPOS/PosBackend.swift) on its own thread, inside the app (iOS lets an app run
// no other programs, so Node for iOS is a library there): the same POS backend as on Windows and Android, plus the
// gatekeeper (android/backend/front.ts) that the app's window talks to. It is bundled into one plain JavaScript file
// (ios/scripts/prepare.ts): Node for iOS runs without a JIT, so stripping TypeScript on the phone would be slow.
// Tells the app the port by writing POS_PORT_FILE, or why it could not start in POS_PORT_FILE.error.
import { randomBytes } from 'node:crypto';
import { renameSync, writeFileSync } from 'node:fs';
import { startBackend } from '../../src/app.ts';
import { startFront } from '../../android/backend/front.ts';
import { iosAppRoutes } from './appRoutes.ts';

async function main() {
  const dataDir = process.env.POS_DATA_DIR, uiDir = process.env.POS_UI_DIR, token = process.env.POS_APP_TOKEN, portFile = process.env.POS_PORT_FILE, addonsDir = process.env.POS_ADDONS_DIR;
  if (!dataDir || !uiDir || !token || !portFile || !addonsDir) throw new Error('POS_DATA_DIR, POS_UI_DIR, POS_APP_TOKEN, POS_PORT_FILE and POS_ADDONS_DIR must be set by the iOS app.');
  delete process.env.POS_APP_TOKEN;
  const secret = randomBytes(32).toString('base64url'); // never leaves this process
  const backend = await startBackend({ dataDir, port: 0, secret, addonsDir, posVersion: process.env.POS_APP_VERSION });
  const front = await startFront({ uiDir, backendPort: backend.port, secret, token, app: iosAppRoutes({ addonsDir, backendPort: backend.port, secret, log: (l) => console.log(l), restart: (why) => backend.restart(why) }) });
  writeFileSync(`${portFile}.tmp`, String(front.port));
  renameSync(`${portFile}.tmp`, portFile); // the app reads a complete file or none
  console.log(`READY ${front.port}`);
  // No shutdown hook: iOS freezes the app in the background and ends it without notice. Every bill is committed to
  // SQLite (WAL) before the screen shows it, so nothing is lost; the app keeps a short background task for prints.
}

main().catch((e: unknown) => {
  const err = e as { code?: string; message?: string };
  const line = `FAILED ${err.code ?? 'STARTUP_FAILED'} ${err.message ?? String(e)}`;
  console.error(line);
  try { if (process.env.POS_PORT_FILE) writeFileSync(`${process.env.POS_PORT_FILE}.error`, line); } catch { /* the app then times out */ }
});
