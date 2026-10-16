import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';
import type { Server } from 'node:http';
import { get, AppError } from '../src/store/db.ts';
import { getCatalog } from '../src/services/catalog.ts';
import { MAX_IMAGE_BYTES, pruneImages, removeItemImage, setItemImage, sniffImage } from '../src/services/images.ts';
import { createServer, listen } from '../src/http/server.ts';
import { makeEnv, rid } from './helpers.ts';

const code = (fn: () => unknown): string => { try { fn(); } catch (e) { if (e instanceof AppError) return e.code; throw e; } return 'NO_ERROR'; };
const png = (fill = 1, size = 200) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(size, fill)]);
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 7)]);
const webp = () => Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(50, 3)]);
const b64 = (b: Buffer) => b.toString('base64');

test('images: only real JPEG, PNG or WebP bytes are accepted (SVG, HTML and fakes are refused)', () => {
  assert.equal(sniffImage(png()), 'png');
  assert.equal(sniffImage(jpeg()), 'jpg');
  assert.equal(sniffImage(webp()), 'webp');
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), null);
  assert.equal(sniffImage(Buffer.from('<html><body>hi</body></html>')), null);
  assert.equal(sniffImage(Buffer.from('RIFF\0\0\0\0WAVEfmt ')), null);
  assert.equal(sniffImage(Buffer.alloc(3)), null);
});

test('images: upload stores a content-named file, links it to the item, replaces and removes it', () => {
  const env = makeEnv(); try {
    const item = env.items['Cheese Burger']!;
    const r = setItemImage(env.ctx, env.manager, rid(), item, b64(png()));
    assert.match(r.imageFile, /^[0-9a-f]{64}\.png$/);
    assert.ok(existsSync(join(env.ctx.dataDir, 'images', r.imageFile)));
    assert.equal(getCatalog(env.ctx).items.find((i) => i.id === item)!.imageFile, r.imageFile);
    // the same photo twice is stored once; another item may share it
    assert.equal(setItemImage(env.ctx, env.manager, rid(), env.items['Chicken Burger']!, b64(png())).imageFile, r.imageFile);
    assert.equal(readdirSync(join(env.ctx.dataDir, 'images')).length, 1);

    const r2 = setItemImage(env.ctx, env.manager, rid(), item, b64(jpeg()));
    assert.match(r2.imageFile, /\.jpg$/);
    removeItemImage(env.ctx, env.manager, rid(), item);
    assert.equal(get<{ f: string | null }>(env.ctx.db, 'SELECT image_file f FROM item WHERE id = ?', item)!.f, null);
    assert.ok(get(env.ctx.db, "SELECT 1 FROM audit_log WHERE action = 'item.image.set'"));

    assert.equal(code(() => setItemImage(env.ctx, env.cashier, rid(), item, b64(png()))), 'FORBIDDEN');
    assert.equal(code(() => setItemImage(env.ctx, env.manager, rid(), 'nope', b64(png()))), 'NOT_FOUND');
    assert.equal(code(() => setItemImage(env.ctx, env.manager, rid(), item, b64(Buffer.from('<svg/>')))), 'UNSUPPORTED_IMAGE');
    assert.equal(code(() => setItemImage(env.ctx, env.manager, rid(), item, 'not base64 at all!')), 'VALIDATION');
    assert.equal(code(() => setItemImage(env.ctx, env.manager, rid(), item, b64(png(1, MAX_IMAGE_BYTES)))), 'IMAGE_TOO_LARGE');
    assert.equal(code(() => setItemImage(env.ctx, env.manager, rid(), item, '')), 'VALIDATION');
  } finally { env.cleanup(); }
});

test('images: served without sign-in (for <img>), cached, and nothing else on disk can be read', async () => {
  const env = makeEnv();
  const server: Server = createServer(env.ctx);
  const port = await listen(server, 0);
  try {
    const r = setItemImage(env.ctx, env.manager, rid(), env.items['Brownie']!, b64(webp()));
    const res = await fetch(`http://127.0.0.1:${port}/api/images/${r.imageFile}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/webp');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('cache-control') ?? '', /immutable/);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), webp());
    for (const bad of ['..%2Fpos.db', '..%5Cpos.db', 'pos.db', `${'a'.repeat(64)}.png`, `${r.imageFile.slice(0, 64)}.svg`, '%2e%2e%2fjournal']) {
      const b = await fetch(`http://127.0.0.1:${port}/api/images/${bad}`);
      assert.equal(b.status, 404, bad);
    }
    // the Host check still applies
    // (fetch drops a custom Host header, so use node:http, which sends it)
    const status = await new Promise<number>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: `/api/images/${r.imageFile}`, headers: { Host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }).on('error', reject);
    });
    assert.equal(status, 403);
  } finally { await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); }); env.cleanup(); }
});

test('images: files no item uses are cleaned up after a day; files in use are kept', () => {
  const env = makeEnv(); try {
    const used = setItemImage(env.ctx, env.manager, rid(), env.items['Brownie']!, b64(png(5))).imageFile;
    const dir = join(env.ctx.dataDir, 'images');
    const orphanOld = `${'b'.repeat(64)}.png`, orphanNew = `${'c'.repeat(64)}.png`;
    writeFileSync(join(dir, orphanOld), png(6)); writeFileSync(join(dir, orphanNew), png(7));
    writeFileSync(join(dir, 'notes.txt'), 'not ours'); // unknown names are never touched
    const old = new Date(Date.now() - 2 * 86_400_000);
    utimesSync(join(dir, orphanOld), old, old); utimesSync(join(dir, used), old, old);
    assert.equal(pruneImages(env.ctx), 1);
    assert.deepEqual(readdirSync(dir).sort(), [orphanNew, used, 'notes.txt'].sort());
  } finally { env.cleanup(); }
});
