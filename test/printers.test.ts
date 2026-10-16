import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { all, get, openDb, run, sha256, currentSchemaVersion } from '../src/store/db.ts';
import { MIGRATIONS } from '../src/store/schema.ts';

test('migrations v3 and v4: a version 2 database keeps its printers and print jobs, allows Bluetooth (serial) and driverless USB printers, and still enforces foreign keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pos-mig3-'));
  try {
    const path = join(dir, 'pos.db');
    const v2 = new DatabaseSync(path);
    v2.exec('PRAGMA journal_mode = WAL');
    v2.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)');
    for (const m of MIGRATIONS.filter((x) => x.version <= 2)) {
      v2.exec(m.sql);
      v2.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?, 0)').run(m.version, m.name, sha256(m.sql));
    }
    v2.prepare("INSERT INTO printer(id, name, transport, address, width_mm, is_receipt, drawer, stations, active, created_at) VALUES ('p1', 'Counter', 'spooler', 'POS-80', 80, 1, 1, '[]', 1, 5)").run();
    v2.prepare("INSERT INTO printer(id, name, transport, address, width_mm, stations, created_at) VALUES ('p2', 'Kitchen', 'tcp', '192.168.1.50:9100', 58, '[\"kitchen\"]', 6)").run();
    v2.prepare("INSERT INTO print_job(id, kind, printer_id, payload, status, created_at, updated_at) VALUES ('j1', 'RECEIPT', 'p1', x'1b40', 'QUEUED', 7, 7)").run();
    assert.throws(() => v2.prepare("INSERT INTO printer(id, name, transport, created_at) VALUES ('p3', 'BT', 'serial', 1)").run(), /CHECK/);
    v2.close();

    const db = openDb(path);
    try {
      assert.equal(currentSchemaVersion(db), MIGRATIONS.at(-1)!.version);
      assert.deepEqual(all<Record<string, unknown>>(db, 'SELECT id, name, transport, address, width_mm, is_receipt, drawer, stations, active, created_at FROM printer ORDER BY id').map((r) => ({ ...r })), [
        { id: 'p1', name: 'Counter', transport: 'spooler', address: 'POS-80', width_mm: 80, is_receipt: 1, drawer: 1, stations: '[]', active: 1, created_at: 5 },
        { id: 'p2', name: 'Kitchen', transport: 'tcp', address: '192.168.1.50:9100', width_mm: 58, is_receipt: 0, drawer: 0, stations: '["kitchen"]', active: 1, created_at: 6 },
      ]);
      assert.equal(get<{ p: string }>(db, "SELECT printer_id p FROM print_job WHERE id = 'j1'")!.p, 'p1');
      run(db, "INSERT INTO printer(id, name, transport, address, created_at) VALUES ('p3', 'Bluetooth', 'serial', 'COM5', 8)");
      run(db, "INSERT INTO printer(id, name, transport, address, created_at) VALUES ('p5', 'USB direct', 'usb', '0416:5011', 9)"); // v4: driverless USB
      assert.throws(() => run(db, "INSERT INTO printer(id, name, transport, created_at) VALUES ('p4', 'X', 'laser', 9)"), /CHECK/);
      assert.throws(() => run(db, "INSERT INTO print_job(id, kind, printer_id, payload, status, created_at, updated_at) VALUES ('j2', 'TEST', 'nope', x'00', 'QUEUED', 1, 1)"), /FOREIGN KEY/);
      assert.equal(get<{ foreign_keys: number }>(db, 'PRAGMA foreign_keys')!.foreign_keys, 1, 'foreign keys are back on after the migration');
      assert.deepEqual(all(db, 'PRAGMA foreign_key_check'), []);
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
