// Store admin on the hub machine (works without the admin key: it opens the hub database directly).
// Usage (from hub/):
//   npm run admin -- create-store <slug> "<Store name>"   -> prints a pairing code for the POS
//   npm run admin -- pairing-code <slug>                  -> a new pairing code (30 minutes, one use)
//   npm run admin -- list
//   npm run admin -- revoke-device <deviceId>
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { Hub, HubError } from '../src/hub.ts';
import { many } from '../src/db.ts';

const dir = process.env.HUB_DATA_DIR ?? './hub-data';
mkdirSync(dir, { recursive: true });
const hub = new Hub({ dbPath: join(dir, 'hub.db') });
const [cmd, a, b] = process.argv.slice(2);
try {
  if (cmd === 'create-store' && a && b) {
    const s = hub.createStore(a, b);
    console.log(`Store "${s.name}" created (${s.slug}).\nPairing code for the POS: ${s.pairingCode}  (valid 30 minutes, one use)`);
  } else if (cmd === 'pairing-code' && a) {
    console.log(`Pairing code for ${a}: ${hub.pairingCodeForSlug(a)}  (valid 30 minutes, one use)`);
  } else if (cmd === 'list') {
    for (const s of many<{ id: string; slug: string; name: string; menu_version: number; accepting: number }>(hub.db, 'SELECT id, slug, name, menu_version, accepting FROM store ORDER BY slug')) {
      console.log(`${s.slug}  ${s.name}  menu v${s.menu_version}  ${s.accepting ? 'accepting' : 'not accepting'}`);
      for (const d of many<{ id: string; name: string; revoked_at: number | null }>(hub.db, 'SELECT id, name, revoked_at FROM device WHERE store_id = ?', s.id)) console.log(`   device ${d.id}  ${d.name}${d.revoked_at ? '  (revoked)' : ''}`);
    }
  } else if (cmd === 'revoke-device' && a) {
    hub.revokeDevice(a); console.log(`Device ${a} can no longer connect.`);
  } else {
    console.log('Commands: create-store <slug> "<name>" | pairing-code <slug> | list | revoke-device <deviceId>');
    process.exitCode = 2;
  }
} catch (e) {
  console.error(e instanceof HubError ? e.message : e);
  process.exitCode = 1;
} finally { hub.close(); }
