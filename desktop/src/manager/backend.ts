// Tiffin Data Manager's backend, in Electron's utility process: src/manager/server.ts on a free loopback port,
// guarded by a secret only the main process knows. It looks for a running Tiffin POS every 3 seconds.
import { startManager, windowsProcessRunning } from '../../../src/manager/server.ts';

interface ParentPort { postMessage(m: unknown): void; on(ev: 'message', fn: (e: { data: unknown }) => void): void }
const parent = (process as unknown as { parentPort: ParentPort }).parentPort;

async function main() {
  const home = process.env.MANAGER_HOME, dataDir = process.env.POS_DATA_DIR, secret = process.env.MANAGER_LAUNCH_SECRET;
  if (!home || !dataDir || !secret) throw new Error('MANAGER_HOME, POS_DATA_DIR and MANAGER_LAUNCH_SECRET must be set by the desktop app.');
  delete process.env.MANAGER_LAUNCH_SECRET;
  const posExe = process.env.MANAGER_POS_EXE ?? 'TiffinPOS.exe'; // tests name a program that is not running
  const m = await startManager({ home, dataDir, secret, watchMs: 3000, isPosRunning: () => windowsProcessRunning(posExe) });
  parent.on('message', (e) => {
    if ((e.data as { type?: string })?.type === 'shutdown') void m.close().finally(() => process.exit(0));
  });
  parent.postMessage({ type: 'ready', port: m.port });
}

main().catch((e: unknown) => {
  parent.postMessage({ type: 'error', message: (e as Error).message ?? String(e) });
  setTimeout(() => process.exit(1), 200);
});
