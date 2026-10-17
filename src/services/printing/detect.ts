import { all, get, run, AppError } from '../../store/db.ts';
import type { Actor, Ctx } from '../ctx.ts';
import { runCommand } from '../commands.ts';
import { audit } from '../audit.ts';
import { assertPerm } from '../permissions.ts';
import { requireApproval } from '../auth.ts';
import type { Override } from '../auth.ts';
import { getSetting, setSetting } from '../settings.ts';
import { listWindowsPrinters } from './devices.ts';
import type { WindowsPrinter } from './devices.ts';
import { listUsbPrinters } from './usb.ts';
import { listAndroidPrinters } from './android.ts';
import type { AndroidPrinterInfo } from './android.ts';
import type { UsbPrinterInfo } from './usb.ts';
import { buildTestPage } from './receipt.ts';
import { colsFor } from './transports.ts';
import { enqueueJob } from './jobs.ts';

/**
 * Plug and play: notice USB printers that were plugged in but are not set up yet, and set one up in one tap.
 * Scans run only when someone asks (the billing screen polls), at most once per cache window, never in the background.
 */

export interface DetectedPrinter {
  key: string; transport: 'usb' | 'spooler' | 'android'; address: string; name: string; detail: string; widthMm: 58 | 80;
}
export interface UsbDevice extends DetectedPrinter { printerId: string | null; printerName: string | null; printerActive: boolean | null; dismissed: boolean }
interface Scan { usb: UsbPrinterInfo[]; windows: WindowsPrinter[]; android?: AndroidPrinterInfo[] }
interface CacheEntry { at: number; data: Scan; detected: DetectedPrinter[] }

const cache = new WeakMap<Ctx, CacheEntry>();
const inflight = new WeakMap<Ctx, Promise<Scan>>();
const IGNORE_KEY = 'printer_detect_ignored';

export function resetDetectCache(ctx: Ctx): void { cache.delete(ctx); }

async function defaultScan(): Promise<Scan> {
  if (process.platform === 'android') return { usb: [], windows: [], android: await listAndroidPrinters().catch(() => []) };
  const [usb, windows] = await Promise.all([listUsbPrinters().catch(() => []), listWindowsPrinters().catch(() => [])]);
  return { usb, windows };
}
/** Platforms where printers can be found: Windows, and Android inside the Tiffin POS app. */
const canScan = (platform: string) => platform === 'win32' || platform === 'android';

const guessWidth = (s: string): 58 | 80 => (/(^|\D)58(\D|$)|58\s?mm/i.test(s) ? 58 : 80);
const ignored = (ctx: Ctx): Set<string> => { try { return new Set(JSON.parse(getSetting(ctx, IGNORE_KEY) || '[]') as string[]); } catch { return new Set(); } };

/** Every USB printer plugged in now, with the printer it is set up as (if any). */
function allDevices(ctx: Ctx, scan: Scan): UsbDevice[] {
  const byAddr = new Map(all<{ id: string; name: string; transport: string; address: string | null; active: number }>(ctx.db, 'SELECT id, name, transport, address, active FROM printer')
    .map((p) => [`${p.transport}:${(p.address ?? '').toLowerCase()}`, p]));
  const skip = ignored(ctx);
  return listRaw(scan).map((d) => {
    const p = byAddr.get(`${d.transport}:${d.address.toLowerCase()}`);
    return { ...d, printerId: p?.id ?? null, printerName: p?.name ?? null, printerActive: p ? p.active === 1 : null, dismissed: skip.has(d.key) };
  });
}

function compute(ctx: Ctx, scan: Scan): DetectedPrinter[] {
  return allDevices(ctx, scan).filter((d) => !d.printerId && !d.dismissed).map(({ printerId: _a, printerName: _b, printerActive: _c, dismissed: _d, ...rest }) => rest);
}

function listRaw(scan: Scan): DetectedPrinter[] {
  const out: DetectedPrinter[] = [];
  for (const u of scan.usb) {
    const key = `usb:${u.id}`;
    const generic = /^usb (printing support|printer)$/i.test(u.name);
    const name = generic ? (u.vendor ? `${u.vendor.split(' (')[0]} USB printer` : 'USB receipt printer') : u.name;
    out.push({ key, transport: 'usb', address: u.id, name, detail: u.driver === 'winusb' ? `USB, WinUSB driver (${u.vid}:${u.pid})` : `USB, no driver needed (${u.vid}:${u.pid})`, widthMm: guessWidth(u.name) });
  }
  for (const w of scan.windows) {
    if (w.connection !== 'usb') continue;
    const key = `spooler:${w.name}`;
    out.push({ key, transport: 'spooler', address: w.name, name: w.name, detail: `USB, Windows driver ${w.driver} on ${w.port}`, widthMm: guessWidth(`${w.name} ${w.driver}`) });
  }
  for (const a of scan.android ?? []) {
    out.push({ key: `android:${a.address}`, transport: 'android', address: a.address, name: a.name, detail: a.detail, widthMm: a.builtin ? 58 : guessWidth(a.name) });
  }
  return out;
}

async function scanned(ctx: Ctx, o: { scan?: () => Promise<Scan>; maxAgeMs?: number }): Promise<CacheEntry> {
  const maxAge = o.maxAgeMs ?? 15_000;
  let c = cache.get(ctx);
  if (!c || Date.now() - c.at >= maxAge) {
    let p = inflight.get(ctx);
    if (!p) { p = (o.scan ?? defaultScan)(); inflight.set(ctx, p); }
    try { const data = await p; c = { at: Date.now(), data, detected: [] }; } finally { inflight.delete(ctx); }
  }
  c.detected = compute(ctx, c.data);
  cache.set(ctx, c);
  return c;
}

/** USB printers that are plugged in but not set up (and not dismissed). Scans at most once per maxAgeMs. */
export async function detectPrinters(ctx: Ctx, o: { scan?: () => Promise<Scan>; platform?: string; maxAgeMs?: number } = {}): Promise<DetectedPrinter[]> {
  if (!canScan(o.platform ?? process.platform)) return [];
  return (await scanned(ctx, o)).detected;
}

/** Every USB printer plugged in now (for the Printer setup screen). refresh: scan now instead of using the last scan. */
export async function listUsbDevices(ctx: Ctx, o: { scan?: () => Promise<Scan>; platform?: string; refresh?: boolean } = {}): Promise<{ scannedAt: number | null; devices: UsbDevice[] }> {
  if (!canScan(o.platform ?? process.platform)) return { scannedAt: null, devices: [] };
  const c = await scanned(ctx, { scan: o.scan, maxAgeMs: o.refresh ? 0 : 15_000 });
  return { scannedAt: c.at, devices: allDevices(ctx, c.data) };
}

/** "Not now": stop offering this printer (kept in settings, so it survives a restart). */
export function dismissDetected(ctx: Ctx, actor: Actor, requestId: string, key: string): { key: string } {
  return runCommand(ctx, requestId, 'printer.detect.dismiss', actor, () => {
    assertPerm(actor, 'print.read');
    if (typeof key !== 'string' || key.length > 300 || !/^(usb|spooler|android):/.test(key)) throw new AppError('VALIDATION', 'Unknown printer.');
    const s = ignored(ctx);
    s.add(key);
    setSetting(ctx, IGNORE_KEY, JSON.stringify([...s].slice(-100)));
    audit(ctx, actor.userId, 'printer.detect.dismiss', 'printer', undefined, { key });
    return { key };
  });
}

/**
 * One tap: set a detected printer up and print a test page. The first one becomes the receipt printer
 * (with the cash drawer); later ones are added for the manager to assign in Settings. A cashier needs approval.
 */
export function quickAddPrinter(ctx: Ctx, actor: Actor, requestId: string, input: { key: string; override?: Override }) {
  return runCommand(ctx, requestId, 'printer.quick_add', actor, () => {
    const approver = requireApproval(ctx, actor, 'printer.manage', input.override);
    const c = cache.get(ctx);
    const d = c ? compute(ctx, c.data).find((x) => x.key === input.key) : undefined;
    if (!d) throw new AppError('NOT_FOUND', 'That printer is no longer plugged in, or it is already set up. Check Settings, Printers.', 404);
    const isReceipt = !get(ctx.db, 'SELECT 1 FROM printer WHERE active = 1 AND is_receipt = 1');
    const id = ctx.ids.next();
    run(ctx.db, 'INSERT INTO printer(id, name, transport, address, width_mm, profile, is_receipt, drawer, stations, active, created_at) VALUES (?,?,?,?,?,?,?,?,?,1,?)',
      id, d.name.slice(0, 60), d.transport, d.address, d.widthMm, 'generic', isReceipt ? 1 : 0, isReceipt ? 1 : 0, '[]', ctx.clock.now());
    audit(ctx, actor.userId, 'printer.create', 'printer', id, { name: d.name, transport: d.transport, via: 'plug_and_play', approver });
    const jobId = enqueueJob(ctx, { kind: 'TEST', refId: id, printerId: id, payload: buildTestPage(colsFor(d.widthMm), d.name), dedupeKey: `test:${requestId}` });
    return { printerId: id, name: d.name, isReceipt, testJobId: jobId };
  });
}
