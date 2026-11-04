// Tiffin Data Manager's backend for screen work: node scripts/manager-dev.ts, then in ui/: npx vite --config vite.manager.config.ts
// POS_DATA_DIR must name the data folder to open (for example ./data after `npm run seed`). It never defaults to the
// real POS data on this computer.
import { join, resolve } from 'node:path';
import { startManager } from '../src/manager/server.ts';

const dataDir = process.env.POS_DATA_DIR;
if (!dataDir) { console.error('Set POS_DATA_DIR to the data folder to open (for example ./data after npm run seed).'); process.exit(1); }
const m = await startManager({ home: resolve(join(dataDir, '..', '.manager-dev')), dataDir: resolve(dataDir), port: Number(process.env.MANAGER_PORT ?? 4810) });
console.log(`Tiffin Data Manager backend on http://127.0.0.1:${m.port} over ${resolve(dataDir)}`);
process.on('SIGINT', () => { void m.close().finally(() => process.exit(0)); });
