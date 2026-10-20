import type { Server } from 'node:http';
import { createCtx } from './services/ctx.ts';
import type { Logger } from './services/ctx.ts';
import { consoleLogger } from './services/ctx.ts';
import { createServer, listen } from './http/server.ts';
import { defaultQueue, scheduleBackups, startupChecks } from './startup.ts';
import { runBackup } from './services/backup.ts';
import { scheduleCloudBackups } from './services/cloudBackup.ts';
import { applyPendingRestore } from './services/restore.ts';
import { EMPTY_ADDONS, loadAddons } from './addons/host.ts';
import { resumeCharges } from './services/terminals/service.ts';

export interface BackendOptions {
  dataDir: string;
  /** 0 picks a free port (the desktop app does this). */
  port: number;
  /** When set, every request must carry it in `X-POS-Secret` (the desktop app's window adds it; nothing else knows it). */
  secret?: string;
  logger?: Logger;
  scheduleBackups?: boolean;
  /** Folder with signed add-ons (one folder each). Desktop app: %LOCALAPPDATA%\TiffinPOS\addons. */
  addonsDir?: string | null;
  /** This POS version, for add-on compatibility. "-dev" versions accept any add-on version. */
  posVersion?: string;
  trustedAddonKeys?: readonly string[];
}

export interface Backend { port: number; readonly server: Server; shutdown: (reason: string) => Promise<void> }

/**
 * Opens the database, runs the startup checks, starts the print queue, backups and the HTTP API. Used by `npm start`,
 * the desktop app and the Android app. Restoring a backup from the screen restarts all of it in place, on the same
 * port, so the apps around it (the desktop window, the Android gatekeeper) need not know: the staged restore is applied
 * before the database is opened again (services/restore.ts).
 */
export async function startBackend(o: BackendOptions): Promise<Backend> {
  const log = o.logger ?? consoleLogger;
  let restarting: Promise<void> | null = null;
  const restart = () => {
    restarting ??= (async () => {
      try {
        await cur.shutdown('restoring a backup');
        cur = await boot(o, port, restart);
      } catch (e) {
        // Nothing listens any more: exit, so the desktop or Android app starts the POS again (it opens normally).
        log.error('restart after restore failed', String((e as Error).message ?? e));
        process.exit(1);
      }
    })().finally(() => { restarting = null; });
  };
  let cur = await boot(o, o.port, restart);
  const port = cur.port;
  return {
    port,
    get server() { return cur.server; },
    shutdown: async (reason) => { await restarting; await cur.shutdown(reason); },
  };
}

async function boot(o: BackendOptions, wantPort: number, restart: () => void): Promise<Backend> {
  applyPendingRestore(o.dataDir, o.logger ?? consoleLogger);
  const ctx = createCtx({ dataDir: o.dataDir, logger: o.logger });
  const queue = defaultQueue(ctx);
  try { startupChecks(ctx, queue); } catch (e) { ctx.db.close(); throw e; }
  let addons = EMPTY_ADDONS;
  try { addons = await loadAddons(ctx, { dir: o.addonsDir, posVersion: o.posVersion ?? '0.0.0-dev', trustedKeys: o.trustedAddonKeys }); }
  catch (e) { ctx.logger.error('add-ons could not be loaded; the POS runs without them', String(e)); }
  queue.start(1000);
  resumeCharges(ctx); // payment machines that were waiting when the POS stopped
  const stopBackups = o.scheduleBackups === false ? () => {} : scheduleBackups(ctx);
  const stopCloud = o.scheduleBackups === false ? () => {} : scheduleCloudBackups(ctx);
  const server = createServer(ctx, { queue, secret: o.secret, addons, restart });
  const port = await listen(server, wantPort);
  ctx.logger.info(`POS backend listening on http://127.0.0.1:${port}`, { dataDir: o.dataDir, launchSecret: Boolean(o.secret) });

  let closing: Promise<void> | null = null;
  const shutdown = (reason: string) => closing ??= (async () => {
    ctx.logger.info(`${reason}: shutting down`);
    queue.stop(); stopBackups(); stopCloud();
    await addons.stop();
    await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
    try { await runBackup(ctx, 'close'); } catch (e) { ctx.logger.error('close backup failed', String(e)); }
    ctx.db.close();
  })();
  return { port, server, shutdown };
}
