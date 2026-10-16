// Signed auto-update (electron-updater). Only in an installed build that was built with an update URL.
// The update downloads in the background and installs when the POS is closed: never a restart in the middle of a bill.
// On Windows electron-updater checks the new installer's code signature against the publisher of the installed app.
import { app, Notification } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import electronUpdater from 'electron-updater';

export function startUpdates(log: (s: string) => void) {
  if (!app.isPackaged) return;
  if (!existsSync(join(process.resourcesPath, 'app-update.yml'))) { log('updates: no update URL in this build'); return; }
  const { autoUpdater } = electronUpdater;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = { info: (m: unknown) => log(`updates: ${String(m)}`), warn: (m: unknown) => log(`updates: ${String(m)}`), error: (m: unknown) => log(`updates error: ${String(m)}`), debug: () => {} };
  autoUpdater.on('update-downloaded', (i) => {
    log(`updates: ${i.version} ready`);
    if (Notification.isSupported()) new Notification({ title: 'POS update ready', body: `Version ${i.version} installs the next time you close the POS.` }).show();
  });
  const check = () => autoUpdater.checkForUpdates().catch((e: unknown) => log(`updates: check failed (offline is fine): ${String(e)}`));
  setTimeout(check, 60_000).unref(); // after start-up, not during it
  setInterval(check, 6 * 3_600_000).unref();
}
