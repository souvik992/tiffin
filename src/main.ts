import { startBackend } from './app.ts';

const backend = await startBackend({ dataDir: process.env.POS_DATA_DIR ?? './data', port: Number(process.env.POS_PORT ?? 4800), addonsDir: process.env.POS_ADDONS_DIR ?? null, posVersion: process.env.POS_APP_VERSION, licence: { enforced: process.env.POS_LICENCE === 'on', cloudUrl: process.env.POS_CLOUD_URL || undefined } });

async function shutdown(sig: string) {
  await backend.shutdown(`${sig} received`);
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
