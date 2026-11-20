// Settings > Add-ons > Install from file (desktop app; Mac has no add-on installers, Windows may use either way).
// A .tiffinaddon file is the signed package files, flat, zipped (addons/<x>/scripts/zip.mjs). This only unpacks it into
// <addons>/<id>: the POS checks the signature, every file's fingerprint and the version when it starts, exactly as for
// an installer, and switches the add-on off with a reason if anything is wrong. Same rules as Android's AddonInstaller.
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const NAME = /^[A-Za-z0-9._-]{1,80}$/;
const ID = /^[a-z0-9][a-z0-9-]{1,39}$/;
const MAX_FILES = 20;
const MAX_BYTES = 30 * 1024 * 1024;

export interface AddonFile { id: string; name: string; version: string; files: Map<string, Buffer> }

const notAddon = () => new Error('This is not a Tiffin POS add-on file.');

/** Reads a .tiffinaddon file (zip: stored or deflated entries, plain file names only). Throws with a message for the person. */
export function readAddonFile(buf: Buffer): AddonFile {
  if (buf.length > MAX_BYTES) throw new Error('The add-on file is too large.');
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw notAddon();
  const count = buf.readUInt16LE(end + 10);
  if (count > MAX_FILES) throw notAddon();
  const files = new Map<string, Buffer>();
  let total = 0;
  try {
    let p = buf.readUInt32LE(end + 16);
    for (let n = 0; n < count; n++) {
      if (buf.readUInt32LE(p) !== 0x02014b50) throw notAddon();
      const method = buf.readUInt16LE(p + 10), packedSize = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24);
      const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32), at = buf.readUInt32LE(p + 42);
      const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
      p += 46 + nameLen + extraLen + commentLen;
      if (!NAME.test(name) || name.includes('..') || files.has(name) || (method !== 0 && method !== 8)) throw notAddon();
      total += size;
      if (total > MAX_BYTES) throw new Error('The add-on file is too large.');
      if (buf.readUInt32LE(at) !== 0x04034b50) throw notAddon();
      const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
      const packed = buf.subarray(start, start + packedSize);
      const data = method === 0 ? Buffer.from(packed) : inflateRawSync(packed, { maxOutputLength: MAX_BYTES });
      if (data.length !== size) throw notAddon();
      files.set(name, data);
    }
  } catch (e) {
    if (e instanceof Error && /too large/.test(e.message)) throw e;
    throw notAddon();
  }
  const m = files.get('manifest.json');
  if (!m) throw new Error('This is not a Tiffin POS add-on file (no manifest).');
  let manifest: { id?: unknown; name?: unknown; version?: unknown };
  try { manifest = JSON.parse(m.toString('utf8')) as typeof manifest; } catch { throw notAddon(); }
  const id = typeof manifest.id === 'string' ? manifest.id : '';
  if (!ID.test(id)) throw notAddon();
  return { id, name: typeof manifest.name === 'string' ? manifest.name : id, version: typeof manifest.version === 'string' ? manifest.version : '', files };
}

/** Puts the files in <addonsDir>/<id>, replacing an installed copy only once the new one is complete. */
export function installAddon(addonsDir: string, a: AddonFile): void {
  mkdirSync(addonsDir, { recursive: true });
  const tmp = join(addonsDir, `.${a.id}.new`), target = join(addonsDir, a.id), old = join(addonsDir, `.${a.id}.old`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp);
  for (const [name, data] of a.files) writeFileSync(join(tmp, name), data);
  rmSync(old, { recursive: true, force: true });
  if (existsSync(target)) renameSync(target, old);
  try { renameSync(tmp, target); } catch (e) { if (existsSync(old)) renameSync(old, target); throw e; }
  rmSync(old, { recursive: true, force: true });
}

/** Removes an add-on's files (its settings and data in the POS database stay). */
export function removeAddon(addonsDir: string, id: string): boolean {
  if (!ID.test(id)) return false;
  const target = join(addonsDir, id);
  if (!existsSync(target)) return false;
  rmSync(target, { recursive: true, force: true });
  return true;
}
