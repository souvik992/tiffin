import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { forwardHeaders, isAppUrl, resolveRequest } from '../src/protocol.ts';

const UI = join('C:', 'app', 'ui');

test('app:// URLs map to UI files, /api to the backend, and nothing escapes the UI folder', () => {
  assert.deepEqual(resolveRequest('app://pos/api/reports/view/items?from=2026-10-01&to=2026-10-02', UI), { kind: 'api', path: '/api/reports/view/items?from=2026-10-01&to=2026-10-02' });
  assert.deepEqual(resolveRequest('app://pos/', UI), { kind: 'file', file: join(UI, 'index.html'), type: 'text/html; charset=utf-8' });
  assert.deepEqual(resolveRequest('app://pos/assets/index-abc.js', UI), { kind: 'file', file: join(UI, 'assets', 'index-abc.js'), type: 'text/javascript; charset=utf-8' });
  assert.equal((resolveRequest('app://pos/assets/font.woff2', UI) as { type: string }).type, 'font/woff2');
  // traversal, encoded traversal, other hosts and schemes
  assert.deepEqual(resolveRequest('app://pos/../secret.txt', UI), { kind: 'file', file: join(UI, 'secret.txt'), type: 'text/plain; charset=utf-8' }); // the URL parser already removes the ..
  assert.equal((resolveRequest('app://pos/%2e%2e/%2e%2e/pos.db', UI) as { file: string }).file, join(UI, 'pos.db')); // also resolved by the URL parser
  for (const bad of ['app://pos/..%5C..%5Cdata%5Cpos.db', 'app://pos/%00', 'app://evil/index.html', 'file:///C:/app/ui/index.html', 'not a url', 'app://pos/%E0%A4%A']) {
    assert.equal(resolveRequest(bad, UI).kind, 'missing', bad);
  }
  assert.equal(resolveRequest('app://pos/apiary.png', UI).kind, 'file'); // only /api and /api/... go to the backend
});

test('the secret header is always the real one, never what the page sent', () => {
  const h = forwardHeaders([['Authorization', 'Bearer t'], ['X-POS-Secret', 'forged'], ['Host', 'evil'], ['Content-Type', 'application/json']], 'real');
  assert.equal(h.get('x-pos-secret'), 'real');
  assert.equal(h.get('authorization'), 'Bearer t');
  assert.equal(h.get('host'), null);
  assert.equal(h.get('content-type'), 'application/json');
});

test('navigation is allowed only inside the app', () => {
  assert.equal(isAppUrl('app://pos/index.html#/reports'), true);
  for (const u of ['https://example.com', 'app://other/', 'file:///C:/Windows', 'javascript:alert(1)']) assert.equal(isAppUrl(u), false, u);
});
