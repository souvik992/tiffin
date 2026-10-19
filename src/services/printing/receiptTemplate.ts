import { EscPos, needsPicture, sanitize, wrapText } from './escpos.ts';
import { visibleLength } from './textPicture.ts';
import type { Seg } from './textPicture.ts';
import type { ReceiptData, ReceiptOptions } from './receipt.ts';
import { formatINR, formatQty } from '../../core/money.ts';

/**
 * Receipt design files (.tiffinreceipt): a shop's own bill layout, described as data.
 *
 * A file is JSON: { "format": "tiffin-receipt", "version": 1, "name": ..., "blocks": [...] }. It can only arrange
 * what the backend already computed: it cannot run code or calculate anything, and every amount is a backend value
 * formatted for print. A design must keep what a GST bill needs (title, number, date, GSTIN, items, GST, total), and
 * the renderer always adds the safety marks (SAMPLE, CANCELLED, DUPLICATE, CREDIT NOTE) and the feed and cut.
 * Reference and examples: docs/RECEIPT_TEMPLATES.md and templates/receipt/.
 */

export const TEMPLATE_EXT = '.tiffinreceipt';
export const MAX_TEMPLATE_BYTES = 64 * 1024;

type Align = 'left' | 'center' | 'right';
type Size = 'normal' | 'tall' | 'wide' | 'big';
interface Style { align?: Align; bold?: boolean; size?: Size; if?: string }
export type ItemField = 'sno' | 'name' | 'qty' | 'rate' | 'amount' | 'hsn' | 'gst';
export type TotalRow = 'subtotal' | 'discount' | 'taxable' | 'gst' | 'cess' | 'roundoff' | 'tax-total' | 'total-qty';
interface Column { field: ItemField; label?: string; width?: number | '*'; align?: 'left' | 'right'; decimals?: number }
interface InfoColumn { label: string; value: string }

export type Block =
  | ({ type: 'text'; text: string } & Style)
  | ({ type: 'field'; label: string; value: string } & Style)
  | { type: 'rule'; char?: string }
  | { type: 'blank'; lines?: number }
  | ({ type: 'doc-title' } & Style)
  | { type: 'items'; columns: Column[]; header?: boolean; modifiers?: boolean; notes?: boolean }
  | { type: 'totals'; rows: Array<TotalRow | { row: TotalRow; label: string }> }
  | ({ type: 'grand-total'; label?: string; refundLabel?: string } & Style)
  | { type: 'tax-table' }
  | { type: 'payments'; change?: boolean }
  | ({ type: 'qr'; data: string; size?: number } & Pick<Style, 'align' | 'if'>)
  | ({ type: 'footer' } & Style)
  | { type: 'logo' }
  | { type: 'info-table'; columns: InfoColumn[]; rule?: boolean };

export interface ReceiptTemplate {
  format: 'tiffin-receipt'; version: 1; name: string; description?: string;
  money?: { symbol?: string };
  blocks: Block[];
}

export type ParseResult = { ok: true; template: ReceiptTemplate } | { ok: false; errors: string[] };

// ---------------------------------------------------------------- placeholders

export const PLACEHOLDERS: Record<string, string> = {
  'outlet.name': 'Shop name', 'outlet.address': 'Shop address', 'outlet.phone': 'Shop phone', 'outlet.gstin': 'Shop GSTIN', 'outlet.fssai': 'FSSAI licence number',
  'invoice.no': 'Bill number', 'invoice.date': 'Date and time (15-10-2026 19:43)', 'invoice.date-only': 'Date (15-10-2026)', 'invoice.time': 'Time (19:43)',
  'invoice.token': 'Token number', 'invoice.against': 'Original bill number (credit notes)', 'invoice.buyer-gstin': "Customer's GSTIN",
  'invoice.total': 'Bill total', 'invoice.items': 'Number of item lines', 'cashier.name': 'Cashier name',
  'customer.name': 'Customer name (typed on the bill)', 'customer.phone': 'Customer phone', 'order.channel': 'Where the order came from (App, Website, Swiggy, Zomato; empty at the counter)',
};
const CHANNEL_LABEL: Record<string, string> = { APP: 'App', WEBSITE: 'Website', SWIGGY: 'Swiggy', ZOMATO: 'Zomato' };
const PH = /\{\{\s*([a-z][a-z0-9.-]*)\s*\}\}/g;

const IST = 330 * 60_000;
const p2 = (n: number) => String(n).padStart(2, '0');
function istParts(ms: number) {
  const d = new Date(ms + IST);
  return { date: `${p2(d.getUTCDate())}-${p2(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`, time: `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}` };
}

// ---------------------------------------------------------------- validation

const SIZES = ['normal', 'tall', 'wide', 'big'];
const ALIGNS = ['left', 'center', 'right'];
const FIELDS: ItemField[] = ['sno', 'name', 'qty', 'rate', 'amount', 'hsn', 'gst'];
const TOTALS: TotalRow[] = ['subtotal', 'discount', 'taxable', 'gst', 'cess', 'roundoff', 'tax-total', 'total-qty'];
const RULE_CHARS = ['-', '=', '*', '_', '.', '~', '#'];
const SYMBOLS = ['', 'Rs', 'Rs.', 'INR', '₹']; // the rupee sign prints as a picture (textPicture.ts), or as "Rs" where it cannot be drawn
const STYLE_KEYS = ['align', 'bold', 'size', 'if'];
const KEYS: Record<string, string[]> = {
  text: ['text', ...STYLE_KEYS], field: ['label', 'value', ...STYLE_KEYS], rule: ['char'], blank: ['lines'], 'doc-title': STYLE_KEYS,
  items: ['columns', 'header', 'modifiers', 'notes'], totals: ['rows'], 'grand-total': ['label', 'refundLabel', ...STYLE_KEYS], 'tax-table': [],
  payments: ['change'], qr: ['data', 'size', 'align', 'if'], footer: STYLE_KEYS, logo: [], 'info-table': ['columns', 'rule'],
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Reads and checks a design file. Errors are plain sentences a developer (or the shop) can act on. */
export function parseTemplate(text: string): ParseResult {
  const errors: string[] = [];
  if (Buffer.byteLength(text, 'utf8') > MAX_TEMPLATE_BYTES) return { ok: false, errors: ['The file is too large (more than 64 KB). Is this the right file?'] };
  let raw: unknown;
  try { raw = JSON.parse(text.replace(/^﻿/, '')); } catch (e) { return { ok: false, errors: [`This is not a receipt design file (it is not valid JSON: ${(e as Error).message}).`] }; }
  if (!isObj(raw) || raw.format !== 'tiffin-receipt') return { ok: false, errors: ['This is not a receipt design file ("format" must be "tiffin-receipt").'] };
  if (raw.version !== 1) return { ok: false, errors: [`This design file is version ${String(raw.version)}; this POS reads version 1. Update the POS or ask for a version 1 file.`] };
  for (const k of Object.keys(raw)) if (!['format', 'version', 'name', 'description', 'money', 'blocks'].includes(k)) errors.push(`Unknown setting "${k}" at the top of the file.`);
  if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 60) errors.push('"name" must be text of 1 to 60 characters.');
  if (raw.description !== undefined && (typeof raw.description !== 'string' || raw.description.length > 300)) errors.push('"description" must be text of at most 300 characters.');
  if (raw.money !== undefined) {
    if (!isObj(raw.money) || Object.keys(raw.money).some((k) => k !== 'symbol') || (raw.money.symbol !== undefined && !SYMBOLS.includes(String(raw.money.symbol)))) {
      errors.push(`"money" may only have "symbol", one of: ${SYMBOLS.map((s) => `"${s}"`).join(', ')}.`);
    }
  }
  if (!Array.isArray(raw.blocks) || raw.blocks.length === 0 || raw.blocks.length > 150) {
    errors.push('"blocks" must be a list of 1 to 150 blocks.');
    return { ok: false, errors };
  }

  const used = new Set<string>();
  const types = new Set<string>();
  let hasGst = false;
  const placeholders = (s: string, where: string) => {
    for (const m of s.matchAll(PH)) {
      if (!(m[1]! in PLACEHOLDERS)) errors.push(`${where}: unknown placeholder {{${m[1]}}}. Known ones: ${Object.keys(PLACEHOLDERS).join(', ')}.`);
      else used.add(m[1]!);
    }
  };
  const textOk = (v: unknown, max: number, where: string, what: string, allowEmpty = false): v is string => {
    if (typeof v !== 'string' || (!allowEmpty && v.trim() === '') || v.length > max) { errors.push(`${where}: "${what}" must be text of ${allowEmpty ? 0 : 1} to ${max} characters.`); return false; }
    return true;
  };

  raw.blocks.forEach((b: unknown, i: number) => {
    const where = `Block ${i + 1}`;
    if (!isObj(b) || typeof b.type !== 'string' || !(b.type in KEYS)) { errors.push(`${where}: unknown block type ${isObj(b) ? JSON.stringify(b.type) : ''}. Known types: ${Object.keys(KEYS).join(', ')}.`); return; }
    const w = `${where} (${b.type})`;
    types.add(b.type);
    for (const k of Object.keys(b)) if (k !== 'type' && !KEYS[b.type]!.includes(k)) errors.push(`${w}: unknown setting "${k}".`);
    if (b.align !== undefined && !ALIGNS.includes(String(b.align))) errors.push(`${w}: "align" must be left, center or right.`);
    if (b.size !== undefined && b.type !== 'qr' && !SIZES.includes(String(b.size))) errors.push(`${w}: "size" must be normal, tall, wide or big.`);
    if (b.bold !== undefined && typeof b.bold !== 'boolean') errors.push(`${w}: "bold" must be true or false.`);
    if (b.if !== undefined && !(typeof b.if === 'string' && b.if in PLACEHOLDERS)) errors.push(`${w}: "if" must name a placeholder, for example "invoice.token".`);
    switch (b.type) {
      case 'text': if (textOk(b.text, 300, w, 'text')) placeholders(b.text, w); break;
      case 'field':
        if (textOk(b.label, 40, w, 'label', true)) placeholders(b.label, w);
        if (textOk(b.value, 200, w, 'value')) placeholders(b.value, w);
        break;
      case 'rule': if (b.char !== undefined && !RULE_CHARS.includes(String(b.char))) errors.push(`${w}: "char" must be one of ${RULE_CHARS.join(' ')}.`); break;
      case 'blank': if (b.lines !== undefined && !(Number.isInteger(b.lines) && (b.lines as number) >= 1 && (b.lines as number) <= 5)) errors.push(`${w}: "lines" must be 1 to 5.`); break;
      case 'grand-total':
        if (b.label !== undefined) textOk(b.label, 30, w, 'label');
        if (b.refundLabel !== undefined) textOk(b.refundLabel, 30, w, 'refundLabel');
        break;
      case 'payments': if (b.change !== undefined && typeof b.change !== 'boolean') errors.push(`${w}: "change" must be true or false.`); break;
      case 'qr':
        if (textOk(b.data, 300, w, 'data') && b.data !== 'upi') placeholders(b.data, w);
        if (b.size !== undefined && !(Number.isInteger(b.size) && (b.size as number) >= 3 && (b.size as number) <= 8)) errors.push(`${w}: "size" must be 3 to 8.`);
        break;
      case 'tax-table': hasGst = true; break;
      case 'info-table':
        if (!Array.isArray(b.columns) || b.columns.length < 2 || b.columns.length > 6) { errors.push(`${w}: "columns" must be a list of 2 to 6 columns like {"label": "Bill No", "value": "{{invoice.no}}"}.`); break; }
        for (const c of b.columns as unknown[]) {
          if (!isObj(c) || Object.keys(c).some((k) => k !== 'label' && k !== 'value')) { errors.push(`${w}: each column has only "label" and "value".`); continue; }
          if (textOk(c.label, 20, w, 'label')) placeholders(c.label, w);
          if (textOk(c.value, 60, w, 'value')) placeholders(c.value, w);
        }
        if (b.rule !== undefined && typeof b.rule !== 'boolean') errors.push(`${w}: "rule" must be true or false.`);
        break;
      case 'totals':
        if (!Array.isArray(b.rows) || b.rows.length === 0 || b.rows.length > 10) { errors.push(`${w}: "rows" must be a list of 1 to 10 of: ${TOTALS.join(', ')}.`); break; }
        for (const r of b.rows as unknown[]) {
          const row = isObj(r) ? r.row : r;
          if (!TOTALS.includes(row as TotalRow)) errors.push(`${w}: unknown total row ${JSON.stringify(row)}. Known: ${TOTALS.join(', ')}.`);
          if (isObj(r) && (Object.keys(r).some((k) => k !== 'row' && k !== 'label') || typeof r.label !== 'string' || !r.label.trim() || r.label.length > 30)) errors.push(`${w}: a total row with a label looks like {"row": "subtotal", "label": "Sub Total"} (label up to 30 characters).`);
          if (row === 'gst' || row === 'tax-total') hasGst = true;
        }
        break;
      case 'items': {
        if (!Array.isArray(b.columns) || b.columns.length === 0 || b.columns.length > 7) { errors.push(`${w}: "columns" must be a list of 1 to 7 columns.`); break; }
        let flex = 0, hasName = false, hasAmount = false;
        for (const c of b.columns as unknown[]) {
          if (!isObj(c) || !FIELDS.includes(c.field as ItemField)) { errors.push(`${w}: each column needs "field", one of: ${FIELDS.join(', ')}.`); continue; }
          for (const k of Object.keys(c)) if (!['field', 'label', 'width', 'align', 'decimals'].includes(k)) errors.push(`${w}: unknown column setting "${k}".`);
          if (c.label !== undefined && (typeof c.label !== 'string' || c.label.length > 20)) errors.push(`${w}: column "label" must be text of at most 20 characters.`);
          if (c.width === '*') flex++;
          else if (c.width !== undefined && !(Number.isInteger(c.width) && (c.width as number) >= 2 && (c.width as number) <= 30)) errors.push(`${w}: column "width" must be 2 to 30 characters, or "*" for the column that takes the rest.`);
          if (c.align !== undefined && c.align !== 'left' && c.align !== 'right') errors.push(`${w}: column "align" must be left or right.`);
          if (c.decimals !== undefined && (c.field !== 'qty' || !(Number.isInteger(c.decimals) && (c.decimals as number) >= 0 && (c.decimals as number) <= 3))) errors.push(`${w}: "decimals" (0 to 3) is only for the "qty" column.`);
          if (c.field === 'name') hasName = true;
          if (c.field === 'amount') hasAmount = true;
        }
        if (flex > 1) errors.push(`${w}: only one column can have width "*".`);
        if (!hasName || !hasAmount) errors.push(`${w}: the item table must show the item "name" and its "amount".`);
        for (const k of ['header', 'modifiers', 'notes']) if (b[k] !== undefined && typeof b[k] !== 'boolean') errors.push(`${w}: "${k}" must be true or false.`);
        break;
      }
    }
  });

  // What a GST bill must show. The renderer cannot add these in the right place, so a design without them is refused.
  const missing: string[] = [];
  if (!types.has('doc-title')) missing.push('a "doc-title" block (prints TAX INVOICE / CREDIT NOTE)');
  if (!used.has('invoice.no')) missing.push('the bill number {{invoice.no}}');
  if (!used.has('invoice.date') && !used.has('invoice.date-only')) missing.push('the date {{invoice.date}} or {{invoice.date-only}}');
  if (!used.has('outlet.gstin')) missing.push("the shop's GSTIN {{outlet.gstin}} (it is left out automatically when the shop has none)");
  if (!types.has('items')) missing.push('an "items" block');
  if (!hasGst) missing.push('the GST amounts (a "tax-table" block, or "gst" in a "totals" block)');
  if (!types.has('grand-total')) missing.push('a "grand-total" block');
  if (missing.length) errors.push(`A GST bill must show: ${missing.join('; ')}.`);

  return errors.length ? { ok: false, errors } : { ok: true, template: raw as unknown as ReceiptTemplate };
}

// ---------------------------------------------------------------- rendering

const MODE: Record<string, string> = { CASH: 'Cash', UPI: 'UPI', CARD: 'Card', WALLET: 'Wallet', CREDIT: 'Credit', OTHER: 'Other' };
const rateText = (bp: number) => `${bp / 100}%`.replace(/(\.\d)0+%/, '$1%');
const rupeesPlain = (p: number) => `${Math.trunc(p / 100)}.${p2(p % 100)}`;

export interface TemplateExtras { upiId?: string }

export function renderTemplate(t: ReceiptTemplate, d: ReceiptData, o: ReceiptOptions, x: TemplateExtras = {}): Uint8Array {
  const p = new EscPos(o.cols).init();
  const sym = t.money?.symbol ?? '';
  const money = (v: number) => (sym ? `${sym} ` : '') + formatINR(v, '');
  const signed = (v: number) => (v < 0 ? '-' : '') + money(Math.abs(v));
  const credit = d.invoice.docType === 'CREDIT_NOTE';
  const when = istParts(d.invoice.issuedAt);
  const values: Record<string, string> = {
    'outlet.name': d.outlet.name, 'outlet.address': d.outlet.address ?? '', 'outlet.phone': d.outlet.phone ?? '', 'outlet.gstin': d.outlet.gstin ?? '', 'outlet.fssai': d.outlet.fssaiNo ?? '',
    'invoice.no': d.invoice.invoiceNo, 'invoice.date': `${when.date} ${when.time}`, 'invoice.date-only': when.date, 'invoice.time': when.time,
    'invoice.token': d.invoice.tokenNo !== null && !credit ? String(d.invoice.tokenNo) : '', 'invoice.against': d.invoice.originalInvoiceNo ?? '',
    'invoice.buyer-gstin': d.invoice.buyerGstin ?? '', 'invoice.total': money(d.invoice.grandTotal), 'invoice.items': String(d.lines.length), 'cashier.name': d.cashierName,
    'customer.name': d.customer?.name ?? '', 'customer.phone': d.customer?.phone ?? '', 'order.channel': CHANNEL_LABEL[d.channel ?? ''] ?? '',
  };
  const fill = (s: string) => s.replace(PH, (_, k: string) => values[k] ?? '');
  // A line whose placeholders are all empty is left out (for example "FSSAI: {{outlet.fssai}}" when there is none).
  const emptyFill = (s: string) => { const names = [...s.matchAll(PH)].map((m) => m[1]!); return names.length > 0 && names.every((k) => !values[k]); };
  const styled = (s: Style, body: () => void) => {
    if (s.if && !values[s.if]) return;
    const [w, h] = s.size === 'big' ? [2, 2] : s.size === 'tall' ? [1, 2] : s.size === 'wide' ? [2, 1] : [1, 1];
    if (w !== 1 || h !== 1) p.size(w, h);
    if (s.bold) p.bold(true);
    body();
    if (s.bold) p.bold(false);
    if (w !== 1 || h !== 1) p.size(1, 1);
  };
  const aligned = (s: string, align: Align = 'left') => {
    for (const part of s.split('\n')) { // multi-line values (an address) keep their lines
      if (align === 'center') p.center(part);
      else if (align === 'right') p.right(part);
      else p.wrapped(part);
    }
  };
  const qtyDecimals = t.blocks.flatMap((b) => (b.type === 'items' ? b.columns : [])).find((c) => c.field === 'qty')?.decimals;
  const qty = (milli: number) => fixedQty(milli, qtyDecimals);

  for (const b of t.blocks) {
    switch (b.type) {
      case 'text': if (!emptyFill(b.text)) styled(b, () => aligned(fill(b.text), b.align)); break;
      case 'field': {
        if (emptyFill(b.value)) break;
        styled(b, () => {
          const label = fill(b.label), value = fill(b.value).replace(/\n/g, ', ');
          if (sanitize(label).length + sanitize(value).length + 1 > p.width()) { if (label) p.wrapped(label); p.right(value); } else p.twoCol(label, value);
        });
        break;
      }
      case 'rule': p.rule(b.char ?? '-'); break;
      case 'blank': for (let i = 0; i < (b.lines ?? 1); i++) p.line(''); break;
      case 'doc-title': styled({ align: 'center', bold: true, ...b }, () => {
        aligned(o.sample ? 'SAMPLE - NOT A BILL' : credit ? 'CREDIT NOTE' : 'TAX INVOICE', b.align ?? 'center');
        if (d.invoice.status === 'CANCELLED') aligned('*** CANCELLED ***', b.align ?? 'center');
        if (o.copyNo > 1) aligned('*** DUPLICATE ***', b.align ?? 'center');
      }); break;
      case 'items': itemsTable(p, b, d, money); break;
      case 'logo': if (o.logo && o.logo.width <= Math.floor(o.cols * 12 / 8) * 8) p.logo(o.logo.width, o.logo.height, o.logo.data); break;
      case 'info-table': infoTable(p, b, fill, b.rule ?? true); break;
      case 'totals': for (const r of b.rows) {
        const row = typeof r === 'string' ? r : r.row, label = typeof r === 'string' ? null : r.label;
        const inv = d.invoice;
        if (row === 'subtotal') p.twoCol(label ?? 'Subtotal', money(inv.grossTotal));
        else if (row === 'discount') { if (inv.discountTotal > 0) p.twoCol(label ?? 'Discount', `-${money(inv.discountTotal)}`); }
        else if (row === 'taxable') p.twoCol(label ?? 'Taxable value', money(inv.taxableTotal));
        else if (row === 'gst') for (const g of gstByRate(d)) {
          if (g.igst > 0) p.twoCol(`IGST @${rateText(g.bp)}`, money(g.igst));
          else { p.twoCol(`CGST @${rateText(g.bp / 2)}`, money(g.cgst)); p.twoCol(`SGST @${rateText(g.bp / 2)}`, money(g.sgst)); }
        }
        else if (row === 'cess') { if (inv.cess > 0) p.twoCol(label ?? 'Cess', money(inv.cess)); }
        else if (row === 'roundoff') { if (inv.roundOff !== 0) p.twoCol(label ?? 'Round off', signed(inv.roundOff)); }
        else if (row === 'tax-total') p.twoCol(label ?? 'Total GST', money(inv.cgst + inv.sgst + inv.igst + inv.cess));
        else if (row === 'total-qty') p.twoCol(label ?? 'Total quantity', qty(d.lines.reduce((s, l) => s + l.qtyMilli, 0)));
      } break;
      case 'grand-total': styled({ size: 'tall', bold: true, ...b }, () => p.twoCol(credit ? (b.refundLabel ?? 'REFUND') : (b.label ?? 'TOTAL'), money(d.invoice.grandTotal))); break;
      case 'tax-table': taxTable(p, d, money); break;
      case 'payments': for (const pay of d.payments) {
        p.twoCol(MODE[pay.mode] ?? pay.mode, money(pay.amount));
        if ((b.change ?? true) && pay.mode === 'CASH' && pay.tendered !== null && pay.tendered > pay.amount) {
          p.twoCol('  Tendered', money(pay.tendered));
          p.twoCol('  Change', money(pay.tendered - pay.amount));
        }
      } break;
      case 'qr': {
        if (b.if && !values[b.if]) break;
        let data: string;
        if (b.data === 'upi') {
          if (!x.upiId || credit || d.invoice.status === 'CANCELLED') break; // never ask for money on a refund or a cancelled bill
          data = `upi://pay?pa=${encodeURIComponent(x.upiId)}&pn=${encodeURIComponent(d.outlet.name).slice(0, 60)}&am=${rupeesPlain(d.invoice.grandTotal)}&cu=INR&tn=${encodeURIComponent(d.invoice.invoiceNo)}`;
        } else {
          if (emptyFill(b.data)) break;
          data = fill(b.data);
        }
        if (sanitize(data).length > 400) break;
        if (b.align === 'left') p.raw(0x1b, 0x61, 0); else if (b.align === 'right') p.raw(0x1b, 0x61, 2); else p.raw(0x1b, 0x61, 1);
        p.qr(data, b.size ?? 6).line('').raw(0x1b, 0x61, 0);
        break;
      }
      case 'footer': if (o.footer) styled(b, () => aligned(o.footer, b.align ?? 'center')); break;
    }
  }
  p.feed(3);
  if (o.drawer) p.drawerKick();
  p.cut();
  return p.bytes();
}

/** Quantity with a fixed number of decimals (1000 -> "1.000" with 3), or as short as possible when not set. */
function fixedQty(milli: number, decimals?: number): string {
  if (decimals === undefined) return formatQty(milli);
  const whole = Math.trunc(milli / 1000), frac = String(Math.abs(milli % 1000)).padStart(3, '0').slice(0, decimals);
  return decimals ? `${whole}.${frac}` : String(whole);
}

/** Labels on one line, values under them (like "Bill No  Waiter  Date  Time"). When it does not fit, one "label: value" line each. */
function infoTable(p: EscPos, b: Extract<Block, { type: 'info-table' }>, fill: (s: string) => string, rule: boolean) {
  const cols = b.columns.map((c) => ({ label: sanitize(fill(c.label)), value: sanitize(fill(c.value).replace(/\n/g, ' ')) }));
  const widths = cols.map((c) => Math.max(c.label.length, c.value.length));
  const used = widths.reduce((s, w) => s + w, 0);
  const room = p.width() - used;
  if (room < cols.length - 1) {
    for (const c of cols) if (c.value) p.twoCol(c.label, c.value);
    return;
  }
  const gap = Math.floor(room / (cols.length - 1)), extra = room - gap * (cols.length - 1);
  const row = (vals: string[]) => p.line(vals.map((v, i) => (i === vals.length - 1 ? v.padStart(widths[i]! + extra) : v.padEnd(widths[i]! + gap))).join(''));
  row(cols.map((c) => c.label));
  if (rule) p.rule('-');
  row(cols.map((c) => c.value));
}

function gstByRate(d: ReceiptData) {
  const m = new Map<number, { bp: number; taxable: number; cgst: number; sgst: number; igst: number }>();
  for (const l of d.lines) {
    if (l.rateBp === 0) continue;
    const r = m.get(l.rateBp) ?? { bp: l.rateBp, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    r.taxable += l.taxable; r.cgst += l.cgst; r.sgst += l.sgst; r.igst += l.igst; // sums of backend line amounts (integers), as the standard receipt does
    m.set(l.rateBp, r);
  }
  return [...m.values()].sort((a, b) => a.bp - b.bp);
}

const pad = (s: string, w: number, right: boolean) => (right ? s.padStart(w) : s.padEnd(w));

/** A table that always fits: fixed columns grow to their widest value; the "*" column (the name) takes the rest.
 * When the name would get fewer than 12 characters, each item prints on two lines: name, then the numbers. */
function itemsTable(p: EscPos, b: Extract<Block, { type: 'items' }>, d: ReceiptData, money: (v: number) => string) {
  const cols = p.width();
  const cell = (f: ItemField, l: ReceiptData['lines'][number], i: number): string => {
    switch (f) {
      case 'sno': return String(i + 1);
      case 'name': return l.name;
      case 'qty': return fixedQty(l.qtyMilli, b.columns.find((c) => c.field === 'qty')?.decimals);
      case 'rate': return money(l.unitPrice);
      case 'amount': return money(l.lineTotal);
      case 'hsn': return l.hsnCode ?? '';
      case 'gst': return rateText(l.rateBp);
    }
  };
  const defaults: Record<ItemField, string> = { sno: '#', name: 'Item', qty: 'Qty', rate: 'Rate', amount: 'Amount', hsn: 'HSN', gst: 'GST' };
  const columns = b.columns.map((c) => ({ ...c, label: sanitize(c.label ?? defaults[c.field]), right: c.align ? c.align === 'right' : c.field !== 'name' && c.field !== 'hsn' }));
  const flexIdx = Math.max(0, columns.findIndex((c) => c.width === '*' || (c.field === 'name' && !columns.some((x) => x.width === '*'))));
  // item names in Hindi or other scripts (and amounts with a rupee sign) are kept: their row prints as a picture
  const keep = (s: string) => (needsPicture(s) ? s : sanitize(s));
  const widths = columns.map((c, i) => i === flexIdx ? 0 : Math.max(typeof c.width === 'number' ? c.width : 0, b.header === false ? 0 : c.label.length, ...d.lines.map((l, j) => visibleLength(keep(cell(c.field, l, j))))));
  const fixed = widths.reduce((s, w, i) => (i === flexIdx ? s : s + w + 1), 0);
  const flex = cols - fixed;
  const stacked = flex < 12; // a name column narrower than 12 characters is hard to read
  const row = (vals: string[]) => {
    if (!stacked && vals.some(needsPicture)) {
      const segs: Seg[] = [];
      let at = 0;
      vals.forEach((v, i) => { const w = i === flexIdx ? flex : widths[i]!; segs.push({ t: v, col: at, width: w, align: columns[i]!.right && i !== flexIdx ? 'r' : 'l' }); at += w + 1; });
      return p.segments(segs);
    }
    if (!stacked) return p.line(vals.map((v, i) => (i === flexIdx ? v.padEnd(flex) : pad(v, widths[i]!, columns[i]!.right))).join(' ').trimEnd());
    const rest = vals.filter((_, i) => i !== flexIdx).map((v, k) => pad(v, widths.filter((_, i) => i !== flexIdx)[k]!, columns.filter((_, i) => i !== flexIdx)[k]!.right)).join(' ');
    if (vals[flexIdx]) p.wrapped(vals[flexIdx]!);
    return p.right(rest);
  };
  if (b.header !== false) { row(columns.map((c) => c.label)); p.rule('-'); }
  d.lines.forEach((l, i) => {
    const vals = columns.map((c) => keep(cell(c.field, l, i)));
    if (!stacked && visibleLength(vals[flexIdx]!) > flex) {
      const parts = wrapText(vals[flexIdx]!, flex);
      row(vals.map((v, k) => (k === flexIdx ? parts[0]! : v)));
      const indent = widths.slice(0, flexIdx).reduce((s, w) => s + w + 1, 0);
      for (const part of parts.slice(1)) { if (needsPicture(part)) p.segments([{ t: part, col: indent, width: flex, align: 'l' }]); else p.line(' '.repeat(indent) + part); }
    } else row(vals);
    if (b.modifiers !== false) for (const m of l.modifiers) p.wrapped(`+ ${m.name}`, 2);
    if (b.notes !== false && l.note) p.wrapped(`Note: ${l.note}`, 2);
  });
}

function taxTable(p: EscPos, d: ReceiptData, money: (v: number) => string) {
  const rows = gstByRate(d);
  if (!rows.length) return;
  const igst = rows.some((r) => r.igst > 0);
  const head = igst ? ['GST', 'Taxable', 'IGST'] : ['GST', 'Taxable', 'CGST', 'SGST'];
  const body = rows.map((r) => (igst ? [rateText(r.bp), money(r.taxable), money(r.igst)] : [rateText(r.bp), money(r.taxable), money(r.cgst), money(r.sgst)]).map(sanitize));
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i]!.length)));
  const total = widths.reduce((s, w) => s + w, 0) + widths.length - 1;
  if (total > p.width()) { // too narrow for a table: one block per rate
    for (const r of rows) {
      p.line(`GST ${rateText(r.bp)} on ${money(r.taxable)}`);
      if (igst) p.twoCol('  IGST', money(r.igst)); else { p.twoCol('  CGST', money(r.cgst)); p.twoCol('  SGST', money(r.sgst)); }
    }
    return;
  }
  const gap = ' '.repeat(Math.max(1, Math.min(4, Math.floor((p.width() - total + widths.length - 1) / (widths.length - 1))))); // spread across the line
  const line = (v: string[]) => p.line(v.map((x, i) => (i === 0 ? x.padEnd(widths[i]!) : x.padStart(widths[i]!))).join(gap));
  line(head);
  for (const b of body) line(b);
}
