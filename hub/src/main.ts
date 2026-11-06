// Starts the order hub. Environment:
//   HUB_PORT (default 4900), HUB_HOST (default 0.0.0.0), HUB_DATA_DIR (default ./hub-data)
//   HUB_ADMIN_KEY      required for the admin page (/admin) and /v1/admin (stores, pairing codes, devices, settings)
//   HUB_PUBLIC_URL     the hub's https address as shops reach it, used in connection links (else taken from the admin's browser)
//   HUB_DEVICE_DOMAIN  DinePOS devices from anywhere: https://<store>.<this domain> (default: the host of HUB_PUBLIC_URL)
//   HUB_DEV_OTP=1      return OTP codes in responses (development and the demo page only; never in production)
//   HUB_ROUTING_URL    optional OSRM-compatible server for real road distances (else each store's road factor);
//                      only the starting value: a routing server saved on the admin page wins
//   HUB_ONLINE_PAYMENTS=1  online payment (phase 3; needs a payment gateway)
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Hub } from './hub.ts';
import { createHubServer } from './http.ts';
import { UrbanPiper } from './urbanpiper.ts';

const dir = process.env.HUB_DATA_DIR ?? './hub-data';
mkdirSync(dir, { recursive: true });
const log = { info: (m: string, d?: unknown) => console.log(new Date().toISOString(), m, d ?? ''), warn: (m: string, d?: unknown) => console.warn(new Date().toISOString(), m, d ?? '') };
const hub = new Hub({
  dbPath: join(dir, 'hub.db'), devOtp: process.env.HUB_DEV_OTP === '1', onlinePayments: process.env.HUB_ONLINE_PAYMENTS === '1', log,
  settingDefaults: { routingUrl: process.env.HUB_ROUTING_URL ?? '' },
});
if (!process.env.HUB_ADMIN_KEY) log.warn('HUB_ADMIN_KEY is not set: store admin is disabled (use scripts/admin.ts on this machine)');
else log.info('hub admin page: /admin');
const urbanpiper = new UrbanPiper(hub, { log }); // Swiggy / Zomato (set up per store on the admin page)
const server = createHubServer(hub, { adminKey: process.env.HUB_ADMIN_KEY, publicUrl: process.env.HUB_PUBLIC_URL || undefined, deviceDomain: process.env.HUB_DEVICE_DOMAIN || undefined, urbanpiper });
const sweeper = setInterval(() => { try { hub.sweep(); } catch (e) { log.warn('sweep failed', String(e)); } void urbanpiper.pump().catch((e) => log.warn('urbanpiper outbox failed', String(e))); }, 5000);
const port = Number(process.env.HUB_PORT ?? 4900);
server.listen(port, process.env.HUB_HOST ?? '0.0.0.0', () => log.info(`order hub on http://localhost:${port} (data: ${dir})`));
const stop = () => { clearInterval(sweeper); server.close(); server.closeAllConnections(); hub.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
