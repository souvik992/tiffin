import { all, get, run, AppError } from '../../store/db.ts';
import type { Actor, Ctx } from '../ctx.ts';
import { runCommand } from '../commands.ts';
import { audit } from '../audit.ts';
import { assertPerm } from '../permissions.ts';
import { loadSettings } from '../settings.ts';
import { buildKot, buildReceipt, buildTestPage, sampleReceiptData } from './receipt.ts';
import { designOptions } from './receiptDesign.ts';
import { EscPos } from './escpos.ts';
import type { ReceiptData } from './receipt.ts';
import { colsFor, PROFILES } from './transports.ts';
import type { PrinterRow } from './transports.ts';
import type { InvoiceFull } from '../invoiceView.ts';
import { parseEscPos } from './virtual.ts';
import { parseSerialAddress } from './serial.ts';
import { parseUsbAddress } from './usb.ts';
import { loadInvoiceFull } from '../invoiceView.ts';
import { ANDROID_ADDRESS } from './android.ts';

export function receiptDataFrom(f: InvoiceFull): ReceiptData {
  return {
    outlet: { name: f.outlet.name, address: f.outlet.address, gstin: f.outlet.gstin, fssaiNo: f.outlet.fssaiNo, phone: f.outlet.phone },
    invoice: {
      invoiceNo: f.invoice.invoiceNo, docType: f.invoice.docType, status: f.invoice.status, issuedAt: f.invoice.issuedAt, tokenNo: f.invoice.tokenNo,
      grossTotal: f.invoice.grossTotal, discountTotal: f.invoice.discountTotal, taxableTotal: f.invoice.taxableTotal, cgst: f.invoice.cgst, sgst: f.invoice.sgst,
      igst: f.invoice.igst, cess: f.invoice.cess, roundOff: f.invoice.roundOff, grandTotal: f.invoice.grandTotal, buyerGstin: f.invoice.buyerGstin,
      originalInvoiceNo: f.invoice.originalInvoiceNo,
    },
    lines: f.lines.map((l) => ({ name: l.name, hsnCode: l.hsnCode, qtyMilli: l.qtyMilli, unitPrice: l.unitPrice, lineTotal: l.lineTotal, rateBp: l.rateBp, taxable: l.taxable, cgst: l.cgst, sgst: l.sgst, igst: l.igst, modifiers: l.modifiers, note: l.note })),
    payments: f.payments.map((p) => ({ mode: p.mode, amount: p.amount, tendered: p.tendered })),
    customer: f.customer ?? null, channel: f.orderChannel,
    cashierName: f.invoice.cashierName,
  };
}

export function enqueueJob(ctx: Ctx, j: { kind: 'RECEIPT' | 'KOT' | 'REPORT' | 'TEST'; refId: string | null; printerId: string; payload: Uint8Array; dedupeKey: string }): string | null {
  const id = ctx.ids.next();
  const now = ctx.clock.now();
  const r = run(ctx.db, `INSERT INTO print_job(id, kind, ref_id, printer_id, payload, status, dedupe_key, created_at, updated_at)
      VALUES (?,?,?,?,?,'QUEUED',?,?,?) ON CONFLICT(dedupe_key) DO NOTHING`, id, j.kind, j.refId, j.printerId, j.payload, j.dedupeKey, now, now);
  return Number(r.changes) === 1 ? id : null;
}

const printers = (ctx: Ctx, where: string) => all<PrinterRow>(ctx.db, `SELECT * FROM printer WHERE active = 1 AND ${where}`);

export interface PrintSummary { receipts: number; kitchenTickets: number; warnings: Array<'NO_RECEIPT_PRINTER' | 'NO_KITCHEN_PRINTER'> }

/**
 * Queues the customer receipt (and, for first prints of a sale, kitchen tickets). Runs inside the caller's transaction.
 * Returns what was queued, with warnings when nothing could print, so billing never fails silently.
 */
export function queueInvoicePrints(ctx: Ctx, f: InvoiceFull, opts: { copyNo: number; kot: boolean }): PrintSummary {
  const out: PrintSummary = { receipts: 0, kitchenTickets: 0, warnings: [] };
  let receiptPrinters = 0, kotWanted = false, kotTargets = 0;
  const settings = loadSettings(ctx);
  const design = designOptions(ctx);
  const hasCash = f.payments.some((p) => p.mode === 'CASH');
  for (const pr of printers(ctx, 'is_receipt = 1')) {
    receiptPrinters++;
    const bytes = buildReceipt(receiptDataFrom(f), { cols: colsFor(pr.width_mm), copyNo: opts.copyNo, footer: settings.receiptFooter, drawer: pr.drawer === 1 && hasCash && opts.copyNo === 1, ...design });
    if (enqueueJob(ctx, { kind: 'RECEIPT', refId: f.invoice.id, printerId: pr.id, payload: bytes, dedupeKey: `receipt:${f.invoice.id}:${pr.id}:${opts.copyNo}` })) out.receipts++;
  }
  if (opts.kot && f.invoice.docType === 'TAX_INVOICE') {
    const k = queueKitchenTickets(ctx, f, 'kot', false);
    out.kitchenTickets = k.queued; kotWanted = k.wanted; kotTargets = k.targets;
  }
  if (receiptPrinters === 0) out.warnings.push('NO_RECEIPT_PRINTER');
  if (kotWanted && kotTargets === 0) out.warnings.push('NO_KITCHEN_PRINTER');
  return out;
}

/** Kitchen tickets for a bill, one per kitchen station and printer. `tag` keeps each print run apart (first print, reprint n). */
function queueKitchenTickets(ctx: Ctx, f: InvoiceFull, tag: string, reprint: boolean): { queued: number; wanted: boolean; targets: number } {
  let queued = 0, kotWanted = false, kotTargets = 0;
  {
    const rows = all<{ id: string; station: string | null }>(ctx.db,
      `SELECT il.id, c.kitchen_station AS station FROM invoice_line il LEFT JOIN item i ON i.id = il.item_id LEFT JOIN category c ON c.id = i.category_id WHERE il.invoice_id = ?`, f.invoice.id);
    const stationOf = new Map(rows.map((r) => [r.id, r.station ?? '']));
    const stations = new Set(f.lines.map((l) => stationOf.get(l.id) ?? ''));
    const kotPrinters = printers(ctx, "stations <> '[]'");
    const note = get<{ note: string | null }>(ctx.db, 'SELECT note FROM sale_order WHERE id = ?', f.invoice.orderId)?.note ?? null;
    for (const st of stations) {
      const lines = f.lines.filter((l) => (stationOf.get(l.id) ?? '') === st);
      if (st !== '') kotWanted = true;
      for (const pr of kotPrinters) {
        const list = JSON.parse(pr.stations) as string[];
        if (!(list.includes('*') || (st !== '' && list.includes(st)))) continue;
        if (st !== '') kotTargets++;
        const bytes = buildKot({ tokenNo: f.invoice.tokenNo, channel: f.orderChannel, createdAt: f.invoice.issuedAt, station: st, orderNote: note, reprint,
          lines: lines.map((l) => ({ name: l.name, qtyMilli: l.qtyMilli, modifiers: l.modifiers, note: l.note })) }, colsFor(pr.width_mm));
        if (enqueueJob(ctx, { kind: 'KOT', refId: f.invoice.id, printerId: pr.id, payload: bytes, dedupeKey: `${tag}:${f.invoice.id}:${pr.id}:${st}` })) queued++;
      }
    }
  }
  return { queued, wanted: kotWanted, targets: kotTargets };
}

/** KOT reprint (the kitchen lost the ticket): every station's ticket again, marked REPRINT. A manager approves, like a bill reprint. */
export function reprintKot(ctx: Ctx, actor: Actor, requestId: string, input: { invoiceId: string }, approve: (perm: 'invoice.reprint') => string) {
  return runCommand(ctx, requestId, 'kot.reprint', actor, () => {
    const approver = approve('invoice.reprint');
    const f = loadInvoiceFull(ctx, input.invoiceId);
    if (f.invoice.docType !== 'TAX_INVOICE') throw new AppError('VALIDATION', 'Kitchen tickets belong to bills, not credit notes.');
    const prior = get<{ n: number }>(ctx.db, "SELECT count(DISTINCT substr(dedupe_key, 1, instr(dedupe_key, ':'))) n FROM print_job WHERE kind = 'KOT' AND ref_id = ?", f.invoice.id)!.n;
    const k = queueKitchenTickets(ctx, f, `kot-reprint-${Math.max(prior, 1)}`, true);
    if (k.targets === 0 && k.queued === 0) throw new AppError('NO_KITCHEN_PRINTER', 'No kitchen printer is set up for these items. Set one up in Settings > Printer setup.', 409);
    audit(ctx, actor.userId, 'kot.reprint', 'invoice', f.invoice.id, { approver, tickets: k.queued });
    return { queued: k.queued };
  });
}

export function reprintInvoice(ctx: Ctx, actor: Actor, requestId: string, input: { invoiceId: string; override?: { userId: string; pin: string } }, approve: (perm: 'invoice.reprint') => string) {
  return runCommand(ctx, requestId, 'invoice.reprint', actor, () => {
    const approver = approve('invoice.reprint');
    const f = loadInvoiceFull(ctx, input.invoiceId);
    const prior = get<{ n: number }>(ctx.db, "SELECT count(DISTINCT dedupe_key) n FROM print_job WHERE kind = 'RECEIPT' AND ref_id = ?", f.invoice.id)!.n;
    const copyNo = Math.max(prior, 1) + 1;
    const queued = queueInvoicePrints(ctx, f, { copyNo, kot: false }).receipts;
    audit(ctx, actor.userId, 'invoice.reprint', 'invoice', f.invoice.id, { copyNo, approver });
    return { queued, copyNo };
  });
}

// ---------- printer management ----------
export interface PrinterInput { name: string; transport: PrinterRow['transport']; address?: string | null; widthMm?: number; profile?: string; isReceipt?: boolean; drawer?: boolean; stations?: string[]; active?: boolean }

const bad = (msg: string): never => { throw new AppError('VALIDATION', msg); };

/** Checks the address for each connection and returns it cleaned up. */
export function validateAddress(transport: PrinterRow['transport'], address: string | null | undefined): string | null {
  const a = (address ?? '').trim();
  switch (transport) {
    case 'memory': return null; // screen only (virtual printer)
    case 'tcp': {
      const m = /^([A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)(?::(\d{1,5}))?$/.exec(a);
      if (!m) return bad('Enter the printer IP address, like 192.168.1.50 (or 192.168.1.50:9100).');
      if (m[2] !== undefined && (Number(m[2]) < 1 || Number(m[2]) > 65535)) return bad('The port must be between 1 and 65535 (most printers use 9100).');
      return a;
    }
    case 'spooler':
      if (!a || a.length > 200 || /[\u0000-\u001f]/.test(a)) return bad('Choose the Windows printer (its name as shown in Windows Settings, Printers).');
      return a;
    case 'serial': {
      const s = parseSerialAddress(a);
      if (!s) return bad('Enter the COM port, like COM5 (Windows Settings, Bluetooth, More Bluetooth options, COM Ports).');
      return s.baud === 9600 ? s.port : `${s.port}:${s.baud}`;
    }
    case 'usb': {
      const u = parseUsbAddress(a);
      if (!u) return bad('A direct USB printer is identified by its vendor:product id. Use the detected printer in Settings, Printers.');
      return [u.vid, u.pid, u.serial].filter(Boolean).join(':');
    }
    case 'android':
      if (!ANDROID_ADDRESS.test(a)) return bad('Choose the USB or Bluetooth printer from the list on this device.');
      return a;
    case 'file':
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(a) || a.includes('..')) return bad('A file printer needs a plain file name (it is saved in the data folder).');
      return a;
    default: return bad('Unknown printer connection.');
  }
}

function checkPrinter(i: PrinterInput) {
  if (!i.name?.trim() || i.name.length > 60) throw new AppError('VALIDATION', 'Printer name is required (max 60 characters).');
  if (!['memory', 'tcp', 'file', 'spooler', 'serial', 'usb', 'android'].includes(i.transport)) throw new AppError('VALIDATION', 'Unknown printer connection.');
  i.address = validateAddress(i.transport, i.address);
  if (i.widthMm !== undefined && i.widthMm !== 58 && i.widthMm !== 80) throw new AppError('VALIDATION', 'Paper width must be 58 or 80 mm.');
  if (i.profile !== undefined && !(i.profile in PROFILES)) throw new AppError('VALIDATION', 'Unknown data speed setting.');
  const stations = i.stations ?? [];
  if (!Array.isArray(stations) || stations.some((s) => typeof s !== 'string' || s.length > 30)) throw new AppError('VALIDATION', 'Invalid stations list.');
  return stations;
}
export function createPrinter(ctx: Ctx, actor: Actor, requestId: string, input: PrinterInput) {
  return runCommand(ctx, requestId, 'printer.create', actor, () => {
    assertPerm(actor, 'printer.manage');
    const stations = checkPrinter(input);
    const id = ctx.ids.next();
    run(ctx.db, 'INSERT INTO printer(id, name, transport, address, width_mm, profile, is_receipt, drawer, stations, active, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      id, input.name.trim(), input.transport, input.address ?? null, input.widthMm ?? 80, input.profile ?? 'generic', input.isReceipt ? 1 : 0, input.drawer ? 1 : 0, JSON.stringify(stations), input.active === false ? 0 : 1, ctx.clock.now());
    audit(ctx, actor.userId, 'printer.create', 'printer', id, { name: input.name, transport: input.transport });
    return { id };
  });
}
const OFF_MSG = 'Printer turned off in settings. Turn it on, or reprint the bill on another printer.';

export function updatePrinter(ctx: Ctx, actor: Actor, requestId: string, id: string, input: Partial<PrinterInput>) {
  return runCommand(ctx, requestId, 'printer.update', actor, () => {
    assertPerm(actor, 'printer.manage');
    const cur = get<PrinterRow>(ctx.db, 'SELECT * FROM printer WHERE id = ?', id);
    if (!cur) throw new AppError('NOT_FOUND', 'Printer not found.', 404);
    const merged: PrinterInput = {
      name: input.name ?? cur.name, transport: input.transport ?? cur.transport,
      address: input.address !== undefined ? input.address : input.transport && input.transport !== cur.transport ? null : cur.address,
      widthMm: input.widthMm ?? cur.width_mm, profile: input.profile ?? cur.profile, isReceipt: input.isReceipt ?? cur.is_receipt === 1,
      drawer: input.drawer ?? cur.drawer === 1, stations: input.stations ?? (JSON.parse(cur.stations) as string[]), active: input.active ?? cur.active === 1,
    };
    const stations = checkPrinter(merged);
    run(ctx.db, 'UPDATE printer SET name=?, transport=?, address=?, width_mm=?, profile=?, is_receipt=?, drawer=?, stations=?, active=? WHERE id=?',
      merged.name.trim(), merged.transport, merged.address ?? null, merged.widthMm ?? 80, merged.profile ?? 'generic', merged.isReceipt ? 1 : 0, merged.drawer ? 1 : 0, JSON.stringify(stations), merged.active ? 1 : 0, id);
    // Jobs waiting for a printer that is now off would wait forever: release them as failed so the cashier sees them.
    const released = merged.active ? 0 : releaseQueued(ctx, id);
    audit(ctx, actor.userId, 'printer.update', 'printer', id, { name: merged.name, transport: merged.transport, active: merged.active, released });
    return { id, released };
  });
}

function releaseQueued(ctx: Ctx, printerId: string): number {
  return Number(run(ctx.db, "UPDATE print_job SET status = 'FAILED', last_error = ?, updated_at = ? WHERE printer_id = ? AND status = 'QUEUED'", OFF_MSG, ctx.clock.now(), printerId).changes);
}

/** Deletes a printer that never printed; one with print history is turned off instead (the history stays). */
export function deletePrinter(ctx: Ctx, actor: Actor, requestId: string, id: string) {
  return runCommand(ctx, requestId, 'printer.delete', actor, () => {
    assertPerm(actor, 'printer.manage');
    const cur = get<PrinterRow>(ctx.db, 'SELECT * FROM printer WHERE id = ?', id);
    if (!cur) throw new AppError('NOT_FOUND', 'Printer not found.', 404);
    const used = get(ctx.db, 'SELECT 1 FROM print_job WHERE printer_id = ? LIMIT 1', id);
    if (used) {
      run(ctx.db, 'UPDATE printer SET active = 0 WHERE id = ?', id);
      releaseQueued(ctx, id);
    } else {
      run(ctx.db, 'DELETE FROM printer WHERE id = ?', id);
    }
    audit(ctx, actor.userId, 'printer.delete', 'printer', id, { name: cur.name, kept: !!used });
    return { id, removed: !used, deactivated: !!used };
  });
}

export function listPrinters(ctx: Ctx) {
  const rows = all<PrinterRow & { queued: number; failed: number; last_error: string | null; last_printed_at: number | null }>(ctx.db,
    `SELECT p.*,
       (SELECT count(*) FROM print_job j WHERE j.printer_id = p.id AND j.status IN ('QUEUED','SENDING')) AS queued,
       (SELECT count(*) FROM print_job j WHERE j.printer_id = p.id AND j.status = 'FAILED') AS failed,
       (SELECT j.last_error FROM print_job j WHERE j.printer_id = p.id AND j.status = 'FAILED' ORDER BY j.updated_at DESC LIMIT 1) AS last_error,
       (SELECT max(j.updated_at) FROM print_job j WHERE j.printer_id = p.id AND j.status = 'PRINTED') AS last_printed_at
     FROM printer p ORDER BY p.active DESC, p.name`);
  return rows.map((p) => ({
    id: p.id, name: p.name, transport: p.transport, address: p.address, widthMm: p.width_mm, profile: p.profile, isReceipt: p.is_receipt === 1, drawer: p.drawer === 1,
    stations: JSON.parse(p.stations) as string[], active: p.active === 1,
    stats: { queued: p.queued, failed: p.failed, lastError: p.last_error, lastPrintedAt: p.last_printed_at },
  }));
}

/** The receipt exactly as a printer of this width would print it, as text lines (on-screen preview and browser print). */
export function receiptPreview(ctx: Ctx, invoiceId: string, widthMm: number) {
  if (widthMm !== 58 && widthMm !== 80) throw new AppError('VALIDATION', 'Paper width must be 58 or 80 mm.');
  const f = loadInvoiceFull(ctx, invoiceId);
  const cols = colsFor(widthMm);
  const bytes = buildReceipt(receiptDataFrom(f), { cols, copyNo: 1, footer: loadSettings(ctx).receiptFooter, drawer: false, ...designOptions(ctx) });
  return { invoiceId, widthMm, cols, lines: parseEscPos(bytes).lines };
}

/** Print jobs of one bill (receipts, kitchen tickets, reprints) with their printer and status. */
export function invoicePrints(ctx: Ctx, invoiceId: string) {
  return all<{ id: string; kind: string; status: string; attempts: number; lastError: string | null; printerName: string; createdAt: number; updatedAt: number }>(ctx.db,
    `SELECT j.id, j.kind, j.status, j.attempts, j.last_error AS lastError, p.name AS printerName, j.created_at AS createdAt, j.updated_at AS updatedAt
     FROM print_job j JOIN printer p ON p.id = j.printer_id WHERE j.ref_id = ? ORDER BY j.created_at, j.rowid`, invoiceId);
}
export function testPrint(ctx: Ctx, actor: Actor, requestId: string, printerId: string) {
  return runCommand(ctx, requestId, 'printer.test', actor, () => {
    assertPerm(actor, 'printer.manage');
    const p = activePrinter(ctx, printerId);
    const jobId = enqueueJob(ctx, { kind: 'TEST', refId: printerId, printerId, payload: buildTestPage(colsFor(p.width_mm), p.name), dedupeKey: `test:${requestId}` });
    return { jobId };
  });
}

function activePrinter(ctx: Ctx, printerId: string): PrinterRow {
  const p = get<PrinterRow>(ctx.db, 'SELECT * FROM printer WHERE id = ?', printerId);
  if (!p) throw new AppError('NOT_FOUND', 'Printer not found.', 404);
  if (p.active !== 1) throw new AppError('PRINTER_OFF', 'This printer is turned off. Turn it on first.', 409);
  return p;
}

/** A made-up sale with this shop's header (see sampleReceiptData). */
function sampleData(ctx: Ctx): ReceiptData {
  const o = get<{ name: string; address: string | null; gstin: string | null; fssai_no: string | null; phone: string | null }>(ctx.db, 'SELECT name, address, gstin, fssai_no, phone FROM outlet LIMIT 1');
  return sampleReceiptData({ name: o?.name ?? 'Your shop name', address: o?.address ?? null, gstin: o?.gstin ?? null, fssaiNo: o?.fssai_no ?? null, phone: o?.phone ?? null }, ctx.clock.now());
}

/** The receipt layout with this shop's header and footer, as text (no bill involved). */
export function sampleReceipt(ctx: Ctx, widthMm: number) {
  if (widthMm !== 58 && widthMm !== 80) throw new AppError('VALIDATION', 'Paper width must be 58 or 80 mm.');
  const cols = colsFor(widthMm);
  const bytes = buildReceipt(sampleData(ctx), { cols, copyNo: 1, footer: loadSettings(ctx).receiptFooter, drawer: false, sample: true, ...designOptions(ctx) });
  return { widthMm, cols, lines: parseEscPos(bytes, { widen: true }).lines };
}

/** Prints the sample receipt on one printer (to check width, header and cutting). */
export function printSample(ctx: Ctx, actor: Actor, requestId: string, printerId: string) {
  return runCommand(ctx, requestId, 'printer.sample', actor, () => {
    assertPerm(actor, 'printer.manage');
    const p = activePrinter(ctx, printerId);
    const payload = buildReceipt(sampleData(ctx), { cols: colsFor(p.width_mm), copyNo: 1, footer: loadSettings(ctx).receiptFooter, drawer: false, sample: true, ...designOptions(ctx) });
    return { jobId: enqueueJob(ctx, { kind: 'TEST', refId: printerId, printerId, payload, dedupeKey: `sample:${requestId}` }) };
  });
}

/** Opens the cash drawer plugged into this printer (no paper used). */
export function testDrawer(ctx: Ctx, actor: Actor, requestId: string, printerId: string) {
  return runCommand(ctx, requestId, 'printer.drawer_test', actor, () => {
    assertPerm(actor, 'printer.manage');
    const p = activePrinter(ctx, printerId);
    audit(ctx, actor.userId, 'printer.drawer_test', 'printer', printerId);
    return { jobId: enqueueJob(ctx, { kind: 'TEST', refId: printerId, printerId, payload: new EscPos(colsFor(p.width_mm)).init().drawerKick().bytes(), dedupeKey: `drawer:${requestId}` }) };
  });
}
