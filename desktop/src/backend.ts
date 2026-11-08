// Runs inside Electron's utility process (a separate OS process): the same backend as `npm start`,
// on a free loopback port, guarded by a secret that only the main process knows. Talks to the main process by messages.
import { startBackend } from '../../src/app.ts';

interface ParentPort { postMessage(m: unknown): void; on(ev: 'message', fn: (e: { data: unknown }) => void): void }
const parent = (process as unknown as { parentPort: ParentPort }).parentPort;

async function main() {
  const dataDir = process.env.POS_DATA_DIR, secret = process.env.POS_LAUNCH_SECRET;
  if (!dataDir || !secret) throw new Error('POS_DATA_DIR and POS_LAUNCH_SECRET must be set by the desktop app.');
  delete process.env.POS_LAUNCH_SECRET; // not inherited by PowerShell print helpers
  const backend = await startBackend({ dataDir, port: 0, secret, addonsDir: process.env.POS_ADDONS_DIR ?? null, posVersion: process.env.POS_APP_VERSION,
    // P8-10: the installed app checks its licence (main.ts sets POS_LICENCE=on when packaged)
    licence: { enforced: process.env.POS_LICENCE === 'on', cloudUrl: process.env.POS_CLOUD_URL || undefined } });
  parent.on('message', (e) => {
    if ((e.data as { type?: string })?.type === 'shutdown') void backend.shutdown('desktop app closing').finally(() => process.exit(0));
  });
  parent.postMessage({ type: 'ready', port: backend.port });
}

main().catch((e: unknown) => {
  const err = e as { code?: string; message?: string };
  parent.postMessage({ type: 'error', code: err.code ?? 'STARTUP_FAILED', message: err.message ?? String(e) });
  setTimeout(() => process.exit(1), 200);
});
