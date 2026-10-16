// Starts the order hub. Environment:
//   HUB_PORT (default 4900), HUB_HOST (default 0.0.0.0), HUB_DATA_DIR (default ./hub-data)
//   HUB_ADMIN_KEY      required for /v1/admin (create stores, pairing codes)
//   HUB_DEV_OTP=1      return OTP codes in responses (development and the demo page only; never in production)
//   HUB_ROUTING_URL    optional OSRM-compatible server for real road distances (else each store's road factor)
//   HUB_ONLINE_PAYMENTS=1  online payment (phase 3; needs a payment gateway)
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Hub } from './hub.ts';
import { createHubServer } from './http.ts';
import { osrmRoadKm } from './routing.ts';

const dir = process.env.HUB_DATA_DIR ?? './hub-data';
mkdirSync(dir, { recursive: true });
const log = { info: (m: string, d?: unknown) => console.log(new Date().toISOString(), m, d ?? ''), warn: (m: string, d?: unknown) => console.warn(new Date().toISOString(), m, d ?? '') };
const hub = new Hub({
  dbPath: join(dir, 'hub.db'), devOtp: process.env.HUB_DEV_OTP === '1', onlinePayments: process.env.HUB_ONLINE_PAYMENTS === '1', log,
  roadKm: process.env.HUB_ROUTING_URL ? osrmRoadKm(process.env.HUB_ROUTING_URL) : undefined,
});
if (!process.env.HUB_ADMIN_KEY) log.warn('HUB_ADMIN_KEY is not set: store admin is disabled (use scripts/admin.ts on this machine)');
const server = createHubServer(hub, { adminKey: process.env.HUB_ADMIN_KEY });
const sweeper = setInterval(() => { try { hub.sweep(); } catch (e) { log.warn('sweep failed', String(e)); } }, 5000);
const port = Number(process.env.HUB_PORT ?? 4900);
server.listen(port, process.env.HUB_HOST ?? '0.0.0.0', () => log.info(`order hub on http://localhost:${port} (data: ${dir})`));
const stop = () => { clearInterval(sweeper); server.close(); server.closeAllConnections(); hub.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
