import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { all, get, run, AppError } from '../store/db.ts';
import type { Actor, Ctx } from './ctx.ts';
import { runCommand } from './commands.ts';
import { assertPerm } from './permissions.ts';
import { audit } from './audit.ts';
import { emit } from './outbox.ts';

/**
 * Menu photos. Files live in <dataDir>/images, named by the SHA-256 of their bytes, so the same photo is stored
 * once and a name can never point at different content. The browser resizes photos before upload (no image
 * library here); the backend only accepts real JPEG, PNG or WebP bytes up to 1 MB. SVG is refused: it can carry script.
 * Photos are not inside the database, but every backup copies the ones the menu uses (services/backup.ts).
 */

export const MAX_IMAGE_BYTES = 1_000_000;
export type ImageExt = 'jpg' | 'png' | 'webp';
const TYPES: Record<ImageExt, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
export const IMAGE_FILE = /^[0-9a-f]{64}\.(jpg|png|webp)$/;

export const imagesDir = (ctx: Ctx): string => join(ctx.dataDir, 'images');

/** Identifies the format from the first bytes, ignoring any name or declared type. */
export function sniffImage(b: Uint8Array): ImageExt | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';
  if (b.length >= 12 && Buffer.from(b.subarray(0, 4)).toString('latin1') === 'RIFF' && Buffer.from(b.subarray(8, 12)).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

function decode(dataBase64: unknown): Buffer {
  if (typeof dataBase64 !== 'string' || dataBase64.length === 0) throw new AppError('VALIDATION', 'Choose a photo to upload.');
  if (dataBase64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4) throw new AppError('IMAGE_TOO_LARGE', 'That photo is too large. Use one under 1 MB.', 413);
  if (dataBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64)) throw new AppError('VALIDATION', 'The photo data is damaged. Choose the photo again.');
  const bytes = Buffer.from(dataBase64, 'base64');
  if (bytes.length > MAX_IMAGE_BYTES) throw new AppError('IMAGE_TOO_LARGE', 'That photo is too large. Use one under 1 MB.', 413);
  return bytes;
}

/** Saves the photo file (if new) and links it to the item. The file is written before the database change, never inside it. */
export function setItemImage(ctx: Ctx, actor: Actor, requestId: string, itemId: string, dataBase64: string): { itemId: string; imageFile: string } {
  assertPerm(actor, 'catalog.write'); // checked before anything touches the disk
  if (!get(ctx.db, 'SELECT 1 FROM item WHERE id = ? AND deleted_at IS NULL', itemId)) throw new AppError('NOT_FOUND', 'Item not found.', 404);
  const bytes = decode(dataBase64);
  const ext = sniffImage(bytes);
  if (!ext) throw new AppError('UNSUPPORTED_IMAGE', 'Use a JPG, PNG or WebP photo.', 415);
  const file = `${createHash('sha256').update(bytes).digest('hex')}.${ext}`;
  const dir = imagesDir(ctx);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  if (!existsSync(path)) {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, path); // never leaves a half-written photo under its final name
  }
  return runCommand(ctx, requestId, 'item.image.set', actor, () => {
    assertPerm(actor, 'catalog.write');
    const r = run(ctx.db, 'UPDATE item SET image_file = ?, version = version + 1, updated_at = ? WHERE id = ? AND deleted_at IS NULL', file, ctx.clock.now(), itemId);
    if (Number(r.changes) === 0) throw new AppError('NOT_FOUND', 'Item not found.', 404);
    audit(ctx, actor.userId, 'item.image.set', 'item', itemId, { file, bytes: bytes.length });
    emit(ctx, 'item', itemId, 'upsert', { id: itemId, imageFile: file });
    return { itemId, imageFile: file };
  });
}

export function removeItemImage(ctx: Ctx, actor: Actor, requestId: string, itemId: string): { itemId: string; imageFile: null } {
  return runCommand(ctx, requestId, 'item.image.remove', actor, () => {
    assertPerm(actor, 'catalog.write');
    const r = run(ctx.db, 'UPDATE item SET image_file = NULL, version = version + 1, updated_at = ? WHERE id = ? AND deleted_at IS NULL', ctx.clock.now(), itemId);
    if (Number(r.changes) === 0) throw new AppError('NOT_FOUND', 'Item not found.', 404);
    audit(ctx, actor.userId, 'item.image.remove', 'item', itemId);
    emit(ctx, 'item', itemId, 'upsert', { id: itemId, imageFile: null });
    return { itemId, imageFile: null };
  });
}

/** Reads a photo by its exact stored name. Any other name is "not found", so no other file can be reached. */
export function readImage(ctx: Ctx, file: string): { bytes: Buffer; type: string } {
  const m = IMAGE_FILE.exec(file);
  if (!m) throw new AppError('NOT_FOUND', 'Image not found.', 404);
  try {
    return { bytes: readFileSync(join(imagesDir(ctx), file)), type: TYPES[m[1] as ImageExt] };
  } catch {
    throw new AppError('NOT_FOUND', 'Image not found.', 404);
  }
}

/** Deletes photo files that no item (including removed items) points to and that are older than a day. */
export function pruneImages(ctx: Ctx, minAgeMs = 86_400_000): number {
  const dir = imagesDir(ctx);
  let files: string[];
  try { files = readdirSync(dir); } catch { return 0; }
  const used = new Set(all<{ f: string }>(ctx.db, 'SELECT DISTINCT image_file f FROM item WHERE image_file IS NOT NULL').map((r) => r.f));
  let removed = 0;
  for (const f of files) {
    const isTmp = /^[0-9a-f]{64}\.(jpg|png|webp)\.\d+\.tmp$/.test(f);
    if (!(IMAGE_FILE.test(f) || isTmp) || used.has(f)) continue;
    try {
      if (Date.now() - statSync(join(dir, f)).mtimeMs < minAgeMs) continue;
      unlinkSync(join(dir, f)); removed++;
    } catch { /* in use or already gone */ }
  }
  return removed;
}
