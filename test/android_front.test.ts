import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { startFront } from '../android/backend/front.ts';

const TOKEN = 'k'.repeat(43);
/** A stand-in backend that echoes what it received, so the test sees exactly what the gatekeeper forwards. */
async function fakeBackend() {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ method: req.method, url: req.url, secret: req.headers['x-pos-secret'] ?? null, cookie: req.headers.cookie ?? null, body: Buffer.concat(chunks).toString() })); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { server, port: (server.address() as { port: number }).port };
}
const get = (port: number, path: string, headers: Record<string, string> = {}, method = 'GET', body?: string) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }>((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
    let text = ''; res.setEncoding('utf8'); res.on('data', (c: string) => { text += c; }); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, text }));
  });
  req.on('error', reject);
  if (body) req.write(body);
  req.end();
});

test('Android gatekeeper: only the app (with its private cookie) gets the screens and the API; the API gets the secret; files stay inside the UI folder', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'front-'));
  const ui = join(dir, 'ui');
  mkdirSync(join(ui, 'assets'), { recursive: true });
  writeFileSync(join(ui, 'index.html'), '<!doctype html><title>POS</title>');
  writeFileSync(join(ui, 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(join(dir, 'secret.txt'), 'outside');
  const back = await fakeBackend();
  const front = await startFront({ uiDir: ui, backendPort: back.port, secret: 'S3CRET', token: TOKEN });
  const cookie = { cookie: `pos_k=${TOKEN}` };
  try {
    // another app on the device: no cookie, wrong cookie, or a non-loopback Host
    assert.equal((await get(front.port, '/')).status, 403);
    assert.equal((await get(front.port, '/api/health', { cookie: 'pos_k=wrong' })).status, 403);
    assert.equal((await get(front.port, '/', { ...cookie, host: 'evil.example' })).status, 403);
    // the app's window
    const page = await get(front.port, '/', cookie);
    assert.equal(page.status, 200);
    assert.match(page.text, /<title>POS/);
    assert.match(String(page.headers['content-security-policy']), /default-src 'self'/);
    assert.equal((await get(front.port, '/assets/app.js', cookie)).headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal((await get(front.port, '/../secret.txt', cookie)).status, 404);
    assert.equal((await get(front.port, '/%2e%2e/secret.txt', cookie)).status, 404);
    // the API: forwarded with the real secret, without the cookie, body intact
    const api = JSON.parse((await get(front.port, '/api/orders?x=1', { ...cookie, 'content-type': 'application/json', 'x-pos-secret': 'forged' }, 'POST', '{"a":1}')).text);
    assert.deepEqual(api, { method: 'POST', url: '/api/orders?x=1', secret: 'S3CRET', cookie: null, body: '{"a":1}' });
  } finally {
    await front.close();
    await new Promise<void>((r) => back.server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});
