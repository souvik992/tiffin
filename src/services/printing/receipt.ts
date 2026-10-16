import { EscPos } from './escpos.ts';
import { formatINR, formatQty } from '../../core/money.ts';
import { istDateTime } from '../../core/numbering.ts';
import { renderTemplate } from './receiptTemplate.ts';
import type { ReceiptTemplate } from './receiptTemplate.ts';
import { DEFAULT_TEMPLATE } from './defaultTemplate.ts';

export interface ReceiptData {
  outlet: { name: string; address: string | null; gstin: string | null; fssaiNo: string | null; phone: string | null };
  invoice: {
    invoiceNo: string; docType: 'TAX_INVOICE' | 'CREDIT_NOTE'; status: string; issuedAt: number; tokenNo: number | null;
    grossTotal: number; discountTotal: number; taxableTotal: number; cgst: number; sgst: number; igst: number; cess: number;
    roundOff: number; grandTotal: number; buyerGstin: string | null; originalInvoiceNo?: string | null;
  };
  lines: Array<{ name: string; hsnCode?: string | null; qtyMilli: number; unitPrice: number; lineTotal: number; rateBp: number; taxable: number; cgst: number; sgst: number; igst: number; modifiers: Array<{ name: string; price: number }>; note: string | null }>;
  payments: Array<{ mode: string; amount: number; tendered: number | null }>;
  cashierName: string;
}
/** sample: printer-setup preview with made-up lines; titled "SAMPLE - NOT A BILL" so it can never pass as an invoice. */
export interface ReceiptOptions {
  cols: number; copyNo: number; footer: string; drawer: boolean; sample?: boolean;
  /** The shop's uploaded design (Settings > Receipt); null or absent: the standard layout. */
  template?: ReceiptTemplate | null; upiId?: string;
  /** Settings > Store logo (1-bit raster), printed by a design's "logo" block. */
  logo?: { width: number; height: number; data: Uint8Array } | null;
}

const money = (p: number) => formatINR(p, '');
const rate = (bp: number) => `${bp / 100}%`.replace(/(\.\d)0+%/, '$1%');

export function buildReceipt(d: ReceiptData, o: ReceiptOptions): Uint8Array {
  return renderTemplate(o.template ?? DEFAULT_TEMPLATE, d, o, { upiId: o.upiId });
}

/** The layout before bill designs (kept for reference; templates/receipt/standard.tiffinreceipt reproduces it). */
export function buildStandardReceipt(d: ReceiptData, o: ReceiptOptions): Uint8Array {
  const p = new EscPos(o.cols).init();
  const credit = d.invoice.docType === 'CREDIT_NOTE';
  p.size(2, 2).bold(true).center(d.outlet.name).size(1, 1).bold(false);
  if (d.outlet.address) p.center(d.outlet.address);
  if (d.outlet.phone) p.center(`Ph: ${d.outlet.phone}`);
  if (d.outlet.gstin) p.center(`GSTIN: ${d.outlet.gstin}`);
  if (d.outlet.fssaiNo) p.center(`FSSAI: ${d.outlet.fssaiNo}`);
  p.rule();
  p.bold(true).center(o.sample ? 'SAMPLE - NOT A BILL' : credit ? 'CREDIT NOTE' : 'TAX INVOICE').bold(false);
  if (d.invoice.status === 'CANCELLED') p.bold(true).center('*** CANCELLED ***').bold(false);
  if (o.copyNo > 1) p.bold(true).center('*** DUPLICATE ***').bold(false);
  p.twoCol('No:', d.invoice.invoiceNo);
  p.twoCol('Date:', istDateTime(d.invoice.issuedAt));
  if (credit && d.invoice.originalInvoiceNo) p.twoCol('Against:', d.invoice.originalInvoiceNo);
  if (d.invoice.buyerGstin) p.twoCol('Buyer GSTIN:', d.invoice.buyerGstin);
  p.twoCol('Cashier:', d.cashierName);
  if (d.invoice.tokenNo !== null && !credit) p.bold(true).twoCol('Token:', String(d.invoice.tokenNo)).bold(false);
  p.rule();
  for (const l of d.lines) {
    p.wrapped(l.name);
    for (const m of l.modifiers) p.wrapped(`+ ${m.name}`, 2);
    if (l.note) p.wrapped(`Note: ${l.note}`, 2);
    p.twoCol(`  ${formatQty(l.qtyMilli)} x ${money(l.unitPrice)}`, money(l.lineTotal));
  }
  p.rule();
  p.twoCol('Subtotal', money(d.invoice.grossTotal));
  if (d.invoice.discountTotal > 0) p.twoCol('Discount', `-${money(d.invoice.discountTotal)}`);
  p.twoCol('Taxable value', money(d.invoice.taxableTotal));
  const byRate = new Map<number, { cgst: number; sgst: number; igst: number }>();
  for (const l of d.lines) {
    const r = byRate.get(l.rateBp) ?? { cgst: 0, sgst: 0, igst: 0 };
    r.cgst += l.cgst; r.sgst += l.sgst; r.igst += l.igst;
    byRate.set(l.rateBp, r);
  }
  for (const [bp, r] of [...byRate].sort((a, b) => a[0] - b[0])) {
    if (bp === 0) continue;
    if (r.igst > 0) p.twoCol(`IGST @${rate(bp)}`, money(r.igst));
    else { p.twoCol(`CGST @${rate(bp / 2)}`, money(r.cgst)); p.twoCol(`SGST @${rate(bp / 2)}`, money(r.sgst)); }
  }
  if (d.invoice.cess > 0) p.twoCol('Cess', money(d.invoice.cess));
  if (d.invoice.roundOff !== 0) p.twoCol('Round off', `${d.invoice.roundOff < 0 ? '-' : ''}${money(Math.abs(d.invoice.roundOff))}`);
  p.rule('=');
  p.size(1, 2).bold(true).twoCol(credit ? 'REFUND' : 'TOTAL', money(d.invoice.grandTotal)).bold(false).size(1, 1);
  p.rule('=');
  for (const pay of d.payments) {
    p.twoCol(pay.mode, money(pay.amount));
    if (pay.mode === 'CASH' && pay.tendered !== null && pay.tendered > pay.amount) {
      p.twoCol('  Tendered', money(pay.tendered));
      p.twoCol('  Change', money(pay.tendered - pay.amount));
    }
  }
  p.rule();
  if (o.footer) p.center(o.footer);
  p.feed(3);
  if (o.drawer) p.drawerKick();
  p.cut();
  return p.bytes();
}

export interface KotData {
  tokenNo: number | null; channel: string; createdAt: number; station: string; orderNote: string | null;
  lines: Array<{ name: string; qtyMilli: number; modifiers: Array<{ name: string }>; note: string | null }>;
}
export function buildKot(d: KotData, cols: number): Uint8Array {
  const p = new EscPos(cols).init();
  p.bold(true).center(`KOT${d.station ? ' - ' + d.station : ''}`).bold(false);
  if (d.tokenNo !== null) p.size(2, 2).bold(true).center(`TOKEN ${d.tokenNo}`).bold(false).size(1, 1);
  p.twoCol(d.channel, istDateTime(d.createdAt));
  p.rule();
  p.size(1, 2);
  for (const l of d.lines) {
    p.bold(true).wrapped(`${formatQty(l.qtyMilli)} x ${l.name}`).bold(false);
    for (const m of l.modifiers) p.wrapped(`+ ${m.name}`, 3);
    if (l.note) p.wrapped(`Note: ${l.note}`, 3);
  }
  p.size(1, 1).rule();
  if (d.orderNote) p.wrapped(`Order note: ${d.orderNote}`);
  p.feed(3).cut();
  return p.bytes();
}

export function buildTextReport(cols: number, title: string, rows: Array<[string, string] | string>): Uint8Array {
  const p = new EscPos(cols).init();
  p.bold(true).center(title).bold(false).rule();
  for (const r of rows) { if (typeof r === 'string') p.line(r); else p.twoCol(r[0], r[1]); }
  p.feed(3).cut();
  return p.bytes();
}

export function buildTestPage(cols: number, printerName: string): Uint8Array {
  const p = new EscPos(cols).init();
  p.bold(true).center('PRINTER TEST').bold(false).rule();
  p.line(printerName);
  p.line(`Width: ${cols} characters`);
  p.line('0123456789'.repeat(Math.ceil(cols / 10)).slice(0, cols));
  p.twoCol('Rupee sign prints as', 'Rs 1,234.50');
  p.qr('https://example.com/test', 5);
  p.feed(3).cut();
  return p.bytes();
}

/** A made-up sale with fixed, self-consistent amounts (GST included, one odd paisa), used only to show a layout. */
export function sampleReceiptData(outlet: ReceiptData['outlet'], now: number): ReceiptData {
  return {
    outlet,
    invoice: { invoiceNo: 'SAMPLE', docType: 'TAX_INVOICE', status: 'ISSUED', issuedAt: now, tokenNo: 42, grossTotal: 47000, discountTotal: 0, taxableTotal: 43189,
      cgst: 1905, sgst: 1906, igst: 0, cess: 0, roundOff: 0, grandTotal: 47000, buyerGstin: null },
    lines: [
      { name: 'Sample item', hsnCode: '996331', qtyMilli: 2000, unitPrice: 10000, lineTotal: 20000, rateBp: 500, taxable: 19048, cgst: 476, sgst: 476, igst: 0, modifiers: [{ name: 'Sample extra', price: 0 }], note: null },
      { name: 'Sample item with a longer name', hsnCode: '996331', qtyMilli: 1000, unitPrice: 15000, lineTotal: 15000, rateBp: 1800, taxable: 12712, cgst: 1144, sgst: 1144, igst: 0, modifiers: [], note: 'Less spicy' },
      { name: 'Third item', hsnCode: '996331', qtyMilli: 3000, unitPrice: 4000, lineTotal: 12000, rateBp: 500, taxable: 11429, cgst: 285, sgst: 286, igst: 0, modifiers: [], note: null },
    ],
    payments: [{ mode: 'CASH', amount: 47000, tendered: 50000 }],
    cashierName: 'Sample',
  };
}
