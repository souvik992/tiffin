import { all, get, run, AppError } from '../store/db.ts';
import type { Actor, Ctx } from './ctx.ts';
import { runCommand } from './commands.ts';
import { audit } from './audit.ts';
import { emit } from './outbox.ts';
import { assertPerm } from './permissions.ts';
import { requireApproval } from './auth.ts';
import type { Override } from './auth.ts';
import { appendJournal } from './journal.ts';
import { openShiftRow } from './orders.ts';
import { zReport } from './shifts.ts';
import { paymentGuardProblem } from './paymentGuards.ts';
import { insertCorrection } from './invoiceStore.ts';
import type { PaymentCorrectionRecord } from './invoiceStore.ts';
import { buildTextReport } from './printing/receipt.ts';
import { enqueueJob } from './printing/jobs.ts';
import { EscPos } from './printing/escpos.ts';
import { colsFor } from './printing/transports.ts';
import type { PrinterRow } from './printing/transports.ts';
import { formatINR } from '../core/money.ts';
import { istDateTime, istDay } from '../core/numbering.ts';

/**
 * Counter actions around billing: the mid-shift X-report, opening the cash drawer by hand, marking an item
 * "not available today", and correcting the payment mode of a bill after billing.
 */

const MODES = ['CASH', 'UPI', 'CARD', 'WALLET', 'CREDIT', 'OTHER'];
const receiptPrinters = (ctx: Ctx) => all<PrinterRow>(ctx.db, 'SELECT * FROM printer WHERE active = 1 AND is_receipt = 1');

// ---------------------------------------------------------------- X-report

/** The open shift's figures so far (the Z-report without closing). */
export function xReport(ctx: Ctx, actor: Actor) {
  assertPerm(actor, 'shift.report');
  const s = openShiftRow(ctx);
  if (!s) throw new AppError('NO_OPEN_SHIFT', 'There is no open shift.', 409);
  return zReport(ctx, s.id);
}

export function printXReport(ctx: Ctx, actor: Actor, requestId: string) {
  return runCommand(ctx, requestId, 'shift.x_report', actor, () => {
    const r = xReport(ctx, actor);
    const now = ctx.clock.now();
    const rows: Array<[string, string] | string> = [
      ['Opened', istDateTime(r.openedAt)], ['Printed', istDateTime(now)], '', ['Invoices', String(r.invoices)], ['Sales', formatINR(Number(r.sales), '')],
      ['Discounts', formatINR(Number(r.discounts), '')], ['Cancelled', `${r.cancelled} / ${formatINR(Number(r.cancelledAmount), '')}`],
      ['Refunds', `${r.creditNotes} / ${formatINR(Number(r.refunds), '')}`], '', ...Object.entries(r.byMode).map(([m, a]): [string, string] => [m, formatINR(Number(a), '')]), '',
      ['Opening cash', formatINR(r.cash.opening, '')], ['Cash in drawer now', formatINR(r.cash.expected, '')], '', 'Shift still open: not a closing report.',
    ];
    let queued = 0;
    for (const pr of receiptPrinters(ctx)) if (enqueueJob(ctx, { kind: 'REPORT', refId: r.shiftId, printerId: pr.id, payload: buildTextReport(colsFor(pr.width_mm), 'SHIFT REPORT (X)', rows), dedupeKey: `xreport:${requestId}:${pr.id}` })) queued++;
    if (queued === 0) throw new AppError('NO_RECEIPT_PRINTER', 'No receipt printer is set up. The report is on the screen.', 409);
    audit(ctx, actor.userId, 'shift.x_report', 'shift', r.shiftId);
    return { queued };
  });
}

// ---------------------------------------------------------------- cash drawer

/** Opens the drawer without a sale (change for a customer, a cash count). Manager, or a cashier with a manager's PIN; always with a reason. */
export function openDrawer(ctx: Ctx, actor: Actor, requestId: string, input: { reason: string; override?: Override }) {
  return runCommand(ctx, requestId, 'drawer.open', actor, () => {
    const approver = requireApproval(ctx, actor, 'drawer.open', input.override);
    const reason = (input.reason ?? '').trim();
    if (reason.length < 2 || reason.length > 120) throw new AppError('VALIDATION', 'Say why the drawer is opened (for example "change for a customer").');
    const pr = receiptPrinters(ctx).find((p) => p.drawer === 1);
    if (!pr) throw new AppError('NO_DRAWER', 'No printer with a cash drawer is set up. Turn on "Cash drawer" for the receipt printer in Settings > Printer setup.', 409);
    const job = enqueueJob(ctx, { kind: 'TEST', refId: pr.id, printerId: pr.id, payload: new EscPos(colsFor(pr.width_mm)).init().drawerKick().bytes(), dedupeKey: `drawer-open:${requestId}` });
    audit(ctx, actor.userId, 'drawer.open', 'printer', pr.id, { reason, approver, shiftId: openShiftRow(ctx)?.id ?? null });
    return { jobId: job };
  });
}

// ---------------------------------------------------------------- not available today

/** Marks an item sold out for the rest of today (IST), or available again. It comes back by itself tomorrow. */
export function setItemAvailability(ctx: Ctx, actor: Actor, requestId: string, itemId: string, available: boolean) {
  return runCommand(ctx, requestId, 'item.availability', actor, () => {
    assertPerm(actor, 'catalog.availability');
    const day = available ? null : istDay(ctx.clock.now());
    const r = run(ctx.db, 'UPDATE item SET unavailable_on = ?, version = version + 1, updated_at = ? WHERE id = ? AND deleted_at IS NULL', day, ctx.clock.now(), itemId);
    if (Number(r.changes) === 0) throw new AppError('NOT_FOUND', 'Item not found.', 404);
    audit(ctx, actor.userId, 'item.availability', 'item', itemId, { available });
    emit(ctx, 'item', itemId, 'upsert', { id: itemId, unavailableOn: day });
    return { itemId, availableToday: available };
  });
}

/** True when the item was marked "not available" today. */
export function unavailableToday(ctx: Ctx, unavailableOn: string | null | undefined): boolean {
  return Boolean(unavailableOn) && unavailableOn === istDay(ctx.clock.now());
}

// ---------------------------------------------------------------- payment mode correction

/**
 * The cashier pressed the wrong payment mode (entered Cash, the customer paid by UPI). Bills and payments are never
 * edited: a correction is its own permanent record, and every report then counts the payment under the new mode.
 * Only for bills of the shift that is still open, so the closing (Z) cash count stays right; a manager approves.
 */
export function correctPaymentMode(ctx: Ctx, actor: Actor, requestId: string, input: { paymentId: string; toMode: string; reference?: string | null; reason: string; override?: Override }) {
  return runCommand(ctx, requestId, 'payment.correct', actor, (h) => {
    const approver = requireApproval(ctx, actor, 'payment.correct', input.override);
    const p = get<{ id: string; invoice_id: string; mode: string; amount: number; shift_id: string | null; status: string; doc_type: string; device_id: string; issued_at: number; invoice_no: string }>(ctx.db,
      `SELECT p.id, p.invoice_id, p.mode, p.amount, p.shift_id, i.status, i.doc_type, i.device_id, i.issued_at, i.invoice_no
       FROM payment_effective p JOIN invoice i ON i.id = p.invoice_id WHERE p.id = ?`, input.paymentId);
    if (!p) throw new AppError('NOT_FOUND', 'Payment not found.', 404);
    if (p.doc_type !== 'TAX_INVOICE') throw new AppError('VALIDATION', 'Refunds on credit notes cannot be changed here.');
    if (p.status !== 'ISSUED') throw new AppError('VALIDATION', 'This bill is cancelled.', 409);
    const shift = openShiftRow(ctx);
    if (!shift || p.shift_id !== shift.id) throw new AppError('SHIFT_CLOSED', 'Only bills of the shift that is still open can be changed: a closed shift\'s cash count is final.', 409);
    const guarded = paymentGuardProblem(ctx, p.invoice_id); // e.g. paid on a payment machine (add-on)
    if (guarded) throw new AppError('PAYMENT_LOCKED', guarded, 409);
    if (!MODES.includes(input.toMode)) throw new AppError('VALIDATION', 'Choose a payment mode.');
    if (input.toMode === p.mode) throw new AppError('VALIDATION', `This payment is already ${p.mode}.`);
    const reason = (input.reason ?? '').trim();
    if (reason.length < 3 || reason.length > 200) throw new AppError('VALIDATION', 'Say why the payment mode is changed (for example "customer paid by UPI").');
    const reference = input.toMode === 'CASH' ? null : (input.reference ?? '').trim().slice(0, 60) || null;
    const c: PaymentCorrectionRecord = { id: ctx.ids.next(), invoiceId: p.invoice_id, paymentId: p.id, fromMode: p.mode, toMode: input.toMode, amount: p.amount, reference, reason,
      shiftId: shift.id, createdBy: actor.userId, approvedBy: approver, createdAt: ctx.clock.now() };
    insertCorrection(ctx, c, p.device_id, p.issued_at);
    audit(ctx, actor.userId, 'payment.correct', 'invoice', p.invoice_id, { invoiceNo: p.invoice_no, from: p.mode, to: input.toMode, amount: p.amount, reason, approver });
    emit(ctx, 'payment', p.id, 'correct', c);
    h.after(() => appendJournal(ctx, { v: 1, type: 'payment_correction', at: c.createdAt, correction: c, deviceId: p.device_id, issuedAt: p.issued_at }));
    return { invoiceId: p.invoice_id, paymentId: p.id, fromMode: p.mode, toMode: input.toMode };
  });
}
