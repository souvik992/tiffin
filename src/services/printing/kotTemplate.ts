import { EscPos, sanitize } from './escpos.ts';
import { formatQty } from '../../core/money.ts';

/**
 * Kitchen order ticket designs (.tiffinkot): a shop's own KOT layout, described as data, like bill designs
 * (receiptTemplate.ts). Three slots use one each (Settings > Store settings > Kitchen tickets): the customer KOT (printed
 * with the bill), the prep station KOT, and the online order KOT. A design can only arrange what the POS knows about the
 * ticket; the renderer always adds the safety marks (REPRINT, ADD-ON KOT n, CANCEL lines) and the feed and cut.
 * Reference: docs/KOT_TEMPLATES.md; examples and the standard designs: templates/kot/.
 */

export const KOT_TEMPLATE_EXT = '.tiffinkot';
const MAX_BYTES = 32 * 1024;

type Align = 'left' | 'center' | 'right';
type Size = 'normal' | 'tall' | 'wide' | 'big';
interface Style { align?: Align; bold?: boolean; size?: Size; if?: string }

export type KotBlock =
  | ({ type: 'text'; text: string } & Style)
  | ({ type: 'field'; label: string; value: string } & Style)
  | { type: 'rule'; char?: string }
  | { type: 'blank'; lines?: number }
  | ({ type: 'kot-title' } & Style)
  | { type: 'items'; size?: Size; bold?: boolean; modifiers?: boolean; notes?: boolean };

export interface KotTemplate { format: 'tiffin-kot'; version: 1; name: string; description?: string; blocks: KotBlock[] }
export type KotParseResult = { ok: true; template: KotTemplate } | { ok: false; errors: string[] };

/** One ticket, as the kitchen sees it. */
export interface KotTicket {
  outletName: string;
  tokenNo: number | null;
  /** The prep station of this ticket; null when the items have no station. */
  station: string | null;
  /** Ticket number within the order (1 = first; 2 and up print as ADD-ON). */
  kotNo: number;
  reprint: boolean;
  /** COUNTER, APP, WEBSITE, SWIGGY, ZOMATO. */
  channel: string;
  fulfilment: 'DELIVERY' | 'PICKUP' | null;
  /** The bill number when billed; the online order number (W-1042) for online orders. */
  orderNo: string | null;
  onlineNo: string | null;
  createdAt: number;
  cashierName: string | null;
  customerName: string | null;
  customerPhone: string | null;
  orderNote: string | null;
  lines: Array<{ name: string; qtyMilli: number; modifiers: Array<{ name: string }>; note: string | null; cancel: boolean }>;
}

export const KOT_PLACEHOLDERS: Record<string, string> = {
  'outlet.name': 'Shop name',
  'kot.token': 'Token number', 'kot.station': 'Prep station', 'kot.token-station': 'Token and station ("113 | TANDOOR")',
  'kot.no': 'Ticket number within the order (1, 2...)', 'kot.date': 'Date and time ("11 Oct, 01:20 PM")', 'kot.date-only': 'Date (11-10-2026)', 'kot.time': 'Time (13:20)',
  'kot.items': 'Number of item lines', 'kot.qty': 'Total quantity',
  'order.no': 'Bill number, or the online order number', 'order.type': 'COUNTER, or DELIVERY / PICKUP with the channel for online orders',
  'order.channel': 'Counter, App, Website, Swiggy or Zomato', 'order.note': 'Note for the whole order', 'online.no': 'Online order number (W-1042)',
  'customer.name': 'Customer name', 'customer.phone': 'Customer phone', 'cashier.name': 'Who sent the ticket',
};
const CHANNEL: Record<string, string> = { COUNTER: 'Counter', APP: 'App', WEBSITE: 'Website', SWIGGY: 'Swiggy', ZOMATO: 'Zomato', ONDC: 'ONDC', OTHER: 'Other' };
const PH = /\{\{\s*([a-z][a-z0-9.-]*)\s*\}\}/g;
const SIZES = ['normal', 'tall', 'wide', 'big'];
const ALIGNS = ['left', 'center', 'right'];
const RULE_CHARS = ['-', '=', '*', '_', '.', '~', '#'];
const STYLE = ['align', 'bold', 'size', 'if'];
const KEYS: Record<string, string[]> = { text: ['text', ...STYLE], field: ['label', 'value', ...STYLE], rule: ['char'], blank: ['lines'], 'kot-title': STYLE, items: ['size', 'bold', 'modifiers', 'notes'] };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Reads and checks a KOT design file. Errors are plain sentences. */
export function parseKotTemplate(text: string): KotParseResult {
  const errors: string[] = [];
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) return { ok: false, errors: ['The file is too large (more than 32 KB). Is this the right file?'] };
  let raw: unknown;
  try { raw = JSON.parse(text.replace(/^﻿/, '')); } catch (e) { return { ok: false, errors: [`This is not a KOT design file (it is not valid JSON: ${(e as Error).message}).`] }; }
  if (!isObj(raw) || raw.format !== 'tiffin-kot') return { ok: false, errors: ['This is not a KOT design file ("format" must be "tiffin-kot").'] };
  if (raw.version !== 1) return { ok: false, errors: [`This KOT design is version ${String(raw.version)}; this POS reads version 1.`] };
  for (const k of Object.keys(raw)) if (!['format', 'version', 'name', 'description', 'blocks'].includes(k)) errors.push(`Unknown setting "${k}" at the top of the file.`);
  if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 60) errors.push('"name" must be text of 1 to 60 characters.');
  if (raw.description !== undefined && (typeof raw.description !== 'string' || raw.description.length > 300)) errors.push('"description" must be text of at most 300 characters.');
  if (!Array.isArray(raw.blocks) || raw.blocks.length === 0 || raw.blocks.length > 80) return { ok: false, errors: [...errors, '"blocks" must be a list of 1 to 80 blocks.'] };
  const placeholders = (s: string, where: string) => {
    for (const m of s.matchAll(PH)) if (!(m[1]! in KOT_PLACEHOLDERS)) errors.push(`${where}: unknown placeholder {{${m[1]}}}. Known ones: ${Object.keys(KOT_PLACEHOLDERS).join(', ')}.`);
  };
  const textOk = (v: unknown, max: number, where: string, what: string, allowEmpty = false): v is string => {
    if (typeof v !== 'string' || (!allowEmpty && !v.trim()) || v.length > max) { errors.push(`${where}: "${what}" must be text of ${allowEmpty ? 0 : 1} to ${max} characters.`); return false; }
    return true;
  };
  let items = 0;
  raw.blocks.forEach((b: unknown, i: number) => {
    const where = `Block ${i + 1}`;
    if (!isObj(b) || typeof b.type !== 'string' || !(b.type in KEYS)) { errors.push(`${where}: unknown block type ${isObj(b) ? JSON.stringify(b.type) : ''}. Known types: ${Object.keys(KEYS).join(', ')}.`); return; }
    const w = `${where} (${b.type})`;
    for (const k of Object.keys(b)) if (k !== 'type' && !KEYS[b.type]!.includes(k)) errors.push(`${w}: unknown setting "${k}".`);
    if (b.align !== undefined && !ALIGNS.includes(String(b.align))) errors.push(`${w}: "align" must be left, center or right.`);
    if (b.size !== undefined && !SIZES.includes(String(b.size))) errors.push(`${w}: "size" must be normal, tall, wide or big.`);
    if (b.bold !== undefined && typeof b.bold !== 'boolean') errors.push(`${w}: "bold" must be true or false.`);
    if (b.if !== undefined && !(typeof b.if === 'string' && b.if in KOT_PLACEHOLDERS)) errors.push(`${w}: "if" must name a placeholder, for example "kot.token".`);
    if (b.type === 'text' && textOk(b.text, 200, w, 'text')) placeholders(b.text, w);
    if (b.type === 'field') { if (textOk(b.label, 60, w, 'label', true)) placeholders(b.label, w); if (textOk(b.value, 100, w, 'value')) placeholders(b.value, w); }
    if (b.type === 'rule' && b.char !== undefined && !RULE_CHARS.includes(String(b.char))) errors.push(`${w}: "char" must be one of ${RULE_CHARS.join(' ')}.`);
    if (b.type === 'blank' && b.lines !== undefined && !(Number.isInteger(b.lines) && (b.lines as number) >= 1 && (b.lines as number) <= 5)) errors.push(`${w}: "lines" must be 1 to 5.`);
    if (b.type === 'items') {
      items++;
      for (const k of ['modifiers', 'notes']) if (b[k] !== undefined && typeof b[k] !== 'boolean') errors.push(`${w}: "${k}" must be true or false.`);
    }
  });
  if (items !== 1) errors.push('A KOT design needs exactly one "items" block (the kitchen must see what to make).');
  return errors.length ? { ok: false, errors } : { ok: true, template: raw as unknown as KotTemplate };
}

const IST = 330 * 60_000;
const p2 = (n: number) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function when(ms: number) {
  const d = new Date(ms + IST);
  const h = d.getUTCHours(), h12 = h % 12 || 12;
  return {
    pretty: `${p2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]}, ${p2(h12)}:${p2(d.getUTCMinutes())} ${h < 12 ? 'AM' : 'PM'}`,
    date: `${p2(d.getUTCDate())}-${p2(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`, time: `${p2(h)}:${p2(d.getUTCMinutes())}`,
  };
}

/** Prints a ticket with a design. The safety marks print at the kot-title block, or at the top when the design has none. */
export function renderKot(t: KotTemplate, k: KotTicket, o: { cols: number }): Uint8Array {
  const p = new EscPos(o.cols).init();
  const w = when(k.createdAt);
  const online = k.channel !== 'COUNTER';
  const station = k.station ?? '';
  const values: Record<string, string> = {
    'outlet.name': k.outletName, 'kot.token': k.tokenNo !== null ? String(k.tokenNo) : '', 'kot.station': station,
    'kot.token-station': [k.tokenNo !== null ? String(k.tokenNo) : '', station].filter(Boolean).join(' | '),
    'kot.no': String(k.kotNo), 'kot.date': w.pretty, 'kot.date-only': w.date, 'kot.time': w.time,
    'kot.items': String(k.lines.length), 'kot.qty': formatQty(k.lines.reduce((s, l) => s + l.qtyMilli, 0)),
    'order.no': k.orderNo ?? '', 'order.type': online ? [CHANNEL[k.channel] ?? k.channel, k.fulfilment ?? ''].filter(Boolean).join(' - ').toUpperCase() : 'COUNTER',
    'order.channel': CHANNEL[k.channel] ?? k.channel, 'order.note': k.orderNote ?? '', 'online.no': online ? k.onlineNo ?? '' : '',
    'customer.name': k.customerName ?? '', 'customer.phone': k.customerPhone ?? '', 'cashier.name': k.cashierName ?? '',
  };
  const fill = (s: string) => s.replace(PH, (_, n: string) => values[n] ?? '');
  const names = (s: string) => [...s.matchAll(PH)].map((m) => m[1]!);
  const empty = (s: string) => { const n = names(s); return n.length > 0 && n.every((x) => !values[x]); };
  const styled = (s: Style, body: () => void) => {
    if (s.if && !values[s.if]) return;
    const [sw, sh] = s.size === 'big' ? [2, 2] : s.size === 'tall' ? [1, 2] : s.size === 'wide' ? [2, 1] : [1, 1];
    if (sw !== 1 || sh !== 1) p.size(sw, sh);
    if (s.bold) p.bold(true);
    body();
    if (s.bold) p.bold(false);
    if (sw !== 1 || sh !== 1) p.size(1, 1);
  };
  const aligned = (s: string, a: Align = 'left') => { for (const part of s.split('\n')) { if (a === 'center') p.center(part); else if (a === 'right') p.right(part); else p.wrapped(part); } };
  const marks = (s: Style) => {
    const list = [k.reprint ? '*** REPRINT ***' : '', k.kotNo > 1 ? `ADD-ON KOT ${k.kotNo}` : ''].filter(Boolean);
    if (list.length) styled({ align: 'center', bold: true, ...s }, () => list.forEach((m) => aligned(m, s.align ?? 'center')));
  };
  if (!t.blocks.some((b) => b.type === 'kot-title')) marks({});
  for (const b of t.blocks) {
    switch (b.type) {
      case 'text': if (!empty(b.text)) styled(b, () => aligned(fill(b.text), b.align)); break;
      case 'field': {
        if (empty(b.value)) break;
        styled(b, () => {
          const label = empty(b.label) ? '' : fill(b.label), value = fill(b.value).replace(/\n/g, ', ');
          if (!label) aligned(value, b.align ?? 'left');
          else if (sanitize(label).length + sanitize(value).length + 1 > p.width()) { p.wrapped(label); p.right(value); } else p.twoCol(label, value);
        });
        break;
      }
      case 'rule': p.rule(b.char ?? '-'); break;
      case 'blank': for (let i = 0; i < (b.lines ?? 1); i++) p.line(''); break;
      case 'kot-title': marks(b); break;
      case 'items':
        styled({ size: b.size, bold: b.bold }, () => {
          for (const l of k.lines) {
            if (l.cancel) { p.bold(true).wrapped(`CANCEL ${formatQty(l.qtyMilli)} x ${l.name}`); if (!b.bold) p.bold(false); continue; }
            p.wrapped(`${formatQty(l.qtyMilli)} x ${l.name}`);
            if (b.modifiers !== false) for (const m of l.modifiers) p.wrapped(`+ ${m.name}`, 2);
            if (b.notes !== false && l.note) p.wrapped(`>> ${l.note}`, 2);
          }
        });
        break;
    }
  }
  p.feed(3).cut();
  return p.bytes();
}

/** The sample ticket for previews (the shop's photo, roughly). */
export function sampleKot(now: number, outletName = 'Spice Route Kitchen'): KotTicket {
  return {
    outletName, tokenNo: 113, station: 'TANDOOR', kotNo: 1, reprint: false, channel: 'COUNTER', fulfilment: null, orderNo: 'A1/26-27/000029', onlineNo: null,
    createdAt: now, cashierName: 'Asha', customerName: null, customerPhone: null, orderNote: null,
    lines: [
      { name: 'Tandoori Roti', qtyMilli: 4000, modifiers: [], note: null, cancel: false },
      { name: 'Hara Bhara Kabab', qtyMilli: 1000, modifiers: [], note: 'Less spicy', cancel: false },
      { name: 'Paneer Tikka', qtyMilli: 1000, modifiers: [], note: null, cancel: false },
    ],
  };
}
