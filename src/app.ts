import type { Server } from 'node:http';
import { createCtx } from './services/ctx.ts';
import type { Logger } from './services/ctx.ts';
import { createServer, listen } from './http/server.ts';
import { defaultQueue, scheduleBackups, startupChecks } from './startup.ts';
import { runBackup } from './services/backup.ts';
import { EMPTY_ADDONS, loadAddons } from './addons/host.ts';

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

export interface Backend { port: number; server: Server; shutdown: (reason: string) => Promise<void> }

/** Opens the database, runs the startup checks, starts the print queue, backups and the HTTP API. Used by `npm start` and the desktop app. */
export async function startBackend(o: BackendOptions): Promise<Backend> {
  const ctx = createCtx({ dataDir: o.dataDir, logger: o.logger });
  const queue = defaultQueue(ctx);
  try { startupChecks(ctx, queue); } catch (e) { ctx.db.close(); throw e; }
  let addons = EMPTY_ADDONS;
  try { addons = await loadAddons(ctx, { dir: o.addonsDir, posVersion: o.posVersion ?? '0.0.0-dev', trustedKeys: o.trustedAddonKeys }); }
  catch (e) { ctx.logger.error('add-ons could not be loaded; the POS runs without them', String(e)); }
  queue.start(1000);
  const stopBackups = o.scheduleBackups === false ? () => {} : scheduleBackups(ctx);
  const server = createServer(ctx, { queue, secret: o.secret, addons });
  const port = await listen(server, o.port);
  ctx.logger.info(`POS backend listening on http://127.0.0.1:${port}`, { dataDir: o.dataDir, launchSecret: Boolean(o.secret) });

  let closing: Promise<void> | null = null;
  const shutdown = (reason: string) => closing ??= (async () => {
    ctx.logger.info(`${reason}: shutting down`);
    queue.stop(); stopBackups();
    await addons.stop();
    await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
    try { await runBackup(ctx, 'close'); } catch (e) { ctx.logger.error('close backup failed', String(e)); }
    ctx.db.close();
  })();
  return { port, server, shutdown };
}
