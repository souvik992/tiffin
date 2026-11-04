import { all, run, tx } from '../store/db.ts';
import type { Ctx } from './ctx.ts';
import { camelAll } from './camel.ts';
import { istDay } from '../core/numbering.ts';
import { formatINR } from '../core/money.ts';
import { modeCol } from './invoiceStore.ts';
import type { SummaryCol } from './invoiceStore.ts';

export function dailySummary(ctx: Ctx, fromDay: string, toDay: string) {
  return camelAll(all(ctx.db, 'SELECT * FROM daily_summary WHERE day >= ? AND day <= ? ORDER BY day, device_id', fromDay, toDay));
}

/** GST summary by rate for a time range (IST day bounds as epoch ms). Credit notes subtract. */
export function taxSummary(ctx: Ctx, fromMs: number, toMs: number) {
  return camelAll(all(ctx.db, `
    SELECT l.rate_bp,
      sum(CASE WHEN i.doc_type='TAX_INVOICE' THEN l.taxable ELSE -l.taxable END) AS taxable,
      sum(CASE WHEN i.doc_type='TAX_INVOICE' THEN l.cgst ELSE -l.cgst END) AS cgst,
      sum(CASE WHEN i.doc_type='TAX_INVOICE' THEN l.sgst ELSE -l.sgst END) AS sgst,
      sum(CASE WHEN i.doc_type='TAX_INVOICE' THEN l.igst ELSE -l.igst END) AS igst,
      sum(CASE WHEN i.doc_type='TAX_INVOICE' THEN l.cess ELSE -l.cess END) AS cess
    FROM invoice_line l JOIN invoice i ON i.id = l.invoice_id
    WHERE i.status = 'ISSUED' AND i.issued_at >= ? AND i.issued_at < ? GROUP BY l.rate_bp ORDER BY l.rate_bp`, fromMs, toMs));
}

export function itemSales(ctx: Ctx, fromMs: number, toMs: number, limit = 50) {
  return camelAll(all(ctx.db, `
    SELECT l.name,
      sum(CASE WHEN i.doc_type='TAX_INVOICE' THEN l.qty_milli ELSE -l.qty_milli END) AS qty_milli,
      sum(CASE WHEN i.doc_type='TAX_INVOICE' THEN l.line_total ELSE -l.line_total END) AS amount
    FROM invoice_line l JOIN invoice i ON i.id = l.invoice_id
    WHERE i.status = 'ISSUED' AND i.issued_at >= ? AND i.issued_at < ? GROUP BY l.name ORDER BY amount DESC LIMIT ?`, fromMs, toMs, limit));
}

const csvCell = (v: unknown): string => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@]/.test(s)) s = `'${s}`; // neutralise spreadsheet formula injection
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/** Auditor export: every invoice and credit note in range, amounts in rupees. */
export function invoiceRegisterCsv(ctx: Ctx, fromMs: number, toMs: number): string {
  const rows = all<Record<string, number | string | null>>(ctx.db, `
    SELECT invoice_no, doc_type, status, issued_at, buyer_gstin, place_of_supply, taxable_total, cgst, sgst, igst, cess, round_off, grand_total
    FROM invoice WHERE issued_at >= ? AND issued_at < ? ORDER BY issued_at, seq_no`, fromMs, toMs);
  const head = ['Invoice No', 'Type', 'Status', 'Date (IST)', 'Buyer GSTIN', 'Place of supply', 'Taxable', 'CGST', 'SGST', 'IGST', 'Cess', 'Round off', 'Total'];
  const money = (p: unknown) => formatINR(Number(p), '').replace(/,/g, '');
  const lines = [head.join(',')];
  for (const r of rows) {
    lines.push([r.invoice_no, r.doc_type, r.status, istDay(Number(r.issued_at)), r.buyer_gstin, r.place_of_supply, money(r.taxable_total), money(r.cgst), money(r.sgst), money(r.igst), money(r.cess), money(r.round_off), money(r.grand_total)].map(csvCell).join(','));
  }
  return lines.join('\n') + '\n';
}

/** Rebuilds daily_summary from invoices and payments. Also used to prove the incremental totals are right. */
export function recomputeDailySummary(ctx: Ctx): void {
  const inv = all<{ id: string; device_id: string; issued_at: number; doc_type: string; status: string; grand_total: number; tax: number; discount_total: number }>(ctx.db,
    'SELECT id, device_id, issued_at, doc_type, status, grand_total, cgst + sgst + igst + cess AS tax, discount_total FROM invoice');
  const pays = all<{ invoice_id: string; mode: string; amount: number }>(ctx.db, 'SELECT invoice_id, mode, amount FROM payment_effective');
  const byInv = new Map<string, Array<{ mode: string; amount: number }>>();
  for (const p of pays) byInv.set(p.invoice_id, [...(byInv.get(p.invoice_id) ?? []), p]);
  const agg = new Map<string, Record<SummaryCol, number> & { day: string; device: string }>();
  const cell = (day: string, device: string) => {
    const k = `${day}|${device}`;
    let c = agg.get(k);
    if (!c) { c = { day, device, invoices: 0, cancelled: 0, credit_notes: 0, sales_total: 0, refund_total: 0, tax_total: 0, discount_total: 0, cash: 0, upi: 0, card: 0, other: 0 }; agg.set(k, c); }
    return c;
  };
  for (const i of inv) {
    const c = cell(istDay(i.issued_at), i.device_id);
    if (i.doc_type === 'TAX_INVOICE') {
      if (i.status === 'CANCELLED') { c.cancelled++; continue; }
      c.invoices++; c.sales_total += i.grand_total; c.tax_total += i.tax; c.discount_total += i.discount_total;
      for (const p of byInv.get(i.id) ?? []) c[modeCol(p.mode)] += p.amount;
    } else if (i.status === 'ISSUED') {
      c.credit_notes++; c.refund_total += i.grand_total; c.tax_total -= i.tax;
      for (const p of byInv.get(i.id) ?? []) c[modeCol(p.mode)] -= p.amount;
    }
  }
  tx(ctx.db, () => {
    run(ctx.db, 'DELETE FROM daily_summary');
    for (const c of agg.values()) {
      run(ctx.db, `INSERT INTO daily_summary(day, device_id, invoices, cancelled, credit_notes, sales_total, refund_total, tax_total, discount_total, cash, upi, card, other)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, c.day, c.device, c.invoices, c.cancelled, c.credit_notes, c.sales_total, c.refund_total, c.tax_total, c.discount_total, c.cash, c.upi, c.card, c.other);
    }
  });
}
