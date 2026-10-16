// Runs a local hub for trying online orders on this PC (development only: OTP codes are shown on screen).
// Creates the store "demo" the first time and prints a pairing code for the POS and the demo ordering page address.
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { Hub } from '../src/hub.ts';
import { createHubServer } from '../src/http.ts';
import { one } from '../src/db.ts';

const dir = process.env.HUB_DATA_DIR ?? join(import.meta.dirname, '..', 'hub-data');
mkdirSync(dir, { recursive: true });
const hub = new Hub({ dbPath: join(dir, 'hub.db'), devOtp: true, log: { info: (m, d) => console.log(m, d ?? ''), warn: (m, d) => console.warn(m, d ?? '') } });
const port = Number(process.env.HUB_PORT ?? 4900);
const server = createHubServer(hub, { adminKey: process.env.HUB_ADMIN_KEY });
setInterval(() => hub.sweep(), 5000).unref();
server.listen(port, '0.0.0.0', () => {
  const exists = one(hub.db, "SELECT 1 FROM store WHERE slug = 'demo'");
  const code = exists ? hub.pairingCodeForSlug('demo') : hub.createStore('demo', 'Demo store').pairingCode;
  const lan = Object.values(networkInterfaces()).flat().find((n) => n && n.family === 'IPv4' && !n.internal)?.address;
  console.log(`\nOrder hub (development) running.\n`);
  console.log(`  In the POS: Settings > Online orders > Order hub`);
  console.log(`     Hub address: http://localhost:${port}`);
  console.log(`     Pairing code: ${code}   (30 minutes, one use)\n`);
  console.log(`  Demo ordering page: http://localhost:${port}/order/demo${lan ? `\n  From a phone on the same Wi-Fi: http://${lan}:${port}/order/demo` : ''}\n`);
  console.log('  OTP codes are shown on the ordering page (development only). Ctrl+C stops the hub.\n');
});
