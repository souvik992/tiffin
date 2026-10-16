import { all, get, AppError } from '../store/db.ts';
import { storeAt } from './store.ts';
import type { Ctx } from './ctx.ts';
import { camel } from './camel.ts';

export interface InvoiceView {
  id: string; orderId: string; deviceId: string; shiftId: string | null; docType: 'TAX_INVOICE' | 'CREDIT_NOTE'; seriesId: string; seqNo: number; invoiceNo: string;
  issuedAt: number; buyerGstin: string | null; placeOfSupply: string; tokenNo: number | null; grossTotal: number; discountTotal: number; taxableTotal: number;
  cgst: number; sgst: number; igst: number; cess: number; roundOff: number; grandTotal: number; status: 'ISSUED' | 'CANCELLED'; cancelReason: string | null;
  cancelledAt: number | null; cancelledBy: string | null; originalInvoiceId: string | null; originalInvoiceNo: string | null; createdBy: string; cashierName: string;
}
export interface InvoiceLineView {
  id: string; invoiceId: string; lineNo: number; itemId: string | null; sourceLineId: string | null; name: string; hsnCode: string | null; qtyMilli: number; unit: string;
  unitPrice: number; gross: number; discount: number; taxable: number; rateBp: number; cgst: number; sgst: number; igst: number; cess: number; lineTotal: number;
  modifiersJson: string; modifiers: Array<{ id: string; name: string; price: number }>; note: string | null;
}
export interface PaymentView { id: string; invoiceId: string; mode: string; amount: number; tendered: number | null; reference: string | null; shiftId: string | null; createdAt: number }
export interface OutletView { id: string; name: string; gstin: string | null; fssaiNo: string | null; stateCode: string; address: string | null; phone: string | null }
export interface InvoiceFull { invoice: InvoiceView; lines: InvoiceLineView[]; payments: PaymentView[]; outlet: OutletView; orderChannel: string }

export function loadInvoiceFull(ctx: Ctx, id: string): InvoiceFull {
  const row = get(ctx.db, `SELECT i.*, u.name AS cashier_name, oi.invoice_no AS original_invoice_no
      FROM invoice i JOIN app_user u ON u.id = i.created_by LEFT JOIN invoice oi ON oi.id = i.original_invoice_id WHERE i.id = ?`, id);
  if (!row) throw new AppError('NOT_FOUND', 'Invoice not found.', 404);
  const invoice = camel<InvoiceView>(row);
  const lines = all(ctx.db, 'SELECT * FROM invoice_line WHERE invoice_id = ? ORDER BY line_no', id).map((r) => {
    const l = camel<InvoiceLineView>(r);
    l.modifiers = JSON.parse(l.modifiersJson);
    return l;
  });
  const payments = all(ctx.db, 'SELECT * FROM payment WHERE invoice_id = ? ORDER BY created_at, rowid', id).map((r) => camel<PaymentView>(r));
  const outlet = camel<OutletView>(get(ctx.db, 'SELECT o.* FROM outlet o JOIN device d ON d.outlet_id = o.id WHERE d.id = ?', invoice.deviceId))!;
  // the store details valid when the bill was issued (Settings > Store keeps every change), so reprints never change
  const then = storeAt(ctx, outlet.id, invoice.issuedAt);
  if (then) Object.assign(outlet, then);
  const orderChannel = get<{ channel: string }>(ctx.db, 'SELECT channel FROM sale_order WHERE id = ?', invoice.orderId)?.channel ?? 'COUNTER';
  return { invoice, lines, payments, outlet, orderChannel };
}
