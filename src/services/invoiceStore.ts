import { istDay } from '../core/numbering.ts';
import { get, run, AppError } from '../store/db.ts';
import type { Ctx } from './ctx.ts';
import { financialYear, formatDocNo } from '../core/numbering.ts';

export interface InvoiceRecord {
  id: string; orderId: string; deviceId: string; shiftId: string | null; docType: 'TAX_INVOICE' | 'CREDIT_NOTE'; seriesId: string; seqNo: number;
  invoiceNo: string; issuedAt: number; buyerGstin: string | null; placeOfSupply: string; tokenNo: number | null;
  grossTotal: number; discountTotal: number; taxableTotal: number; cgst: number; sgst: number; igst: number; cess: number; roundOff: number; grandTotal: number;
  status: 'ISSUED' | 'CANCELLED'; originalInvoiceId: string | null; createdBy: string;
}
export interface LineRecord {
  id: string; lineNo: number; itemId: string | null; sourceLineId: string | null; name: string; hsnCode: string | null; qtyMilli: number; unit: string; unitPrice: number;
  gross: number; discount: number; taxable: number; rateBp: number; cgst: number; sgst: number; igst: number; cess: number; lineTotal: number; modifiersJson: string; note: string | null;
}
export interface PaymentRecord { id: string; mode: string; amount: number; tendered: number | null; reference: string | null; shiftId: string | null; createdAt: number }

export function insertInvoice(ctx: Ctx, v: InvoiceRecord, lines: LineRecord[], payments: PaymentRecord[]): void {
  run(ctx.db, `INSERT INTO invoice(id, order_id, device_id, shift_id, doc_type, series_id, seq_no, invoice_no, issued_at, buyer_gstin, place_of_supply, token_no,
      gross_total, discount_total, taxable_total, cgst, sgst, igst, cess, round_off, grand_total, status, original_invoice_id, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    v.id, v.orderId, v.deviceId, v.shiftId, v.docType, v.seriesId, v.seqNo, v.invoiceNo, v.issuedAt, v.buyerGstin, v.placeOfSupply, v.tokenNo,
    v.grossTotal, v.discountTotal, v.taxableTotal, v.cgst, v.sgst, v.igst, v.cess, v.roundOff, v.grandTotal, v.status, v.originalInvoiceId, v.createdBy);
  ctx.hooks.fault?.('invoice.after_row');
  for (const l of lines) {
    run(ctx.db, `INSERT INTO invoice_line(id, invoice_id, line_no, item_id, source_line_id, name, hsn_code, qty_milli, unit, unit_price, gross, discount, taxable, rate_bp,
        cgst, sgst, igst, cess, line_total, modifiers_json, note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      l.id, v.id, l.lineNo, l.itemId, l.sourceLineId, l.name, l.hsnCode, l.qtyMilli, l.unit, l.unitPrice, l.gross, l.discount, l.taxable, l.rateBp,
      l.cgst, l.sgst, l.igst, l.cess, l.lineTotal, l.modifiersJson, l.note);
  }
  ctx.hooks.fault?.('invoice.after_lines');
  for (const p of payments) {
    run(ctx.db, 'INSERT INTO payment(id, invoice_id, mode, amount, tendered, reference, shift_id, created_at) VALUES (?,?,?,?,?,?,?,?)',
      p.id, v.id, p.mode, p.amount, p.tendered, p.reference, p.shiftId, p.createdAt);
  }
  ctx.hooks.fault?.('invoice.after_payments');
}

/**
 * Gapless numbering: allocated inside the same transaction as the invoice insert, so a rollback
 * releases the number and a crash can never leave a gap or a duplicate.
 */
export function allocateNumber(ctx: Ctx, deviceId: string, docType: 'TAX_INVOICE' | 'CREDIT_NOTE', now: number) {
  const fy = financialYear(now);
  let series = get<{ id: string; prefix: string; next_no: number }>(ctx.db, 'SELECT id, prefix, next_no FROM invoice_series WHERE device_id = ? AND doc_type = ? AND fy = ?', deviceId, docType, fy);
  if (!series) {
    const dev = get<{ series_prefix: string }>(ctx.db, 'SELECT series_prefix FROM device WHERE id = ?', deviceId)!;
    const id = ctx.ids.next();
    const prefix = docType === 'CREDIT_NOTE' ? `${dev.series_prefix}C` : dev.series_prefix;
    run(ctx.db, 'INSERT INTO invoice_series(id, device_id, doc_type, fy, prefix, next_no) VALUES (?,?,?,?,?,1)', id, deviceId, docType, fy, prefix);
    series = { id, prefix, next_no: 1 };
  }
  const seq = series.next_no;
  const r = run(ctx.db, 'UPDATE invoice_series SET next_no = next_no + 1 WHERE id = ? AND next_no = ?', series.id, seq);
  if (Number(r.changes) !== 1) throw new AppError('NUMBERING_CONFLICT', 'Invoice number allocation conflicted. Please retry.', 409);
  return { seriesId: series.id, seqNo: seq, invoiceNo: formatDocNo(series.prefix, fy, seq) };
}

const COLS = ['invoices', 'cancelled', 'credit_notes', 'sales_total', 'refund_total', 'tax_total', 'discount_total', 'cash', 'upi', 'card', 'other'] as const;
export type SummaryCol = (typeof COLS)[number];
export type Deltas = Partial<Record<SummaryCol, number>>;

export const modeCol = (mode: string): SummaryCol => (mode === 'CASH' ? 'cash' : mode === 'UPI' ? 'upi' : mode === 'CARD' ? 'card' : 'other');

export function bumpSummary(ctx: Ctx, day: string, deviceId: string, d: Deltas): void {
  run(ctx.db, 'INSERT INTO daily_summary(day, device_id) VALUES (?,?) ON CONFLICT(day, device_id) DO NOTHING', day, deviceId);
  const keys = COLS.filter((c) => d[c] !== undefined && d[c] !== 0);
  if (keys.length === 0) return;
  run(ctx.db, `UPDATE daily_summary SET ${keys.map((k) => `${k} = ${k} + ?`).join(', ')} WHERE day = ? AND device_id = ?`, ...keys.map((k) => d[k]!), day, deviceId);
}

export interface PaymentCorrectionRecord {
  id: string; invoiceId: string; paymentId: string; fromMode: string; toMode: string; amount: number; reference: string | null; reason: string;
  shiftId: string | null; createdBy: string; approvedBy: string; createdAt: number;
}

/** Writes a correction row and moves the amount between the day's payment-mode totals (also used by the journal replay). */
export function insertCorrection(ctx: Ctx, c: PaymentCorrectionRecord, deviceId: string, issuedAt: number): void {
  run(ctx.db, `INSERT INTO payment_correction(id, invoice_id, payment_id, from_mode, to_mode, amount, reference, reason, shift_id, created_by, approved_by, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, c.id, c.invoiceId, c.paymentId, c.fromMode, c.toMode, c.amount, c.reference, c.reason, c.shiftId, c.createdBy, c.approvedBy, c.createdAt);
  const d: Deltas = {};
  d[modeCol(c.fromMode)] = (d[modeCol(c.fromMode)] ?? 0) - c.amount;
  d[modeCol(c.toMode)] = (d[modeCol(c.toMode)] ?? 0) + c.amount;
  bumpSummary(ctx, istDay(issuedAt), deviceId, d);
}

