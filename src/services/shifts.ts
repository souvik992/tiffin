import { all, get, run, AppError } from '../store/db.ts';
import type { Actor, Ctx } from './ctx.ts';
import { getDevice } from './ctx.ts';
import { runCommand } from './commands.ts';
import { audit } from './audit.ts';
import { emit } from './outbox.ts';
import { assertPerm, can } from './permissions.ts';
import { appendJournal } from './journal.ts';
import { buildTextReport } from './printing/receipt.ts';
import { colsFor } from './printing/transports.ts';
import type { PrinterRow } from './printing/transports.ts';
import { enqueueJob } from './printing/jobs.ts';
import { openShiftRow } from './orders.ts';
import { camelAll } from './camel.ts';
import { formatINR } from '../core/money.ts';
import { istDateTime } from '../core/numbering.ts';

const MAX_CASH = 1_000_000_000;

export function openShift(ctx: Ctx, actor: Actor, requestId: string, input: { openingCash: number }) {
  return runCommand(ctx, requestId, 'shift.open', actor, (h) => {
    assertPerm(actor, 'shift.use');
    if (!Number.isSafeInteger(input.openingCash) || input.openingCash < 0 || input.openingCash > MAX_CASH) throw new AppError('VALIDATION', 'Opening cash must be a non-negative whole number of paise.');
    if (openShiftRow(ctx)) throw new AppError('SHIFT_ALREADY_OPEN', 'A shift is already open on this counter.', 409);
    const id = ctx.ids.next(); const now = ctx.clock.now(); const device = getDevice(ctx);
    run(ctx.db, 'INSERT INTO shift(id, device_id, user_id, opened_at, opening_cash) VALUES (?,?,?,?,?)', id, device.id, actor.userId, now, input.openingCash);
    audit(ctx, actor.userId, 'shift.open', 'shift', id, { openingCash: input.openingCash });
    emit(ctx, 'shift', id, 'open', { id, openedAt: now, openingCash: input.openingCash });
    h.after(() => appendJournal(ctx, { v: 1, type: 'shift_open', at: now, shift: { id, deviceId: device.id, userId: actor.userId, openedAt: now, openingCash: input.openingCash } }));
    return { id, openedAt: now, openingCash: input.openingCash };
  });
}

export function currentShift(ctx: Ctx) {
  const s = openShiftRow(ctx);
  return s ? { id: s.id, userId: s.user_id, openedAt: s.opened_at, openingCash: s.opening_cash } : null;
}

const SIGNED = (col: string) => `CASE WHEN i.doc_type = 'TAX_INVOICE' THEN ${col} ELSE -${col} END`;

export function zReport(ctx: Ctx, shiftId: string) {
  const s = get<{ id: string; device_id: string; user_id: string; opened_at: number; closed_at: number | null; opening_cash: number; expected_cash: number | null; counted_cash: number | null }>(ctx.db, 'SELECT * FROM shift WHERE id = ?', shiftId);
  if (!s) throw new AppError('NOT_FOUND', 'Shift not found.', 404);
  const agg = get<Record<string, number | null>>(ctx.db, `SELECT
      count(CASE WHEN doc_type='TAX_INVOICE' AND status='ISSUED' THEN 1 END) AS invoices,
      ifnull(sum(CASE WHEN doc_type='TAX_INVOICE' AND status='ISSUED' THEN grand_total END),0) AS sales,
      ifnull(sum(CASE WHEN doc_type='TAX_INVOICE' AND status='ISSUED' THEN discount_total END),0) AS discounts,
      count(CASE WHEN doc_type='TAX_INVOICE' AND status='CANCELLED' THEN 1 END) AS cancelled,
      ifnull(sum(CASE WHEN doc_type='TAX_INVOICE' AND status='CANCELLED' THEN grand_total END),0) AS cancelled_amount,
      count(CASE WHEN doc_type='CREDIT_NOTE' AND status='ISSUED' THEN 1 END) AS credit_notes,
      ifnull(sum(CASE WHEN doc_type='CREDIT_NOTE' AND status='ISSUED' THEN grand_total END),0) AS refunds
    FROM invoice WHERE shift_id = ?`, shiftId)!;
  const modes = all<{ mode: string; amount: number }>(ctx.db, `SELECT p.mode, sum(${SIGNED('p.amount')}) AS amount FROM payment_effective p JOIN invoice i ON i.id = p.invoice_id
      WHERE p.shift_id = ? AND i.status = 'ISSUED' GROUP BY p.mode ORDER BY p.mode`, shiftId);
  const tax = camelAll(all(ctx.db, `SELECT l.rate_bp, sum(${SIGNED('l.taxable')}) AS taxable, sum(${SIGNED('l.cgst')}) AS cgst, sum(${SIGNED('l.sgst')}) AS sgst,
      sum(${SIGNED('l.igst')}) AS igst, sum(${SIGNED('l.cess')}) AS cess FROM invoice_line l JOIN invoice i ON i.id = l.invoice_id
      WHERE i.shift_id = ? AND i.status = 'ISSUED' GROUP BY l.rate_bp ORDER BY l.rate_bp`, shiftId));
  const cashNet = modes.find((m) => m.mode === 'CASH')?.amount ?? 0;
  const expected = s.opening_cash + cashNet;
  return {
    shiftId: s.id, openedAt: s.opened_at, closedAt: s.closed_at, openedBy: s.user_id,
    invoices: agg.invoices, sales: agg.sales, discounts: agg.discounts, cancelled: agg.cancelled, cancelledAmount: agg.cancelled_amount, creditNotes: agg.credit_notes, refunds: agg.refunds,
    byMode: Object.fromEntries(modes.map((m) => [m.mode, m.amount])), taxByRate: tax,
    cash: { opening: s.opening_cash, net: cashNet, expected, counted: s.counted_cash, difference: s.counted_cash === null ? null : s.counted_cash - expected },
  };
}

export function closeShift(ctx: Ctx, actor: Actor, requestId: string, input: { countedCash: number; discardOpenOrders?: boolean }) {
  return runCommand(ctx, requestId, 'shift.close', actor, (h) => {
    assertPerm(actor, 'shift.use');
    const s = openShiftRow(ctx);
    if (!s) throw new AppError('NO_OPEN_SHIFT', 'There is no open shift.', 409);
    if (s.user_id !== actor.userId && !can(actor.role, 'shift.force_close')) throw new AppError('FORBIDDEN', 'Only the cashier who opened the shift, or a manager, can close it.', 403);
    if (!Number.isSafeInteger(input.countedCash) || input.countedCash < 0 || input.countedCash > MAX_CASH) throw new AppError('VALIDATION', 'Counted cash must be a non-negative whole number of paise.');
    const open = all<{ id: string }>(ctx.db, "SELECT id FROM sale_order WHERE status IN ('DRAFT','HELD')");
    if (open.length > 0) {
      if (!input.discardOpenOrders) throw new AppError('OPEN_ORDERS_EXIST', `${open.length} unfinished bill(s) exist. Finish or discard them first.`, 409, { count: open.length });
      assertPerm(actor, 'shift.force_close');
      run(ctx.db, "UPDATE sale_order SET status = 'CANCELLED', updated_at = ? WHERE status IN ('DRAFT','HELD')", ctx.clock.now());
      audit(ctx, actor.userId, 'order.discard_open', 'shift', s.id, { count: open.length });
    }
    const now = ctx.clock.now();
    const before = zReport(ctx, s.id);
    run(ctx.db, 'UPDATE shift SET closed_at = ?, closed_by = ?, expected_cash = ?, counted_cash = ? WHERE id = ?', now, actor.userId, before.cash.expected, input.countedCash, s.id);
    audit(ctx, actor.userId, 'shift.close', 'shift', s.id, { expected: before.cash.expected, counted: input.countedCash });
    emit(ctx, 'shift', s.id, 'close', { id: s.id, closedAt: now });
    const report = zReport(ctx, s.id);

    const rows: Array<[string, string] | string> = [
      ['Opened', istDateTime(report.openedAt)], ['Closed', istDateTime(now)], '', ['Invoices', String(report.invoices)], ['Sales', formatINR(Number(report.sales), '')],
      ['Discounts', formatINR(Number(report.discounts), '')], ['Cancelled', `${report.cancelled} / ${formatINR(Number(report.cancelledAmount), '')}`],
      ['Refunds', `${report.creditNotes} / ${formatINR(Number(report.refunds), '')}`], '', ...Object.entries(report.byMode).map(([m, a]): [string, string] => [m, formatINR(Number(a), '')]), '',
      ['Opening cash', formatINR(report.cash.opening, '')], ['Expected cash', formatINR(report.cash.expected, '')], ['Counted cash', formatINR(input.countedCash, '')], ['Difference', formatINR(report.cash.difference ?? 0, '')],
    ];
    for (const pr of all<PrinterRow>(ctx.db, 'SELECT * FROM printer WHERE active = 1 AND is_receipt = 1')) {
      enqueueJob(ctx, { kind: 'REPORT', refId: s.id, printerId: pr.id, payload: buildTextReport(colsFor(pr.width_mm), 'SHIFT REPORT (Z)', rows), dedupeKey: `zreport:${s.id}:${pr.id}` });
    }
    h.after(() => appendJournal(ctx, { v: 1, type: 'shift_close', at: now, shiftId: s.id, closedBy: actor.userId, expectedCash: before.cash.expected, countedCash: input.countedCash }));
    return report;
  });
}
