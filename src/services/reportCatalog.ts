import { all, AppError } from '../store/db.ts';
import type { Actor, Ctx } from './ctx.ts';
import { assertPerm } from './permissions.ts';
import { formatQty, mulDivRound } from '../core/money.ts';
import { listStockItems } from './stock.ts';

/**
 * Store reports. Every report is a table (columns, rows, totals, headline numbers) computed here in integer paise,
 * so the screen and the CSV download show exactly the same numbers and the UI never adds money up.
 * Date ranges are IST calendar days. Cancelled bills never count as sales; credit notes (refunds) subtract.
 */

export type ColType = 'text' | 'money' | 'int' | 'qty' | 'date' | 'datetime';
export interface Column { key: string; label: string; type: ColType }
export type Row = Record<string, string | number | null>;
export interface ReportTable {
  key: string; title: string; description: string; from: string; to: string; generatedAt: number;
  columns: Column[]; rows: Row[]; totals: Row | null; summary: Array<{ label: string; value: number | string; type: ColType }>;
}
interface Range { from: string; to: string }
interface Bounds extends Range { fromMs: number; toMs: number }
type Built = Pick<ReportTable, 'columns' | 'rows' | 'totals' | 'summary'>;
interface Def { key: string; title: string; group: string; description: string; build: (ctx: Ctx, b: Bounds) => Built }

const IST = 330 * 60_000;
const DAY_SQL = `date((i.issued_at + ${IST}) / 1000, 'unixepoch')`;
const IN_RANGE = 'i.issued_at >= ? AND i.issued_at < ?';
const BILL = "i.doc_type = 'TAX_INVOICE' AND i.status = 'ISSUED'";
const REFUND = "i.doc_type = 'CREDIT_NOTE' AND i.status = 'ISSUED'";
const SIGNED = (c: string) => `CASE WHEN i.doc_type = 'TAX_INVOICE' THEN ${c} ELSE -${c} END`;
const MODE: Record<string, string> = { CASH: 'Cash', UPI: 'UPI', CARD: 'Card', WALLET: 'Wallet', CREDIT: 'Credit (pay later)', OTHER: 'Other' };
const CHANNEL: Record<string, string> = { COUNTER: 'Counter', SWIGGY: 'Swiggy', ZOMATO: 'Zomato', ONDC: 'ONDC', OTHER: 'Other' };
const UNIT: Record<string, string> = { kg: 'kg', g: 'g', l: 'L', ml: 'ml', pcs: 'pcs' };

const rateText = (bp: number) => { const w = Math.trunc(bp / 100), f = bp % 100; return f === 0 ? `${w}%` : `${w}.${String(f).padStart(2, '0').replace(/0$/, '')}%`; };
const qty = (milli: number, unit?: string) => `${milli < 0 ? '-' : ''}${formatQty(Math.abs(milli))}${unit ? ` ${UNIT[unit] ?? unit}` : ''}`;
const n = (v: unknown) => Number(v ?? 0);

/** Sums the money/int columns of the rows (all integers, so no rounding). */
function totalsOf(columns: Column[], rows: Row[], first = 'Total'): Row {
  const t: Row = {};
  columns.forEach((c, i) => {
    if (i === 0) t[c.key] = first;
    else if (c.type === 'money' || c.type === 'int') t[c.key] = rows.reduce((s, r) => s + n(r[c.key]), 0);
    else t[c.key] = null;
  });
  return t;
}

// ---------------------------------------------------------------- report definitions

const salesSummary: Def = {
  key: 'sales-summary', title: 'Sales summary', group: 'Sales', description: 'Day by day: bills, sales, discounts, GST, cancellations and refunds.',
  build(ctx, b) {
    const rows = all<Row>(ctx.db, `SELECT ${DAY_SQL} AS day,
        sum(CASE WHEN ${BILL} THEN 1 ELSE 0 END) AS bills,
        sum(CASE WHEN ${BILL} THEN i.gross_total ELSE 0 END) AS gross,
        sum(CASE WHEN ${BILL} THEN i.discount_total ELSE 0 END) AS discounts,
        sum(CASE WHEN ${BILL} THEN i.grand_total ELSE 0 END) AS netSales,
        sum(CASE WHEN i.status = 'ISSUED' THEN ${SIGNED('(i.cgst + i.sgst + i.igst + i.cess)')} ELSE 0 END) AS tax,
        sum(CASE WHEN i.doc_type = 'TAX_INVOICE' AND i.status = 'CANCELLED' THEN 1 ELSE 0 END) AS cancelled,
        sum(CASE WHEN ${REFUND} THEN 1 ELSE 0 END) AS refunds,
        sum(CASE WHEN ${REFUND} THEN i.grand_total ELSE 0 END) AS refundAmount
      FROM invoice i WHERE ${IN_RANGE} GROUP BY day ORDER BY day`, b.fromMs, b.toMs)
      .map((r) => ({ ...r, netAfterRefunds: n(r.netSales) - n(r.refundAmount) }));
    const columns: Column[] = [
      { key: 'day', label: 'Date', type: 'date' }, { key: 'bills', label: 'Bills', type: 'int' }, { key: 'gross', label: 'Gross sales', type: 'money' },
      { key: 'discounts', label: 'Discounts', type: 'money' }, { key: 'netSales', label: 'Net sales', type: 'money' }, { key: 'tax', label: 'GST', type: 'money' },
      { key: 'cancelled', label: 'Cancelled bills', type: 'int' }, { key: 'refunds', label: 'Refunds', type: 'int' }, { key: 'refundAmount', label: 'Refunded', type: 'money' },
      { key: 'netAfterRefunds', label: 'Net after refunds', type: 'money' },
    ];
    const totals = totalsOf(columns, rows);
    const bills = n(totals.bills);
    return {
      columns, rows, totals, summary: [
        { label: 'Bills', value: bills, type: 'int' },
        { label: 'Net sales after refunds', value: n(totals.netAfterRefunds), type: 'money' },
        { label: 'Average bill', value: bills ? mulDivRound(n(totals.netSales), 1, bills) : 0, type: 'money' },
        { label: 'GST collected', value: n(totals.tax), type: 'money' },
        { label: 'Discounts given', value: n(totals.discounts), type: 'money' },
        { label: 'Cancelled bills', value: n(totals.cancelled), type: 'int' },
      ],
    };
  },
};

const payments: Def = {
  key: 'payments', title: 'Payment modes', group: 'Sales', description: 'Money received by cash, UPI, card and other modes, less refunds.',
  build(ctx, b) {
    const rows = all<{ mode: string; count: number; received: number; refunded: number }>(ctx.db, `SELECT p.mode,
        sum(CASE WHEN i.doc_type = 'TAX_INVOICE' THEN 1 ELSE 0 END) AS count,
        sum(CASE WHEN i.doc_type = 'TAX_INVOICE' THEN p.amount ELSE 0 END) AS received,
        sum(CASE WHEN i.doc_type = 'CREDIT_NOTE' THEN p.amount ELSE 0 END) AS refunded
      FROM payment p JOIN invoice i ON i.id = p.invoice_id WHERE i.status = 'ISSUED' AND ${IN_RANGE} GROUP BY p.mode ORDER BY received DESC`, b.fromMs, b.toMs)
      .map((r) => ({ mode: MODE[r.mode] ?? r.mode, count: r.count, received: r.received, refunded: r.refunded, net: r.received - r.refunded }));
    const columns: Column[] = [{ key: 'mode', label: 'Payment mode', type: 'text' }, { key: 'count', label: 'Payments', type: 'int' }, { key: 'received', label: 'Received', type: 'money' }, { key: 'refunded', label: 'Refunded', type: 'money' }, { key: 'net', label: 'Net', type: 'money' }];
    const totals = totalsOf(columns, rows);
    return { columns, rows, totals, summary: rows.map((r) => ({ label: String(r.mode), value: r.net, type: 'money' as const })) };
  },
};

const hourly: Def = {
  key: 'hourly', title: 'Sales by hour', group: 'Sales', description: 'Busy hours: bills and sales for each hour of the day.',
  build(ctx, b) {
    const rows = all<{ h: string; bills: number; netSales: number }>(ctx.db, `SELECT strftime('%H', (i.issued_at + ${IST}) / 1000, 'unixepoch') AS h,
        count(*) AS bills, sum(i.grand_total) AS netSales FROM invoice i WHERE ${BILL} AND ${IN_RANGE} GROUP BY h ORDER BY h`, b.fromMs, b.toMs)
      .map((r) => ({ hour: `${r.h}:00 - ${r.h}:59`, bills: r.bills, netSales: r.netSales }));
    const columns: Column[] = [{ key: 'hour', label: 'Hour', type: 'text' }, { key: 'bills', label: 'Bills', type: 'int' }, { key: 'netSales', label: 'Net sales', type: 'money' }];
    const busiest = rows.slice().sort((a, c) => c.netSales - a.netSales)[0];
    return { columns, rows, totals: totalsOf(columns, rows), summary: busiest ? [{ label: 'Busiest hour', value: busiest.hour, type: 'text' }] : [] };
  },
};

const channels: Def = {
  key: 'channels', title: 'Order channels', group: 'Sales', description: 'Counter, Swiggy, Zomato and other channels.',
  build(ctx, b) {
    const rows = all<{ channel: string; bills: number; netSales: number }>(ctx.db, `SELECT o.channel, count(*) AS bills, sum(i.grand_total) AS netSales
      FROM invoice i JOIN sale_order o ON o.id = i.order_id WHERE ${BILL} AND ${IN_RANGE} GROUP BY o.channel ORDER BY netSales DESC`, b.fromMs, b.toMs)
      .map((r) => ({ channel: CHANNEL[r.channel] ?? r.channel, bills: r.bills, netSales: r.netSales }));
    const columns: Column[] = [{ key: 'channel', label: 'Channel', type: 'text' }, { key: 'bills', label: 'Bills', type: 'int' }, { key: 'netSales', label: 'Net sales', type: 'money' }];
    return { columns, rows, totals: totalsOf(columns, rows), summary: [] };
  },
};

const staff: Def = {
  key: 'staff', title: 'Sales by cashier', group: 'Sales', description: 'Bills, sales, discounts and cancellations per staff member.',
  build(ctx, b) {
    const rows = all<Row>(ctx.db, `SELECT u.name AS cashier,
        sum(CASE WHEN i.status = 'ISSUED' THEN 1 ELSE 0 END) AS bills,
        sum(CASE WHEN i.status = 'ISSUED' THEN i.grand_total ELSE 0 END) AS netSales,
        sum(CASE WHEN i.status = 'ISSUED' THEN i.discount_total ELSE 0 END) AS discounts,
        sum(CASE WHEN i.status = 'CANCELLED' THEN 1 ELSE 0 END) AS cancelled,
        sum(CASE WHEN i.status = 'CANCELLED' THEN i.grand_total ELSE 0 END) AS cancelledAmount
      FROM invoice i JOIN app_user u ON u.id = i.created_by WHERE i.doc_type = 'TAX_INVOICE' AND ${IN_RANGE} GROUP BY u.id ORDER BY netSales DESC`, b.fromMs, b.toMs);
    const columns: Column[] = [{ key: 'cashier', label: 'Cashier', type: 'text' }, { key: 'bills', label: 'Bills', type: 'int' }, { key: 'netSales', label: 'Net sales', type: 'money' },
      { key: 'discounts', label: 'Discounts given', type: 'money' }, { key: 'cancelled', label: 'Cancelled bills', type: 'int' }, { key: 'cancelledAmount', label: 'Cancelled amount', type: 'money' }];
    return { columns, rows, totals: totalsOf(columns, rows), summary: [] };
  },
};

const discounts: Def = {
  key: 'discounts', title: 'Discounts', group: 'Sales', description: 'Every bill with a discount, who billed it and who approved it.',
  build(ctx, b) {
    const rows = all<Row & { gross: number; discount: number }>(ctx.db, `SELECT i.invoice_no AS invoiceNo, i.issued_at AS at, u.name AS cashier, i.gross_total AS gross, i.discount_total AS discount,
        coalesce(a.name, '') AS approvedBy, i.grand_total AS total
      FROM invoice i JOIN app_user u ON u.id = i.created_by JOIN sale_order o ON o.id = i.order_id LEFT JOIN app_user a ON a.id = o.discount_approved_by
      WHERE ${BILL} AND i.discount_total > 0 AND ${IN_RANGE} ORDER BY i.issued_at`, b.fromMs, b.toMs)
      .map((r) => ({ ...r, discountPct: r.gross > 0 ? rateText(Math.trunc((r.discount * 10000) / r.gross)) : '' }));
    const columns: Column[] = [{ key: 'invoiceNo', label: 'Bill', type: 'text' }, { key: 'at', label: 'Time', type: 'datetime' }, { key: 'cashier', label: 'Cashier', type: 'text' },
      { key: 'gross', label: 'Before discount', type: 'money' }, { key: 'discount', label: 'Discount', type: 'money' }, { key: 'discountPct', label: 'Discount %', type: 'text' },
      { key: 'approvedBy', label: 'Approved by', type: 'text' }, { key: 'total', label: 'Bill total', type: 'money' }];
    const totals = totalsOf(columns, rows);
    return { columns, rows, totals, summary: [{ label: 'Bills with a discount', value: rows.length, type: 'int' }, { label: 'Total discount', value: n(totals.discount), type: 'money' }] };
  },
};

const items: Def = {
  key: 'items', title: 'Item sales', group: 'Items', description: 'Every item sold: quantity, returns and sales value (best sellers first).',
  build(ctx, b) {
    const rows = all<{ item: string; category: string; sold: number; returned: number; netSales: number }>(ctx.db, `SELECT l.name AS item, coalesce(c.name, 'No category') AS category,
        sum(CASE WHEN i.doc_type = 'TAX_INVOICE' THEN l.qty_milli ELSE 0 END) AS sold,
        sum(CASE WHEN i.doc_type = 'CREDIT_NOTE' THEN l.qty_milli ELSE 0 END) AS returned,
        sum(${SIGNED('l.line_total')}) AS netSales
      FROM invoice_line l JOIN invoice i ON i.id = l.invoice_id LEFT JOIN item it ON it.id = l.item_id LEFT JOIN category c ON c.id = it.category_id
      WHERE i.status = 'ISSUED' AND ${IN_RANGE} GROUP BY l.name, category ORDER BY netSales DESC, l.name`, b.fromMs, b.toMs)
      .map((r) => ({ item: r.item, category: r.category, soldQty: qty(r.sold), returnedQty: qty(r.returned), netQty: qty(r.sold - r.returned), netSales: r.netSales }));
    const roundOff = all<{ r: number | null }>(ctx.db, `SELECT sum(${SIGNED('i.round_off')}) AS r FROM invoice i WHERE i.status = 'ISSUED' AND ${IN_RANGE}`, b.fromMs, b.toMs)[0]?.r ?? 0;
    const columns: Column[] = [{ key: 'item', label: 'Item', type: 'text' }, { key: 'category', label: 'Category', type: 'text' }, { key: 'soldQty', label: 'Sold', type: 'qty' },
      { key: 'returnedQty', label: 'Returned', type: 'qty' }, { key: 'netQty', label: 'Net quantity', type: 'qty' }, { key: 'netSales', label: 'Net sales', type: 'money' }];
    return { columns, rows, totals: totalsOf(columns, rows), summary: [{ label: 'Items sold', value: rows.length, type: 'int' }, { label: 'Round off (on bills, not items)', value: n(roundOff), type: 'money' }] };
  },
};

const categories: Def = {
  key: 'categories', title: 'Category sales', group: 'Items', description: 'Sales value per menu category.',
  build(ctx, b) {
    const rows = all<Row>(ctx.db, `SELECT coalesce(c.name, 'No category') AS category, count(DISTINCT l.name) AS items, sum(${SIGNED('l.line_total')}) AS netSales
      FROM invoice_line l JOIN invoice i ON i.id = l.invoice_id LEFT JOIN item it ON it.id = l.item_id LEFT JOIN category c ON c.id = it.category_id
      WHERE i.status = 'ISSUED' AND ${IN_RANGE} GROUP BY category ORDER BY netSales DESC`, b.fromMs, b.toMs);
    const columns: Column[] = [{ key: 'category', label: 'Category', type: 'text' }, { key: 'items', label: 'Different items', type: 'int' }, { key: 'netSales', label: 'Net sales', type: 'money' }];
    return { columns, rows, totals: totalsOf(columns, rows), summary: [] };
  },
};

const TAX_COLS = `sum(${SIGNED('l.taxable')}) AS taxable, sum(${SIGNED('l.cgst')}) AS cgst, sum(${SIGNED('l.sgst')}) AS sgst, sum(${SIGNED('l.igst')}) AS igst, sum(${SIGNED('l.cess')}) AS cess`;

const gstRates: Def = {
  key: 'gst-rates', title: 'GST by rate', group: 'Tax', description: 'Taxable value and CGST, SGST, IGST and cess per GST rate (refunds subtracted). For GST returns.',
  build(ctx, b) {
    const rows = all<{ rate_bp: number; taxable: number; cgst: number; sgst: number; igst: number; cess: number }>(ctx.db, `SELECT l.rate_bp, ${TAX_COLS}
      FROM invoice_line l JOIN invoice i ON i.id = l.invoice_id WHERE i.status = 'ISSUED' AND ${IN_RANGE} GROUP BY l.rate_bp ORDER BY l.rate_bp`, b.fromMs, b.toMs)
      .map((r) => { const totalTax = r.cgst + r.sgst + r.igst + r.cess; return { rate: rateText(r.rate_bp), taxable: r.taxable, cgst: r.cgst, sgst: r.sgst, igst: r.igst, cess: r.cess, totalTax, value: r.taxable + totalTax }; });
    const columns: Column[] = [{ key: 'rate', label: 'GST rate', type: 'text' }, { key: 'taxable', label: 'Taxable value', type: 'money' }, { key: 'cgst', label: 'CGST', type: 'money' },
      { key: 'sgst', label: 'SGST', type: 'money' }, { key: 'igst', label: 'IGST', type: 'money' }, { key: 'cess', label: 'Cess', type: 'money' }, { key: 'totalTax', label: 'Total GST', type: 'money' }, { key: 'value', label: 'Value with GST', type: 'money' }];
    const totals = totalsOf(columns, rows);
    return { columns, rows, totals, summary: [{ label: 'Taxable value', value: n(totals.taxable), type: 'money' }, { label: 'Total GST', value: n(totals.totalTax), type: 'money' }] };
  },
};

const hsn: Def = {
  key: 'hsn', title: 'HSN summary', group: 'Tax', description: 'Quantity and tax per HSN code and rate (GSTR-1 HSN-wise summary).',
  build(ctx, b) {
    const rows = all<{ hsn: string; unit: string; rate_bp: number; q: number; taxable: number; cgst: number; sgst: number; igst: number; cess: number }>(ctx.db, `SELECT coalesce(l.hsn_code, 'Not set') AS hsn, l.unit, l.rate_bp,
        sum(${SIGNED('l.qty_milli')}) AS q, ${TAX_COLS}
      FROM invoice_line l JOIN invoice i ON i.id = l.invoice_id WHERE i.status = 'ISSUED' AND ${IN_RANGE} GROUP BY hsn, l.unit, l.rate_bp ORDER BY hsn, l.rate_bp`, b.fromMs, b.toMs)
      .map((r) => ({ hsn: r.hsn, unit: r.unit, rate: rateText(r.rate_bp), quantity: qty(r.q), taxable: r.taxable, cgst: r.cgst, sgst: r.sgst, igst: r.igst, cess: r.cess, value: r.taxable + r.cgst + r.sgst + r.igst + r.cess }));
    const columns: Column[] = [{ key: 'hsn', label: 'HSN', type: 'text' }, { key: 'unit', label: 'Unit', type: 'text' }, { key: 'rate', label: 'GST rate', type: 'text' }, { key: 'quantity', label: 'Quantity', type: 'qty' },
      { key: 'taxable', label: 'Taxable value', type: 'money' }, { key: 'cgst', label: 'CGST', type: 'money' }, { key: 'sgst', label: 'SGST', type: 'money' }, { key: 'igst', label: 'IGST', type: 'money' },
      { key: 'cess', label: 'Cess', type: 'money' }, { key: 'value', label: 'Total value', type: 'money' }];
    return { columns, rows, totals: totalsOf(columns, rows), summary: rows.some((r) => r.hsn === 'Not set') ? [{ label: 'Items without HSN', value: 'Add HSN codes in Menu creation', type: 'text' }] : [] };
  },
};

const bills: Def = {
  key: 'bills', title: 'Bill register', group: 'Tax', description: 'Every bill and credit note with its status, payments and tax (for your accountant).',
  build(ctx, b) {
    const rows = all<Row & { doc_type: string; status: string; channel: string }>(ctx.db, `SELECT i.invoice_no AS invoiceNo, i.doc_type, i.status, i.issued_at AS at, i.token_no AS token, u.name AS cashier, o.channel,
        coalesce((SELECT group_concat(p.mode, ' + ') FROM payment p WHERE p.invoice_id = i.id), '') AS paidBy,
        coalesce(oi.invoice_no, '') AS against, i.buyer_gstin AS buyerGstin, i.taxable_total AS taxable, (i.cgst + i.sgst + i.igst + i.cess) AS tax,
        i.discount_total AS discount, i.round_off AS roundOff, i.grand_total AS total
      FROM invoice i JOIN app_user u ON u.id = i.created_by JOIN sale_order o ON o.id = i.order_id LEFT JOIN invoice oi ON oi.id = i.original_invoice_id
      WHERE ${IN_RANGE} ORDER BY i.issued_at, i.seq_no`, b.fromMs, b.toMs)
      .map(({ doc_type, status, channel, ...r }) => ({
        ...r, type: doc_type === 'CREDIT_NOTE' ? 'Credit note' : 'Bill', status: status === 'CANCELLED' ? 'Cancelled' : doc_type === 'CREDIT_NOTE' ? 'Refunded' : 'Paid',
        channel: CHANNEL[channel] ?? channel, paidBy: String(r.paidBy).split(' + ').filter(Boolean).map((m) => MODE[m] ?? m).join(' + '),
      }));
    const columns: Column[] = [{ key: 'invoiceNo', label: 'Number', type: 'text' }, { key: 'type', label: 'Type', type: 'text' }, { key: 'status', label: 'Status', type: 'text' },
      { key: 'at', label: 'Date and time', type: 'datetime' }, { key: 'token', label: 'Token', type: 'int' }, { key: 'cashier', label: 'Cashier', type: 'text' }, { key: 'channel', label: 'Channel', type: 'text' },
      { key: 'paidBy', label: 'Paid by', type: 'text' }, { key: 'against', label: 'Against bill', type: 'text' }, { key: 'buyerGstin', label: 'Buyer GSTIN', type: 'text' },
      { key: 'taxable', label: 'Taxable', type: 'money' }, { key: 'tax', label: 'GST', type: 'money' }, { key: 'discount', label: 'Discount', type: 'money' },
      { key: 'roundOff', label: 'Round off', type: 'money' }, { key: 'total', label: 'Total', type: 'money' }];
    // Totals: what counts (cancelled bills excluded, credit notes subtracted)
    const counted: Row[] = (rows as Row[]).filter((r) => r.status !== 'Cancelled').map((r) => (r.type === 'Credit note' ? { ...r, taxable: -n(r.taxable), tax: -n(r.tax), discount: 0, roundOff: -n(r.roundOff), total: -n(r.total) } : r));
    const totals = totalsOf(columns, counted, 'Net (excl. cancelled)');
    totals.token = null;
    return { columns, rows, totals, summary: [{ label: 'Documents', value: rows.length, type: 'int' }] };
  },
};

const cancellations: Def = {
  key: 'cancellations', title: 'Cancellations and refunds', group: 'Controls', description: 'Cancelled bills and refunds (credit notes) with reason and who approved them.',
  build(ctx, b) {
    const cancelled = all<Row>(ctx.db, `SELECT 'Cancelled bill' AS type, i.invoice_no AS docNo, i.cancelled_at AS at, '' AS against, coalesce(i.cancel_reason, '') AS reason,
        coalesce(u.name, '') AS by, i.grand_total AS amount
      FROM invoice i LEFT JOIN app_user u ON u.id = i.cancelled_by WHERE i.doc_type = 'TAX_INVOICE' AND i.status = 'CANCELLED' AND i.cancelled_at >= ? AND i.cancelled_at < ?`, b.fromMs, b.toMs);
    const refunds = all<Row>(ctx.db, `SELECT 'Refund (credit note)' AS type, i.invoice_no AS docNo, i.issued_at AS at, coalesce(oi.invoice_no, '') AS against,
        coalesce((SELECT json_extract(a.detail, '$.reason') FROM audit_log a WHERE a.action = 'creditnote.create' AND a.entity_id = i.id LIMIT 1), '') AS reason,
        coalesce((SELECT au.name FROM audit_log a JOIN app_user au ON au.id = json_extract(a.detail, '$.approver') WHERE a.action = 'creditnote.create' AND a.entity_id = i.id LIMIT 1), u.name) AS by,
        i.grand_total AS amount
      FROM invoice i JOIN app_user u ON u.id = i.created_by LEFT JOIN invoice oi ON oi.id = i.original_invoice_id WHERE ${REFUND} AND ${IN_RANGE}`, b.fromMs, b.toMs);
    const rows = [...cancelled, ...refunds].sort((a, c) => n(a.at) - n(c.at));
    const columns: Column[] = [{ key: 'type', label: 'Type', type: 'text' }, { key: 'docNo', label: 'Number', type: 'text' }, { key: 'at', label: 'When', type: 'datetime' },
      { key: 'against', label: 'Against bill', type: 'text' }, { key: 'reason', label: 'Reason', type: 'text' }, { key: 'by', label: 'Approved by', type: 'text' }, { key: 'amount', label: 'Amount', type: 'money' }];
    return { columns, rows, totals: totalsOf(columns, rows), summary: [
      { label: 'Cancelled bills', value: cancelled.length, type: 'int' }, { label: 'Cancelled amount', value: cancelled.reduce((s, r) => s + n(r.amount), 0), type: 'money' },
      { label: 'Refunds', value: refunds.length, type: 'int' }, { label: 'Refunded amount', value: refunds.reduce((s, r) => s + n(r.amount), 0), type: 'money' },
    ] };
  },
};

const shifts: Def = {
  key: 'shifts', title: 'Shifts and cash', group: 'Controls', description: 'Each shift: opening cash, cash sales, expected and counted cash, and the difference.',
  build(ctx, b) {
    const rows = all<{ id: string; opened_at: number; closed_at: number | null; cashier: string; opening_cash: number; expected_cash: number | null; counted_cash: number | null; cash: number | null; bills: number | null }>(ctx.db, `SELECT s.id, s.opened_at, s.closed_at, u.name AS cashier, s.opening_cash, s.expected_cash, s.counted_cash,
        (SELECT sum(${SIGNED('p.amount')}) FROM payment p JOIN invoice i ON i.id = p.invoice_id WHERE i.shift_id = s.id AND i.status = 'ISSUED' AND p.mode = 'CASH') AS cash,
        (SELECT count(*) FROM invoice i WHERE i.shift_id = s.id AND ${BILL}) AS bills
      FROM shift s JOIN app_user u ON u.id = s.user_id WHERE s.opened_at >= ? AND s.opened_at < ? ORDER BY s.opened_at`, b.fromMs, b.toMs)
      .map((s) => {
        const expected = s.closed_at !== null && s.expected_cash !== null ? s.expected_cash : s.opening_cash + n(s.cash);
        return { opened: s.opened_at, closed: s.closed_at, cashier: s.cashier, status: s.closed_at === null ? 'Open' : 'Closed', bills: n(s.bills), openingCash: s.opening_cash,
          cashSales: n(s.cash), expectedCash: expected, countedCash: s.counted_cash, difference: s.counted_cash === null ? null : s.counted_cash - expected };
      });
    const columns: Column[] = [{ key: 'opened', label: 'Opened', type: 'datetime' }, { key: 'closed', label: 'Closed', type: 'datetime' }, { key: 'cashier', label: 'Opened by', type: 'text' },
      { key: 'status', label: 'Status', type: 'text' }, { key: 'bills', label: 'Bills', type: 'int' }, { key: 'openingCash', label: 'Opening cash', type: 'money' }, { key: 'cashSales', label: 'Cash sales (net)', type: 'money' },
      { key: 'expectedCash', label: 'Expected cash', type: 'money' }, { key: 'countedCash', label: 'Counted cash', type: 'money' }, { key: 'difference', label: 'Difference', type: 'money' }];
    const short = rows.filter((r) => (r.difference ?? 0) !== 0).length;
    return { columns, rows, totals: null, summary: [{ label: 'Shifts', value: rows.length, type: 'int' }, { label: 'Shifts with a cash difference', value: short, type: 'int' }] };
  },
};

const stock: Def = {
  key: 'stock', title: 'Stock on hand', group: 'Inventory', description: 'Current stock of every material, what is low, and its value at the last purchase cost (not affected by dates).',
  build(ctx) {
    const rows = listStockItems(ctx).map((s) => ({
      material: s.name, inStock: qty(s.onHandMilli, s.unit), reorderAt: s.reorderLevelMilli > 0 ? qty(s.reorderLevelMilli, s.unit) : '',
      status: s.negative ? 'Count needed' : s.low ? 'Low' : 'OK', lastCost: s.lastUnitCost, value: s.valuePaise,
    }));
    const columns: Column[] = [{ key: 'material', label: 'Material', type: 'text' }, { key: 'inStock', label: 'In stock', type: 'qty' }, { key: 'reorderAt', label: 'Reorder at', type: 'qty' },
      { key: 'status', label: 'Status', type: 'text' }, { key: 'lastCost', label: 'Last cost per unit', type: 'money' }, { key: 'value', label: 'Stock value', type: 'money' }];
    const totals = totalsOf(columns, rows);
    totals.lastCost = null;
    return { columns, rows, totals, summary: [{ label: 'Materials', value: rows.length, type: 'int' }, { label: 'Low or to count', value: rows.filter((r) => r.status !== 'OK').length, type: 'int' }, { label: 'Stock value', value: n(totals.value), type: 'money' }] };
  },
};

const stockMovements: Def = {
  key: 'stock-movements', title: 'Stock movement', group: 'Inventory', description: 'Per material for the period: opening, purchased, used in sales, wasted, adjusted and closing stock.',
  build(ctx, b) {
    const rows = all<{ name: string; unit: string; opening: number; purchased: number; used: number; wasted: number; adjusted: number }>(ctx.db, `SELECT s.name, s.unit,
        coalesce((SELECT sum(m.delta_milli) FROM stock_movement m WHERE m.stock_item_id = s.id AND m.created_at < ?), 0) AS opening,
        coalesce(sum(CASE WHEN m.kind IN ('PURCHASE','PURCHASE_VOID') THEN m.delta_milli END), 0) AS purchased,
        coalesce(-sum(CASE WHEN m.kind IN ('SALE','SALE_REVERSAL') THEN m.delta_milli END), 0) AS used,
        coalesce(-sum(CASE WHEN m.kind = 'WASTAGE' THEN m.delta_milli END), 0) AS wasted,
        coalesce(sum(CASE WHEN m.kind IN ('OPENING','COUNT','ADJUST') THEN m.delta_milli END), 0) AS adjusted
      FROM stock_item s LEFT JOIN stock_movement m ON m.stock_item_id = s.id AND m.created_at >= ? AND m.created_at < ?
      WHERE s.deleted_at IS NULL GROUP BY s.id ORDER BY lower(s.name)`, b.fromMs, b.fromMs, b.toMs)
      .map((r) => ({ material: r.name, opening: qty(r.opening, r.unit), purchased: qty(r.purchased, r.unit), used: qty(r.used, r.unit), wasted: qty(r.wasted, r.unit),
        adjusted: qty(r.adjusted, r.unit), closing: qty(r.opening + r.purchased - r.used - r.wasted + r.adjusted, r.unit) }));
    const columns: Column[] = [{ key: 'material', label: 'Material', type: 'text' }, { key: 'opening', label: 'Opening', type: 'qty' }, { key: 'purchased', label: 'Purchased', type: 'qty' },
      { key: 'used', label: 'Used in sales', type: 'qty' }, { key: 'wasted', label: 'Wasted', type: 'qty' }, { key: 'adjusted', label: 'Adjusted (counts, corrections)', type: 'qty' }, { key: 'closing', label: 'Closing', type: 'qty' }];
    return { columns, rows, totals: null, summary: [] };
  },
};

const purchases: Def = {
  key: 'purchases', title: 'Purchases', group: 'Inventory', description: 'Purchases from suppliers in the period (voided ones are listed but not counted).',
  build(ctx, b) {
    const rows = all<Row & { status: string; total: number }>(ctx.db, `SELECT p.created_at AS at, p.supplier_name AS supplier, coalesce(p.bill_no, '') AS billNo, coalesce(p.supplier_gstin, '') AS gstin,
        (SELECT group_concat(s.name, ', ') FROM purchase_line l JOIN stock_item s ON s.id = l.stock_item_id WHERE l.purchase_id = p.id) AS materials, p.status, p.total
      FROM purchase p WHERE p.created_at >= ? AND p.created_at < ? ORDER BY p.created_at`, b.fromMs, b.toMs)
      .map(({ status, total, ...r }) => ({ ...r, status: status === 'VOIDED' ? 'Voided' : 'Posted', amount: total }));
    const columns: Column[] = [{ key: 'at', label: 'Date', type: 'datetime' }, { key: 'supplier', label: 'Supplier', type: 'text' }, { key: 'billNo', label: 'Supplier bill', type: 'text' },
      { key: 'gstin', label: 'Supplier GSTIN', type: 'text' }, { key: 'materials', label: 'Materials', type: 'text' }, { key: 'status', label: 'Status', type: 'text' }, { key: 'amount', label: 'Amount', type: 'money' }];
    const totals = totalsOf(columns, rows.filter((r) => r.status === 'Posted'), 'Total (posted)');
    const bySupplier = new Map<string, number>();
    for (const r of rows as Row[]) if (r.status === 'Posted') bySupplier.set(String(r.supplier), (bySupplier.get(String(r.supplier)) ?? 0) + n(r.amount));
    return { columns, rows, totals, summary: [...bySupplier.entries()].sort((a, c) => c[1] - a[1]).slice(0, 4).map(([s, v]) => ({ label: s, value: v, type: 'money' as const })) };
  },
};

const DEFS: Def[] = [salesSummary, payments, hourly, channels, staff, discounts, items, categories, gstRates, hsn, bills, cancellations, shifts, stock, stockMovements, purchases];
export const REPORTS = DEFS.map(({ key, title, group, description }) => ({ key, title, group, description, usesDates: key !== 'stock' }));

function bounds(r: Range): Bounds {
  const ok = (d: string) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d);
  if (!ok(r.from) || !ok(r.to)) throw new AppError('VALIDATION', 'Dates must be YYYY-MM-DD.');
  const fromMs = Date.parse(`${r.from}T00:00:00Z`) - IST;
  const toMs = Date.parse(`${r.to}T00:00:00Z`) - IST + 86_400_000;
  if (toMs <= fromMs) throw new AppError('VALIDATION', 'The "from" date must be on or before the "to" date.');
  if (toMs - fromMs > 3 * 366 * 86_400_000) throw new AppError('VALIDATION', 'Choose at most 3 years at a time.');
  return { ...r, fromMs, toMs };
}

export function runReport(ctx: Ctx, actor: Actor, key: string, range: Range): ReportTable {
  assertPerm(actor, 'report.read');
  const def = DEFS.find((d) => d.key === key);
  if (!def) throw new AppError('NOT_FOUND', 'No such report.', 404);
  const b = bounds(range);
  return { key: def.key, title: def.title, description: def.description, from: b.from, to: b.to, generatedAt: Date.now(), ...def.build(ctx, b) };
}

// ---------------------------------------------------------------- CSV download

const rupees = (p: number) => { const a = Math.abs(p); return `${p < 0 ? '-' : ''}${Math.trunc(a / 100)}.${String(a % 100).padStart(2, '0')}`; };
const istText = (ms: number) => new Date(ms + IST).toISOString().slice(0, 16).replace('T', ' ');
const textCell = (s: string) => {
  const t = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; // neutralise spreadsheet formula injection in text
  return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};
function cell(v: string | number | null | undefined, type: ColType): string {
  if (v === null || v === undefined || v === '') return '';
  if (type === 'money') return rupees(Number(v)); // plain number so Excel can add it up
  if (type === 'int') return String(v);
  if (type === 'datetime') return istText(Number(v));
  return textCell(String(v));
}

/** The report as CSV for Excel: UTF-8 with BOM, amounts in rupees as plain numbers, a TOTAL row. */
export function reportCsv(ctx: Ctx, actor: Actor, key: string, range: Range): { filename: string; csv: string } {
  const t = runReport(ctx, actor, key, range);
  const lines = [t.columns.map((c) => textCell(c.label)).join(',')];
  for (const r of t.rows) lines.push(t.columns.map((c) => cell(r[c.key], c.type)).join(','));
  if (t.totals) lines.push(t.columns.map((c, i) => (i === 0 ? 'TOTAL' : cell(t.totals![c.key], c.type))).join(','));
  return { filename: `${t.key}_${t.from}_to_${t.to}.csv`, csv: '﻿' + lines.join('\r\n') + '\r\n' };
}
