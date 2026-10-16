import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { all, openDb } from '../src/store/db.ts';

// Guards the "run directly" check: a file-URL comparison that only works on POSIX once made the seed a silent no-op on Windows.
test('npm run seed: running the script directly creates the demo data (Windows and POSIX paths)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pos-seed-'));
  try {
    const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'src', 'seed.ts')], { env: { ...process.env, POS_DATA_DIR: dir }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Seeded demo data/);
    const db = openDb(join(dir, 'pos.db'), { readOnly: true });
    try { assert.deepEqual(all<{ name: string }>(db, 'SELECT name FROM app_user ORDER BY name').map((u) => u.name), ['Cashier', 'Manager', 'Owner']); } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
