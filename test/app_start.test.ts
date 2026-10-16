import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBackend } from '../src/app.ts';

const silent = { info() {}, warn() {}, error() {} };

test('startBackend: random port, launch secret required on every request, clean shutdown with a closing backup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pos-app-'));
  const b = await startBackend({ dataDir: dir, port: 0, secret: 's3cret-launch-value', logger: silent, scheduleBackups: false });
  try {
    assert.ok(b.port > 0);
    const url = `http://127.0.0.1:${b.port}/api/ping`;
    const noSecret = await fetch(url);
    assert.equal(noSecret.status, 403);
    assert.equal((await noSecret.json()).error.code, 'BAD_LAUNCH_SECRET');
    assert.equal((await fetch(url, { headers: { 'x-pos-secret': 'wrong' } })).status, 403);
    const ok = await fetch(url, { headers: { 'x-pos-secret': 's3cret-launch-value' } });
    assert.equal(ok.status, 200);
  } finally {
    await b.shutdown('test');
  }
  assert.ok(readdirSync(join(dir, 'backups')).some((f) => f.includes('close')), 'a backup is taken on close');
  rmSync(dir, { recursive: true, force: true });
});

test('startBackend without a secret behaves as before (npm start, the browser UI)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pos-app-'));
  const b = await startBackend({ dataDir: dir, port: 0, logger: silent, scheduleBackups: false });
  try {
    assert.equal((await fetch(`http://127.0.0.1:${b.port}/api/ping`)).status, 200);
  } finally { await b.shutdown('test'); rmSync(dir, { recursive: true, force: true }); }
});
