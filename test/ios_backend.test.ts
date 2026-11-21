import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { deflateRawSync } from 'node:zlib';
import { startFront } from '../android/backend/front.ts';
import { iosAppRoutes } from '../ios/backend/appRoutes.ts';

const TOKEN = 'k'.repeat(43);

/** A stand-in backend: /api/me says who the bearer token belongs to (owner or cashier). */
async function fakeBackend() {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/me' && req.headers['x-pos-secret'] === 'S3CRET') {
      const role = req.headers.authorization === 'Bearer owner' ? 'owner' : req.headers.authorization === 'Bearer cashier' ? 'cashier' : null;
      res.writeHead(role ? 200 : 401, { 'content-type': 'application/json' });
      res.end(JSON.stringify(role ? { userId: 'u', role, name: 'X' } : { error: { code: 'AUTH' } }));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { server, port: (server.address() as { port: number }).port };
}

/** A minimal zip (deflated entries), like addons/<x>/scripts/zip.mjs makes. */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text), data = deflateRawSync(raw), n = Buffer.from(name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(n.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, n, data); centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const send = (port: number, path: string, headers: Record<string, string>, body?: Buffer) => new Promise<{ status: number; json: Record<string, unknown> }>((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers }, (res) => {
    let text = ''; res.setEncoding('utf8'); res.on('data', (c: string) => { text += c; });
    res.on('end', () => { let json: Record<string, unknown> = {}; try { json = JSON.parse(text) as Record<string, unknown>; } catch { json = { text }; } resolve({ status: res.statusCode!, json }); });
  });
  req.on('error', reject);
  if (body) req.write(body);
  req.end();
});

test('iOS app: the owner installs and removes add-on files through the gatekeeper; others cannot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ios-front-'));
  const ui = join(dir, 'ui'), addons = join(dir, 'addons');
  mkdirSync(ui, { recursive: true });
  writeFileSync(join(ui, 'index.html'), '<!doctype html><title>POS</title>');
  const back = await fakeBackend();
  const restarts: string[] = [];
  const front = await startFront({ uiDir: ui, backendPort: back.port, secret: 'S3CRET', token: TOKEN, app: iosAppRoutes({ addonsDir: addons, backendPort: back.port, secret: 'S3CRET', restart: async (why) => { restarts.push(why); } }) });
  const file = zip({ 'manifest.json': JSON.stringify({ id: 'ods', name: 'ODS', version: '1.2.3' }), 'backend.cjs': 'module.exports = {}' });
  const as = (who: string) => ({ cookie: `pos_k=${TOKEN}`, authorization: `Bearer ${who}`, 'content-type': 'application/octet-stream' });
  try {
    assert.equal((await send(front.port, '/__ios/install-addon', { authorization: 'Bearer owner' }, file)).status, 403, 'no app cookie: refused before anything else');
    const cashier = await send(front.port, '/__ios/install-addon', as('cashier'), file);
    assert.equal(cashier.status, 403);
    assert.match(String((cashier.json.error as { message: string }).message), /Only the owner/);
    assert.equal(existsSync(join(addons, 'ods')), false);

    const bad = await send(front.port, '/__ios/install-addon', as('owner'), Buffer.from('not a zip'));
    assert.equal(bad.status, 400);
    assert.match(String((bad.json.error as { message: string }).message), /not a quickPOS add-on/);

    const ok = await send(front.port, '/__ios/install-addon', as('owner'), file);
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json, { installed: { id: 'ods', name: 'ODS', version: '1.2.3' } });
    assert.equal(readFileSync(join(addons, 'ods', 'backend.cjs'), 'utf8'), 'module.exports = {}');
    assert.deepEqual(restarts, ['add-on installed'], 'the POS restarts to load it; refused or bad files do not restart it');

    assert.equal((await send(front.port, '/__ios/remove-addon?id=ods', as('cashier'))).status, 403);
    assert.equal((await send(front.port, '/__ios/remove-addon?id=ods', as('owner'))).status, 200);
    assert.equal(existsSync(join(addons, 'ods')), false);
    assert.equal((await send(front.port, '/__ios/remove-addon?id=ods', as('owner'))).status, 404);
    assert.deepEqual(restarts, ['add-on installed', 'add-on removed']);
  } finally {
    await front.close();
    await new Promise<void>((r) => back.server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});
