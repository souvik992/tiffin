import { all, get, run, AppError } from '../store/db.ts';
import type { Actor, Ctx } from './ctx.ts';
import { getDevice } from './ctx.ts';
import { runCommand } from './commands.ts';
import { audit } from './audit.ts';
import { emit } from './outbox.ts';
import { assertPerm } from './permissions.ts';
import { requireApproval } from './auth.ts';
import type { Override } from './auth.ts';
import { loadSettings } from './settings.ts';
import { assertDiskOk } from './disk.ts';
import { computeFor, enforceDiscountPolicy, getCart, getOrderRow, loadCartLines, openShiftRow } from './orders.ts';
import { checkInvariants } from '../core/tax.ts';
import { mulDivRound, sum } from '../core/money.ts';
import { istDay } from '../core/numbering.ts';
import { allocateNumber, bumpSummary, insertInvoice, modeCol } from './invoiceStore.ts';
import type { Deltas, InvoiceRecord, LineRecord, PaymentRecord } from './invoiceStore.ts';
import { loadInvoiceFull } from './invoiceView.ts';
import { appendJournal } from './journal.ts';
import { consumeForInvoice, reverseInvoiceConsumption } from './stock.ts';
import { queueInvoicePrints, reprintInvoice as reprintImpl } from './printing/jobs.ts';
import type { PrintSummary } from './printing/jobs.ts';
import { camelAll } from './camel.ts';

const MODES = ['CASH', 'UPI', 'CARD', 'WALLET', 'CREDIT', 'OTHER'];
export interface PaymentInput { mode: string; amount: number; tendered?: number | null; reference?: string | null }

export function validatePayments(ps: PaymentInput[], total: number): PaymentInput[] {
  if (!Array.isArray(ps)) throw new AppError('VALIDATION', 'payments must be a list.');
  if (total === 0) {
    if (ps.length) throw new AppError('PAYMENT_MISMATCH', 'A zero-value bill takes no payment.', 422);
    return [];
  }
  if (ps.length === 0) throw new AppError('PAYMENT_REQUIRED', 'Add at least one payment.', 422);
  if (ps.length > 6) throw new AppError('VALIDATION', 'At most 6 payments per bill.');
  let paid = 0;
  for (const p of ps) {
    if (!MODES.includes(p.mode)) throw new AppError('VALIDATION', `Unknown payment mode "${p.mode}".`);
    if (!Number.isSafeInteger(p.amount) || p.amount <= 0) throw new AppError('VALIDATION', 'Payment amount must be a positive whole number of paise.');
    if (p.tendered !== undefined && p.tendered !== null) {
      if (p.mode !== 'CASH') throw new AppError('VALIDATION', 'Tendered amount applies to cash only.');
      if (!Number.isSafeInteger(p.tendered) || p.tendered < p.amount) throw new AppError('CASH_TENDERED_TOO_LOW', 'Cash tendered is less than the amount.', 422);
    }
    if (p.reference && p.reference.length > 60) throw new AppError('VALIDATION', 'Payment reference is too long.');
    paid += p.amount;
  }
  if (paid !== total) throw new AppError('PAYMENT_MISMATCH', 'Payments must add up exactly to the bill total.', 422, { expected: total, got: paid });
  return ps;
}

const taxOf = (v: { cgst: number; sgst: number; igst: number; cess: number }) => v.cgst + v.sgst + v.igst + v.cess;

export function finalizeInvoice(ctx: Ctx, actor: Actor, requestId: string, input: { orderId: string; payments: PaymentInput[]; override?: Override; print?: { receipt?: boolean; kot?: boolean } }) {
  return runCommand(ctx, requestId, 'invoice.finalize', actor, (h) => {
    assertPerm(actor, 'invoice.finalize');
    assertDiskOk(ctx);
    const order = getOrderRow(ctx, input.orderId);
    if (order.status === 'INVOICED') throw new AppError('ORDER_ALREADY_INVOICED', 'This order has already been billed.', 409);
    if (order.status !== 'DRAFT' && order.status !== 'HELD') throw new AppError('ORDER_NOT_OPEN', `This order is ${order.status.toLowerCase()}.`, 409);
    const settings = loadSettings(ctx);
    const shift = openShiftRow(ctx);
    if (settings.requireShift && !shift) throw new AppError('NO_OPEN_SHIFT', 'Open a shift before billing.', 409);
    const lines = loadCartLines(ctx, order.id);
    if (lines.length === 0) throw new AppError('EMPTY_CART', 'Add at least one item.', 422);
    enforceDiscountPolicy(ctx, actor, order.id, input.override);
    const fresh = getOrderRow(ctx, order.id);
    const { calc, placeOfSupply, coupon } = computeFor(ctx, fresh, lines, settings);
    if (coupon?.problem) throw new AppError('COUPON_INVALID', `${coupon.problem} Remove the coupon or change the bill.`, 409);
    const bad = checkInvariants(calc);
    if (bad.length) throw new AppError('INTERNAL_TOTALS', `Totals failed self-check: ${bad[0]}`, 500);
    const pays = validatePayments(input.payments, calc.grandTotal);

    ctx.hooks.fault?.('finalize.validated');
    const now = ctx.clock.now();
    const device = getDevice(ctx);
    const num = allocateNumber(ctx, device.id, 'TAX_INVOICE', now);
    const invoiceId = ctx.ids.next();
    const rec: InvoiceRecord = {
      id: invoiceId, orderId: order.id, deviceId: device.id, shiftId: shift?.id ?? null, docType: 'TAX_INVOICE', seriesId: num.seriesId, seqNo: num.seqNo,
      invoiceNo: num.invoiceNo, issuedAt: now, buyerGstin: fresh.buyer_gstin, placeOfSupply, tokenNo: order.token_no,
      grossTotal: calc.grossTotal, discountTotal: calc.discountTotal, taxableTotal: calc.taxableTotal, cgst: calc.cgst, sgst: calc.sgst, igst: calc.igst, cess: calc.cess,
      roundOff: calc.roundOff, grandTotal: calc.grandTotal, status: 'ISSUED', originalInvoiceId: null, createdBy: actor.userId,
    };
    const lrecs: LineRecord[] = lines.map((l, i) => {
      const c = calc.lines[i]!;
      return { id: ctx.ids.next(), lineNo: i + 1, itemId: l.item_id, sourceLineId: null, name: l.name, hsnCode: l.hsn_code, qtyMilli: l.qty_milli, unit: l.unit, unitPrice: l.unit_price,
        gross: c.gross, discount: c.discount, taxable: c.taxable, rateBp: c.rateBp, cgst: c.cgst, sgst: c.sgst, igst: c.igst, cess: c.cess, lineTotal: c.lineTotal, modifiersJson: l.modifiers_json, note: l.note };
    });
    const precs: PaymentRecord[] = pays.map((p) => ({ id: ctx.ids.next(), mode: p.mode, amount: p.amount, tendered: p.tendered ?? null, reference: p.reference ?? null, shiftId: shift?.id ?? null, createdAt: now }));
    insertInvoice(ctx, rec, lrecs, precs);
    const stock = consumeForInvoice(ctx, invoiceId, lrecs, actor.userId, now); // recipes; never blocks the bill

    run(ctx.db, "UPDATE sale_order SET status = 'INVOICED', shift_id = ?, updated_at = ? WHERE id = ?", shift?.id ?? null, now, order.id);
    const d: Deltas = { invoices: 1, sales_total: rec.grandTotal, tax_total: taxOf(rec), discount_total: rec.discountTotal };
    for (const p of precs) d[modeCol(p.mode)] = (d[modeCol(p.mode)] ?? 0) + p.amount;
    bumpSummary(ctx, istDay(now), device.id, d);
    audit(ctx, actor.userId, 'invoice.finalize', 'invoice', invoiceId, { invoiceNo: rec.invoiceNo, total: rec.grandTotal });
    const full = loadInvoiceFull(ctx, invoiceId);
    emit(ctx, 'invoice', invoiceId, 'create', full);
    const print = queueInvoicePrints(ctx, full, { copyNo: 1, kot: input.print?.kot !== false, receipt: input.print?.receipt !== false, cashierName: actor.name });
    ctx.hooks.fault?.('finalize.before_commit');

    h.after(() => { ctx.hooks.fault?.('finalize.after_commit'); appendJournal(ctx, { v: 1, type: 'invoice', at: now, full, stock }); });
    h.after(() => ctx.events.emit('invoice', { id: invoiceId, invoiceNo: rec.invoiceNo, grandTotal: rec.grandTotal }));
    const cashTendered = pays.filter((p) => p.mode === 'CASH' && p.tendered).reduce((s, p) => s + (p.tendered! - p.amount), 0);
    return { invoice: full.invoice, lines: full.lines, payments: full.payments, changeDue: cashTendered, print };
  }, { compact: (r) => ({ invoiceId: r.invoice.id, changeDue: r.changeDue, print: r.print }), expand: (st) => expandInvoice(ctx, st as { invoiceId: string; changeDue: number; print?: PrintSummary }) });
}

export function cancelInvoice(ctx: Ctx, actor: Actor, requestId: string, input: { invoiceId: string; reason: string; override?: Override }) {
  return runCommand(ctx, requestId, 'invoice.cancel', actor, (h) => {
    const approver = requireApproval(ctx, actor, 'invoice.cancel', input.override);
    const reason = (input.reason ?? '').trim();
    if (!reason || reason.length > 200) throw new AppError('VALIDATION', 'A cancellation reason is required (max 200 characters).');
    const f = loadInvoiceFull(ctx, input.invoiceId);
    const iv = f.invoice;
    if (iv.docType !== 'TAX_INVOICE') throw new AppError('VALIDATION', 'Only a tax invoice can be cancelled.');
    if (iv.status !== 'ISSUED') throw new AppError('ALREADY_CANCELLED', 'This invoice is already cancelled.', 409);
    const now = ctx.clock.now();
    if (istDay(now) !== istDay(iv.issuedAt)) throw new AppError('USE_CREDIT_NOTE', 'Only same-day invoices can be cancelled. Issue a credit note instead.', 409);
    const shift = openShiftRow(ctx);
    if (iv.shiftId && (!shift || shift.id !== iv.shiftId)) throw new AppError('USE_CREDIT_NOTE', 'That shift is closed. Issue a credit note instead.', 409);
    if (get(ctx.db, "SELECT 1 FROM invoice WHERE original_invoice_id = ? AND doc_type = 'CREDIT_NOTE' AND status = 'ISSUED'", iv.id)) {
      throw new AppError('HAS_CREDIT_NOTES', 'This invoice already has credit notes and cannot be cancelled.', 409);
    }
    run(ctx.db, "UPDATE invoice SET status = 'CANCELLED', cancel_reason = ?, cancelled_at = ?, cancelled_by = ? WHERE id = ? AND status = 'ISSUED'", reason, now, approver, iv.id);
    const d: Deltas = { invoices: -1, cancelled: 1, sales_total: -iv.grandTotal, tax_total: -taxOf(iv), discount_total: -iv.discountTotal };
    for (const p of f.payments) d[modeCol(p.mode)] = (d[modeCol(p.mode)] ?? 0) - p.amount;
    bumpSummary(ctx, istDay(iv.issuedAt), iv.deviceId, d);
    audit(ctx, actor.userId, 'invoice.cancel', 'invoice', iv.id, { reason, approver, invoiceNo: iv.invoiceNo });
    emit(ctx, 'invoice', iv.id, 'cancel', { id: iv.id, reason });
    const stock = reverseInvoiceConsumption(ctx, iv.id, approver, now);
    h.after(() => appendJournal(ctx, { v: 1, type: 'cancel', at: now, invoiceId: iv.id, reason, cancelledBy: approver, stock }));
    return { id: iv.id, status: 'CANCELLED' as const };
  });
}

interface CreditOrig { id: string; round_off: number }
type Amounts = Record<(typeof AMOUNT_FIELDS)[number], number>;

/**
 * The amounts of a (partial) return, shared by the preview and the real credit note so they can never differ.
 * Each line is scaled from the original; the final return of a line takes exactly what is left (no paisa drift),
 * and a return that completes the whole bill also returns the original round-off.
 */
function computeCredit(ctx: Ctx, orig: CreditOrig, lines: Array<{ invoiceLineId: string; qtyMilli: number }>) {
  if (!Array.isArray(lines) || lines.length === 0) throw new AppError('VALIDATION', 'Choose at least one line to return.');
  const origLines = all<AmountRow>(ctx.db, 'SELECT * FROM invoice_line WHERE invoice_id = ? ORDER BY line_no', orig.id);
  const prior = priorReturns(ctx, orig.id);
  const priorRoundOff = get<{ r: number | null }>(ctx.db, "SELECT sum(round_off) r FROM invoice WHERE original_invoice_id = ? AND doc_type = 'CREDIT_NOTE' AND status = 'ISSUED'", orig.id)?.r ?? 0;
  const req = new Map<string, number>();
  for (const l of lines) {
    if (req.has(l.invoiceLineId)) throw new AppError('VALIDATION', 'A line appears twice in the request.');
    if (!Number.isSafeInteger(l.qtyMilli) || l.qtyMilli <= 0) throw new AppError('VALIDATION', 'Return quantity must be a positive whole number (thousandths).');
    req.set(l.invoiceLineId, l.qtyMilli);
  }
  const items: Array<{ ol: AmountRow; qtyMilli: number; amt: Amounts; lineTotal: number }> = [];
  for (const ol of origLines) {
    const q = req.get(ol.id);
    if (q === undefined) continue;
    const p = prior.get(ol.id);
    const remaining = ol.qty_milli - Number(p?.qty_milli ?? 0);
    if (q > remaining) throw new AppError('CREDIT_EXCEEDS', `Cannot return more than was sold (${ol.name}).`, 422, { lineId: ol.id, remainingQtyMilli: remaining });
    const amt = {} as Amounts;
    for (const f of AMOUNT_FIELDS) {
      // The final return of a line takes exactly what is left, so repeated partial returns never drift by a paisa.
      amt[f] = q === remaining ? ol[f] - Number(p?.[f] ?? 0) : mulDivRound(ol[f], q, ol.qty_milli);
      if (amt[f] < 0) throw new AppError('INTERNAL_TOTALS', 'Credit amount went negative.', 500);
    }
    items.push({ ol, qtyMilli: q, amt, lineTotal: amt.taxable + amt.cgst + amt.sgst + amt.igst + amt.cess });
  }
  if (items.length !== req.size) throw new AppError('VALIDATION', 'One or more lines do not belong to this invoice.');
  const fully = origLines.every((ol) => Number(prior.get(ol.id)?.qty_milli ?? 0) + (req.get(ol.id) ?? 0) === ol.qty_milli);
  const roundOff = fully ? orig.round_off - Number(priorRoundOff) : 0;
  const total = sum(items.map((x) => x.lineTotal)) + roundOff;
  if (total <= 0) throw new AppError('VALIDATION', 'The credit note total must be greater than zero.', 422);
  return { items, roundOff, total };
}

function priorReturns(ctx: Ctx, invoiceId: string) {
  const rows = all<Record<string, number | string>>(ctx.db, `
      SELECT il.source_line_id AS sid, sum(il.qty_milli) AS qty_milli, sum(il.gross) AS gross, sum(il.discount) AS discount, sum(il.taxable) AS taxable,
             sum(il.cgst) AS cgst, sum(il.sgst) AS sgst, sum(il.igst) AS igst, sum(il.cess) AS cess
        FROM invoice_line il JOIN invoice i ON i.id = il.invoice_id
       WHERE i.original_invoice_id = ? AND i.doc_type = 'CREDIT_NOTE' AND i.status = 'ISSUED' GROUP BY il.source_line_id`, invoiceId);
  return new Map(rows.map((r) => [r.sid as string, r]));
}

function issuedTaxInvoice(ctx: Ctx, invoiceId: string): CreditOrig {
  const orig = get<{ id: string; doc_type: string; status: string; round_off: number }>(ctx.db, 'SELECT id, doc_type, status, round_off FROM invoice WHERE id = ?', invoiceId);
  if (!orig) throw new AppError('NOT_FOUND', 'Invoice not found.', 404);
  if (orig.doc_type !== 'TAX_INVOICE' || orig.status !== 'ISSUED') throw new AppError('VALIDATION', 'Credit notes can only be raised against an issued tax invoice.');
  return orig;
}

/** What can still be returned from a bill, line by line. */
export function creditNoteOptions(ctx: Ctx, invoiceId: string) {
  const orig = issuedTaxInvoice(ctx, invoiceId);
  const prior = priorReturns(ctx, orig.id);
  const lines = all<{ id: string; name: string; qty_milli: number; unit: string; line_total: number }>(ctx.db, 'SELECT id, name, qty_milli, unit, line_total FROM invoice_line WHERE invoice_id = ? ORDER BY line_no', orig.id)
    .map((l) => {
      const returned = Number(prior.get(l.id)?.qty_milli ?? 0);
      return { invoiceLineId: l.id, name: l.name, unit: l.unit, soldQtyMilli: l.qty_milli, returnedQtyMilli: returned, remainingQtyMilli: l.qty_milli - returned, lineTotal: l.line_total };
    });
  return { invoiceId: orig.id, lines };
}

/** The refund amount for a return, computed exactly as the credit note will be (nothing is written). */
export function previewCreditNote(ctx: Ctx, invoiceId: string, lines: Array<{ invoiceLineId: string; qtyMilli: number }>) {
  const c = computeCredit(ctx, issuedTaxInvoice(ctx, invoiceId), lines);
  return { lines: c.items.map((x) => ({ invoiceLineId: x.ol.id, name: x.ol.name, qtyMilli: x.qtyMilli, amount: x.lineTotal })), roundOff: c.roundOff, total: c.total };
}

/**
 * Checks a payment split against the bill without writing anything: what is left to pay and the change.
 * The UI shows these numbers; it never adds up money itself (RULES.md rule 2).
 */
export function checkPayments(ctx: Ctx, orderId: string, payments: PaymentInput[]) {
  const total = getCart(ctx, orderId).totals.grandTotal;
  let paid = 0, changeDue = 0;
  for (const p of payments) {
    if (Number.isSafeInteger(p.amount) && p.amount > 0) paid += p.amount;
    if (p.mode === 'CASH' && typeof p.tendered === 'number' && Number.isSafeInteger(p.tendered) && p.tendered > p.amount) changeDue += p.tendered - p.amount;
  }
  const remaining = total - paid;
  let message: string | null = null;
  if (total > 0 && payments.length === 0) message = 'Add a payment.';
  else if (remaining < 0) message = 'The payments are more than the bill. Reduce one of them.';
  else {
    try { validatePayments(payments, total); } catch (e) {
      // "must add up" only means something is still left to pay: that shows as the remaining amount, not as an error
      if (!(e instanceof AppError && e.code === 'PAYMENT_MISMATCH' && remaining > 0)) message = e instanceof AppError ? e.message : 'Check the payments.';
    }
  }
  return { total, paid, remaining, changeDue, ok: message === null && remaining === 0, message };
}

interface AmountRow { id: string; qty_milli: number; gross: number; discount: number; taxable: number; cgst: number; sgst: number; igst: number; cess: number; line_total: number; name: string; item_id: string | null; hsn_code: string | null; unit: string; unit_price: number; rate_bp: number; modifiers_json: string; note: string | null; line_no: number }
const AMOUNT_FIELDS = ['gross', 'discount', 'taxable', 'cgst', 'sgst', 'igst', 'cess'] as const;

export function createCreditNote(ctx: Ctx, actor: Actor, requestId: string, input: { invoiceId: string; lines: Array<{ invoiceLineId: string; qtyMilli: number }>; reason: string; refunds: PaymentInput[]; override?: Override }) {
  return runCommand(ctx, requestId, 'creditnote.create', actor, (h) => {
    const approver = requireApproval(ctx, actor, 'creditnote.create', input.override);
    assertDiskOk(ctx);
    const reason = (input.reason ?? '').trim();
    if (!reason || reason.length > 200) throw new AppError('VALIDATION', 'A reason is required (max 200 characters).');
    if (!Array.isArray(input.lines) || input.lines.length === 0) throw new AppError('VALIDATION', 'Choose at least one line to return.');
    const orig = get<{ id: string; order_id: string; device_id: string; doc_type: string; status: string; buyer_gstin: string | null; place_of_supply: string; round_off: number }>(
      ctx.db, 'SELECT id, order_id, device_id, doc_type, status, buyer_gstin, place_of_supply, round_off FROM invoice WHERE id = ?', input.invoiceId);
    if (!orig) throw new AppError('NOT_FOUND', 'Invoice not found.', 404);
    if (orig.doc_type !== 'TAX_INVOICE' || orig.status !== 'ISSUED') throw new AppError('VALIDATION', 'Credit notes can only be raised against an issued tax invoice.');
    const settings = loadSettings(ctx);
    const shift = openShiftRow(ctx);
    if (settings.requireShift && !shift) throw new AppError('NO_OPEN_SHIFT', 'Open a shift before issuing a credit note.', 409);

    const calc = computeCredit(ctx, orig, input.lines);
    const lrecs: LineRecord[] = calc.items.map((it, i) => ({ id: ctx.ids.next(), lineNo: i + 1, itemId: it.ol.item_id, sourceLineId: it.ol.id, name: it.ol.name, hsnCode: it.ol.hsn_code, qtyMilli: it.qtyMilli, unit: it.ol.unit, unitPrice: it.ol.unit_price,
      gross: it.amt.gross, discount: it.amt.discount, taxable: it.amt.taxable, rateBp: it.ol.rate_bp, cgst: it.amt.cgst, sgst: it.amt.sgst, igst: it.amt.igst, cess: it.amt.cess, lineTotal: it.lineTotal, modifiersJson: it.ol.modifiers_json, note: it.ol.note }));
    const roundOff = calc.roundOff;
    const grand = calc.total;
    const refunds = validatePayments(input.refunds, grand);

    const now = ctx.clock.now();
    const num = allocateNumber(ctx, orig.device_id, 'CREDIT_NOTE', now);
    const id = ctx.ids.next();
    const rec: InvoiceRecord = {
      id, orderId: orig.order_id, deviceId: orig.device_id, shiftId: shift?.id ?? null, docType: 'CREDIT_NOTE', seriesId: num.seriesId, seqNo: num.seqNo, invoiceNo: num.invoiceNo,
      issuedAt: now, buyerGstin: orig.buyer_gstin, placeOfSupply: orig.place_of_supply, tokenNo: null,
      grossTotal: sum(lrecs.map((l) => l.gross)), discountTotal: sum(lrecs.map((l) => l.discount)), taxableTotal: sum(lrecs.map((l) => l.taxable)),
      cgst: sum(lrecs.map((l) => l.cgst)), sgst: sum(lrecs.map((l) => l.sgst)), igst: sum(lrecs.map((l) => l.igst)), cess: sum(lrecs.map((l) => l.cess)),
      roundOff, grandTotal: grand, status: 'ISSUED', originalInvoiceId: orig.id, createdBy: actor.userId,
    };
    const precs: PaymentRecord[] = refunds.map((p) => ({ id: ctx.ids.next(), mode: p.mode, amount: p.amount, tendered: null, reference: p.reference ?? null, shiftId: shift?.id ?? null, createdAt: now }));
    insertInvoice(ctx, rec, lrecs, precs);
    const d: Deltas = { credit_notes: 1, refund_total: grand, tax_total: -taxOf(rec) };
    for (const p of precs) d[modeCol(p.mode)] = (d[modeCol(p.mode)] ?? 0) - p.amount;
    bumpSummary(ctx, istDay(now), orig.device_id, d);
    audit(ctx, actor.userId, 'creditnote.create', 'invoice', id, { against: orig.id, total: grand, reason, approver });
    const full = loadInvoiceFull(ctx, id);
    emit(ctx, 'invoice', id, 'create', full);
    const print = queueInvoicePrints(ctx, full, { copyNo: 1, kot: false });
    h.after(() => appendJournal(ctx, { v: 1, type: 'invoice', at: now, full }));
    return { invoice: full.invoice, lines: full.lines, payments: full.payments, changeDue: 0, print };
  }, { compact: (r) => ({ invoiceId: r.invoice.id, changeDue: 0, print: r.print }), expand: (st) => expandInvoice(ctx, st as { invoiceId: string; changeDue: number }) });
}

const NO_PRINT_INFO: PrintSummary = { receipts: 0, kitchenTickets: 0, warnings: [] };
function expandInvoice(ctx: Ctx, st: { invoiceId: string; changeDue: number; print?: PrintSummary }) {
  const f = loadInvoiceFull(ctx, st.invoiceId);
  return { invoice: f.invoice, lines: f.lines, payments: f.payments, changeDue: st.changeDue, print: st.print ?? NO_PRINT_INFO };
}

export function reprintInvoice(ctx: Ctx, actor: Actor, requestId: string, input: { invoiceId: string; override?: Override }) {
  return reprintImpl(ctx, actor, requestId, input, (perm) => requireApproval(ctx, actor, perm, input.override));
}

export interface InvoiceFilter { fromMs?: number; toMs?: number; status?: string; docType?: string; q?: string; limit?: number; offset?: number }
export function listInvoices(ctx: Ctx, f: InvoiceFilter = {}) {
  const where: string[] = []; const params: Array<string | number> = [];
  if (f.fromMs !== undefined) { where.push('i.issued_at >= ?'); params.push(f.fromMs); }
  if (f.toMs !== undefined) { where.push('i.issued_at < ?'); params.push(f.toMs); }
  if (f.status) { where.push('i.status = ?'); params.push(f.status); }
  if (f.docType) { where.push('i.doc_type = ?'); params.push(f.docType); }
  if (f.q) { where.push('i.invoice_no LIKE ?'); params.push(`%${f.q.replace(/[%_]/g, '')}%`); }
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
  const rows = all(ctx.db, `SELECT i.id, i.invoice_no, i.doc_type, i.status, i.issued_at, i.grand_total, i.token_no, i.original_invoice_id, u.name AS cashier_name
      FROM invoice i JOIN app_user u ON u.id = i.created_by ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY i.issued_at DESC, i.seq_no DESC LIMIT ? OFFSET ?`, ...params, limit, f.offset ?? 0);
  return camelAll(rows);
}

export function getInvoice(ctx: Ctx, id: string) {
  const f = loadInvoiceFull(ctx, id);
  const creditNotes = camelAll(all(ctx.db, "SELECT id, invoice_no, grand_total, issued_at FROM invoice WHERE original_invoice_id = ? AND doc_type = 'CREDIT_NOTE' AND status = 'ISSUED' ORDER BY issued_at", id));
  return { invoice: f.invoice, lines: f.lines, payments: f.payments, creditNotes };
}
