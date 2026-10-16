import { deflateSync, crc32 } from 'node:zlib';
import { AppError, get, run } from '../store/db.ts';
import type { Actor, Ctx } from './ctx.ts';
import { runCommand } from './commands.ts';
import { audit } from './audit.ts';
import { assertPerm } from './permissions.ts';
import { getSetting, setSetting } from './settings.ts';
import { gstinProblem } from '../core/gstin.ts';

/**
 * Store details (Settings > Store): name, address, phone, GSTIN, FSSAI and the bill logo.
 * Details are versioned (outlet_version): a bill shows the details valid when it was issued, also on reprints.
 * The logo is a 1-bit raster made in the browser (at most 384 x 240 dots, the printable width of 58 mm paper),
 * printed with GS v 0 and centred on wider paper. It is not versioned (not a legal part of the bill).
 */

export interface StoreDetails { name: string; address: string | null; phone: string | null; gstin: string | null; fssaiNo: string | null }
export interface Logo { width: number; height: number; data: Uint8Array }
const LOGO_KEY = 'store_logo';
export const LOGO_MAX_WIDTH = 384, LOGO_MAX_HEIGHT = 240;

interface OutletRow { id: string; name: string; address: string | null; phone: string | null; gstin: string | null; fssai_no: string | null; state_code: string }
const outlet = (ctx: Ctx) => {
  const o = get<OutletRow>(ctx.db, 'SELECT id, name, address, phone, gstin, fssai_no, state_code FROM outlet LIMIT 1');
  if (!o) throw new AppError('NOT_SET_UP', 'Finish the first-run setup first.', 409);
  return o;
};

export function getStore(ctx: Ctx, actor: Actor) {
  assertPerm(actor, 'printer.manage');
  const o = outlet(ctx);
  const logo = logoMeta(ctx);
  return { name: o.name, address: o.address, phone: o.phone, gstin: o.gstin, fssaiNo: o.fssai_no, stateCode: o.state_code, logo };
}

const clean = (v: string | null | undefined) => { const t = (v ?? '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean).join('\n'); return t || null; };

/** Changes the store details for bills issued from now on (owner only). */
export function updateStore(ctx: Ctx, actor: Actor, requestId: string, input: StoreDetails) {
  return runCommand(ctx, requestId, 'store.update', actor, () => {
    assertPerm(actor, 'settings.write');
    const o = outlet(ctx);
    const next: StoreDetails = {
      name: (input.name ?? '').trim(), address: clean(input.address), phone: clean(input.phone),
      gstin: clean(input.gstin)?.toUpperCase().replace(/\s/g, '') ?? null, fssaiNo: clean(input.fssaiNo)?.replace(/\s/g, '') ?? null,
    };
    const problems: Record<string, string> = {};
    if (!next.name || next.name.length > 60) problems.name = 'Enter the store name (up to 60 characters).';
    if (next.address && (next.address.length > 200 || next.address.split('\n').length > 4)) problems.address = 'Keep the address to 4 lines and 200 characters.';
    if (next.phone && !/^[0-9+()\- ]{6,20}$/.test(next.phone)) problems.phone = 'Use digits, spaces, + and - only (6 to 20 characters).';
    if (next.fssaiNo && !/^\d{14}$/.test(next.fssaiNo)) problems.fssaiNo = 'An FSSAI licence number has 14 digits.';
    if (next.gstin && next.gstin !== o.gstin) {
      const p = gstinProblem(next.gstin);
      if (p) problems.gstin = p;
      else if (next.gstin.slice(0, 2) !== o.state_code) problems.gstin = `This GSTIN is for state ${next.gstin.slice(0, 2)}, but this store was set up in state ${o.state_code}. GST on bills depends on the state, so a store in another state needs a new setup.`;
    }
    if (Object.keys(problems).length) throw new AppError('VALIDATION', Object.values(problems)[0]!, 400, { fields: problems });
    const prev: StoreDetails = { name: o.name, address: o.address, phone: o.phone, gstin: o.gstin, fssaiNo: o.fssai_no };
    const changed = (Object.keys(next) as Array<keyof StoreDetails>).filter((k) => next[k] !== prev[k]);
    if (changed.length === 0) return { ...next, changed };
    // strictly after the previous version, even for two changes in the same millisecond
    const last = get<{ t: number | null }>(ctx.db, 'SELECT max(valid_from) AS t FROM outlet_version WHERE outlet_id = ?', o.id)?.t ?? -1;
    const now = Math.max(ctx.clock.now(), last + 1);
    // the details in force until now (stores set up after migration 5 have no row yet)
    run(ctx.db, `INSERT OR IGNORE INTO outlet_version (outlet_id, valid_from, name, address, phone, gstin, fssai_no) VALUES (?, 0, ?, ?, ?, ?, ?)`,
      o.id, prev.name, prev.address, prev.phone, prev.gstin, prev.fssaiNo);
    run(ctx.db, `INSERT INTO outlet_version (outlet_id, valid_from, name, address, phone, gstin, fssai_no, changed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      o.id, now, next.name, next.address, next.phone, next.gstin, next.fssaiNo, actor.userId);
    run(ctx.db, 'UPDATE outlet SET name = ?, address = ?, phone = ?, gstin = ?, fssai_no = ? WHERE id = ?', next.name, next.address, next.phone, next.gstin, next.fssaiNo, o.id);
    audit(ctx, actor.userId, 'store.update', 'outlet', o.id, { changed, before: Object.fromEntries(changed.map((k) => [k, prev[k]])), after: Object.fromEntries(changed.map((k) => [k, next[k]])) });
    return { ...next, changed };
  });
}

/** The store details valid at a moment (for a bill issued then). */
export function storeAt(ctx: Ctx, outletId: string, at: number): StoreDetails | null {
  const v = get<{ name: string; address: string | null; phone: string | null; gstin: string | null; fssai_no: string | null }>(ctx.db,
    'SELECT name, address, phone, gstin, fssai_no FROM outlet_version WHERE outlet_id = ? AND valid_from <= ? ORDER BY valid_from DESC LIMIT 1', outletId, at);
  return v ? { name: v.name, address: v.address, phone: v.phone, gstin: v.gstin, fssaiNo: v.fssai_no } : null;
}

// ---------------------------------------------------------------- logo

let cache: { text: string; logo: Logo | null } | null = null;
export function storeLogo(ctx: Ctx): Logo | null {
  const text = getSetting(ctx, LOGO_KEY);
  if (!text) return null;
  if (cache?.text === text) return cache.logo;
  let logo: Logo | null = null;
  try { const j = JSON.parse(text) as { width: number; height: number; bits: string }; logo = { width: j.width, height: j.height, data: Uint8Array.from(Buffer.from(j.bits, 'base64')) }; } catch { logo = null; }
  cache = { text, logo };
  return logo;
}
function logoMeta(ctx: Ctx) {
  const text = getSetting(ctx, LOGO_KEY);
  if (!text) return null;
  try { const j = JSON.parse(text) as { width: number; height: number; updatedAt: number }; return { width: j.width, height: j.height, updatedAt: j.updatedAt }; } catch { return null; }
}

/** Saves the bill logo: width x height dots, 1 bit per dot (1 = black), rows of width/8 bytes, MSB first. */
export function setStoreLogo(ctx: Ctx, actor: Actor, requestId: string, input: { width: number; height: number; bitsBase64: string }) {
  return runCommand(ctx, requestId, 'store.logo.set', actor, () => {
    assertPerm(actor, 'settings.write');
    const { width, height } = input;
    if (!Number.isInteger(width) || width < 8 || width > LOGO_MAX_WIDTH || width % 8 !== 0) throw new AppError('VALIDATION', `The logo must be 8 to ${LOGO_MAX_WIDTH} dots wide, in steps of 8.`);
    if (!Number.isInteger(height) || height < 8 || height > LOGO_MAX_HEIGHT) throw new AppError('VALIDATION', `The logo must be 8 to ${LOGO_MAX_HEIGHT} dots high.`);
    const bits = Buffer.from(input.bitsBase64, 'base64');
    if (bits.length !== (width / 8) * height) throw new AppError('VALIDATION', 'The logo data does not match its size. Choose the picture again.');
    if (!bits.some((b) => b !== 0)) throw new AppError('VALIDATION', 'The logo is blank. Try a picture with a darker logo, or change the darkness.');
    const updatedAt = ctx.clock.now();
    setSetting(ctx, LOGO_KEY, JSON.stringify({ width, height, bits: bits.toString('base64'), updatedAt }));
    audit(ctx, actor.userId, 'store.logo.set', 'settings', LOGO_KEY, { width, height });
    return { width, height, updatedAt };
  });
}

export function clearStoreLogo(ctx: Ctx, actor: Actor, requestId: string) {
  return runCommand(ctx, requestId, 'store.logo.clear', actor, () => {
    assertPerm(actor, 'settings.write');
    run(ctx.db, 'DELETE FROM settings WHERE key = ?', LOGO_KEY);
    audit(ctx, actor.userId, 'store.logo.clear', 'settings', LOGO_KEY);
    return { logo: null };
  });
}

/** The logo as a black-and-white PNG (what the printer prints), for previews. */
export function logoPng(ctx: Ctx): Buffer | null {
  const l = storeLogo(ctx);
  if (!l) return null;
  const rowBytes = l.width / 8;
  const raw = Buffer.alloc((rowBytes + 1) * l.height);
  for (let y = 0; y < l.height; y++) {
    raw[y * (rowBytes + 1)] = 0; // filter: none
    for (let x = 0; x < rowBytes; x++) raw[y * (rowBytes + 1) + 1 + x] = ~l.data[y * rowBytes + x]! & 0xff; // PNG grey: 1 = white
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(l.width, 0); ihdr.writeUInt32BE(l.height, 4); ihdr[8] = 1; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
