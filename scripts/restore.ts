// Restore the POS from a backup (database + menu photos), then replay the bill journal.
//
//   npm run restore                 lists the backups, newest first
//   npm run restore -- <file>       restores that backup (a name from the list, or a full path)
//
// Stop the POS first. The current database is moved to data/pre-restore-<time>/ (never deleted), the backup and its
// photos are restored, and bills made after the backup are replayed from the journal, so no bill is lost.
// Env: POS_DATA_DIR (default ./data in the repo root), POS_PORT (default 4800, used to check the POS is stopped).
import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import net from 'node:net';
import { listBackups, restoreBackup, verifyBackup } from '../src/services/backup.ts';
import { createCtx } from '../src/services/ctx.ts';
import type { Logger } from '../src/services/ctx.ts';
import { replayJournal } from '../src/services/journal.ts';
import { verifyStock } from '../src/services/stock.ts';
import { AppError } from '../src/store/db.ts';

const root = join(import.meta.dirname, '..');
const dataDir = process.env.POS_DATA_DIR ?? join(root, 'data');
const backupDir = join(dataDir, 'backups');
const dbPath = join(dataDir, 'pos.db');
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

// Check the backup before touching anything.
const v = verifyBackup(file);
if (!v.ok) fail(`This backup is not usable: ${v.messages.join('; ') || 'it failed its integrity check'}. Nothing was changed. Choose another backup.`);

// Keep the current database (even a damaged one) aside, never delete it.
const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
const aside = join(dataDir, `pre-restore-${stamp}`);
let kept = 0;
for (const suffix of ['', '-wal', '-shm']) {
  if (!existsSync(dbPath + suffix)) continue;
  mkdirSync(aside, { recursive: true });
  renameSync(dbPath + suffix, join(aside, 'pos.db' + suffix));
  kept++;
}

try {
  const r = restoreBackup(file, dbPath);
  console.log(`Restored ${arg} (schema v${r.version}, ${kb(statSync(file).size)}).`);
  if (kept) console.log(`The previous database was kept in ${aside}`);
  console.log(`Menu photos: ${r.images.restored} restored, ${r.images.alreadyPresent} already in place${r.images.missing.length ? `, ${r.images.missing.length} MISSING (upload them again on the Menu screen)` : ''}.`);

  // Bring back bills made after the backup.
  const ctx = createCtx({ dataDir, logger: quiet });
  try {
    const rep = replayJournal(ctx);
    console.log(`Journal: ${rep.replayed} later change(s) replayed, ${rep.skipped} already in the backup.`);
    if (rep.errors.length) console.log(`WARNING: ${rep.errors.length} journal entr${rep.errors.length === 1 ? 'y' : 'ies'} could not be replayed. Keep this window's text for support:\n${rep.errors.slice(0, 10).map((e) => `  ${e.type} ${e.id}: ${e.message}`).join('\n')}`);
    const st = verifyStock(ctx);
    if (!st.ok) console.log(`WARNING: stock balances differ from the stock ledger for ${st.mismatches.length} item(s).`);
  } finally { ctx.db.close(); }
  console.log('\nDone. Start the POS again with: npm start');
} catch (e) {
  // Put the previous database back so the shop is no worse off.
  for (const suffix of ['-wal', '-shm', '']) { try { if (existsSync(dbPath + suffix)) renameSync(dbPath + suffix, join(aside, `failed-restore.pos.db${suffix}`)); } catch { /* keep going */ } }
  for (const suffix of ['', '-wal', '-shm']) { try { if (existsSync(join(aside, 'pos.db' + suffix))) renameSync(join(aside, 'pos.db' + suffix), dbPath + suffix); } catch { /* keep going */ } }
  fail(`Restore failed: ${e instanceof AppError ? e.message : String((e as Error).message ?? e)}\nThe previous database was put back.`);
}
