// Restore the POS from a backup (database + menu photos), then replay the bill journal.
//
//   npm run restore                 lists the backups, newest first
//   npm run restore -- <file>       restores that backup (a name from the list, or a full path)
//
// Stop the POS first. The current database is moved to data/pre-restore-<time>/ (never deleted), the backup and its
// photos are restored, and bills made after the backup are replayed from the journal, so no bill is lost.
// Env: POS_DATA_DIR (default ./data in the repo root), POS_PORT (default 4800, used to check the POS is stopped).
import { existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import net from 'node:net';
import { listBackups } from '../src/services/backup.ts';
import type { Logger } from '../src/services/ctx.ts';
import { performRestore } from '../src/services/restore.ts';
import { AppError } from '../src/store/db.ts';

const root = join(import.meta.dirname, '..');
const dataDir = process.env.POS_DATA_DIR ?? join(root, 'data');
const backupDir = join(dataDir, 'backups');
const port = Number(process.env.POS_PORT ?? 4800);
const quiet: Logger = { info() {}, warn() {}, error() {} };

function fail(msg: string): never { console.error(msg); process.exit(1); }
const kb = (n: number) => `${Math.max(1, Math.round(n / 1024)).toLocaleString('en-IN')} KB`;

function portInUse(p: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer().once('error', () => resolve(true)).once('listening', () => s.close(() => resolve(false)));
    s.listen(p, '127.0.0.1');
  });
}

const arg = process.argv[2];
if (!arg) {
  if (!existsSync(backupDir)) fail(`No backups folder at ${backupDir}.`);
  const files = listBackups(backupDir);
  if (!files.length) fail('There are no backups yet.');
  console.log(`Backups in ${backupDir} (newest first):\n`);
  for (const f of files) console.log(`  ${f.file.padEnd(42)} ${kb(f.bytes)}`);
  const photos = existsSync(join(backupDir, 'images')) ? readdirSync(join(backupDir, 'images')).length : 0;
  console.log(`\n  ${photos} menu photo(s) stored with these backups.`);
  console.log('\nTo restore one, stop the POS and run:\n  npm run restore -- <backup file name>');
  process.exit(0);
}

const file = isAbsolute(arg) ? arg : join(backupDir, arg);
if (!existsSync(file)) fail(`Backup not found: ${file}\nRun "npm run restore" to see the list.`);
if (await portInUse(port)) fail(`The POS is still running (port ${port} is in use). Stop it first (Ctrl+C in its window), then run this again.`);

// The same steps as Settings > Backups > Restore (src/services/restore.ts): check the backup, keep the current
// database aside, restore database and photos, replay the journal; on any failure the previous database is put back.
try {
  const r = performRestore(dataDir, file, quiet);
  console.log(`Restored ${arg} (schema v${r.version}, ${kb(statSync(file).size)}).`);
  if (r.aside) console.log(`The previous database was kept in ${r.aside}`);
  console.log(`Menu photos: ${r.images.restored} restored, ${r.images.alreadyPresent} already in place${r.images.missing.length ? `, ${r.images.missing.length} MISSING (upload them again on the Menu screen)` : ''}.`);
  if (r.journal.keptAside) console.log('This data folder belonged to another shop or device: its journal was kept aside with the previous database, not replayed.');
  else console.log(`Journal: ${r.journal.replayed} later change(s) replayed, ${r.journal.skipped} already in the backup.`);
  if (r.journal.errors.length) console.log(`WARNING: ${r.journal.errors.length} journal entr${r.journal.errors.length === 1 ? 'y' : 'ies'} could not be replayed. Keep this window's text for support:\n${r.journal.errors.slice(0, 10).map((e) => `  ${e.type} ${e.id}: ${e.message}`).join('\n')}`);
  if (!r.stockOk) console.log('WARNING: stock balances differ from the stock ledger for some items.');
  console.log('\nDone. Start the POS again with: npm start');
} catch (e) {
  fail(`Restore failed: ${e instanceof AppError ? e.message : String((e as Error).message ?? e)}\nThe previous database was put back.`);
}
