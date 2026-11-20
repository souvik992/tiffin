// Settings > Add-ons > Install from file in the desktop app: reading a .tiffinaddon file and putting it in the add-ons folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error plain JavaScript build helper (the same writer that makes the real .tiffinaddon files)
import { zip } from '../../addons/ods/scripts/zip.mjs';
import { installAddon, readAddonFile, removeAddon } from '../src/addonFile.ts';

const manifest = (o: Record<string, unknown> = {}) => Buffer.from(JSON.stringify({ id: 'ods', name: 'ODS', version: '1.0.14', ...o }));
const pkg = (files: Array<[string, Buffer]>): Buffer => zip(files) as Buffer;

test('add-on file: read, installed into <addons>/<id>, an update replaces the old files, remove deletes them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pos-addons-'));
  try {
    const a = readAddonFile(pkg([['manifest.json', manifest()], ['backend.cjs', Buffer.from('module.exports={}')], ['ui.js', Buffer.from('x'.repeat(100_000))]]));
    assert.deepEqual([a.id, a.name, a.version], ['ods', 'ODS', '1.0.14']);
    installAddon(dir, a);
    assert.deepEqual(readdirSync(join(dir, 'ods')).sort(), ['backend.cjs', 'manifest.json', 'ui.js']);
    assert.equal(readFileSync(join(dir, 'ods', 'ui.js'), 'utf8').length, 100_000);

    writeFileSync(join(dir, 'ods', 'uninstall.exe'), 'left by the Windows installer');
    installAddon(dir, readAddonFile(pkg([['manifest.json', manifest({ version: '1.0.15' })], ['backend.cjs', Buffer.from('2')]])));
    assert.deepEqual(readdirSync(join(dir, 'ods')).sort(), ['backend.cjs', 'manifest.json']);
    assert.deepEqual(readdirSync(dir), ['ods'], 'no temporary folders left');

    mkdirSync(join(dir, 'edc'));
    assert.equal(removeAddon(dir, 'ods'), true);
    assert.equal(existsSync(join(dir, 'ods')), false);
    assert.equal(removeAddon(dir, 'ods'), false);
    assert.equal(removeAddon(dir, '../edc'), false);
    assert.ok(existsSync(join(dir, 'edc')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('add-on file: anything that is not a plain add-on package is refused', () => {
  const notAddon = /not a Tiffin POS add-on file/;
  assert.throws(() => readAddonFile(Buffer.from('hello')), notAddon);
  assert.throws(() => readAddonFile(pkg([['backend.cjs', Buffer.from('x')]])), /no manifest/);
  assert.throws(() => readAddonFile(pkg([['manifest.json', manifest({ id: '../x' })]])), notAddon);
  assert.throws(() => readAddonFile(pkg([['manifest.json', Buffer.from('{oops')]])), notAddon);
  // a folder or a path in a name (written by hand: the build's writer refuses them)
  const evil = pkg([['manifest.json', manifest()], ['AAAAAAAAAA', Buffer.from('x')]]);
  const patched = Buffer.from(evil.toString('latin1').replaceAll('AAAAAAAAAA', '../../evil'), 'latin1');
  assert.throws(() => readAddonFile(patched), notAddon);
  assert.throws(() => readAddonFile(pkg(Array.from({ length: 21 }, (_, i) => [`f${i}`, Buffer.from('x')] as [string, Buffer]))), notAddon);
});
