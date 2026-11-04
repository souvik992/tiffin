import type { AddonMigration, HostApi } from '../../../src/addons/host.ts';
import type { Ctx } from '../../../src/services/ctx.ts';
import { bindHost, cancelCharge, chargesForInvoice, checkTerminal, completeCharge, deleteTerminal, getTxn, listTerminals, openChargeFor, recheckCharge, resumeCharges, saveTerminal, startCharge, voidCharge } from './service.ts';
import type { TerminalInput } from './service.ts';

/**
 * Payment machines add-on (id "edc"): Paytm and Pine Labs card machines, wireless or wired. Routes under
 * /api/addons/edc. Needs POS 0.3.8 (billing.order, billing.finalize, billing.paymentGuard, requireApproval, powershell).
 */
export const MIGRATIONS: AddonMigration[] = [{
  version: 1, name: 'machines_and_attempts',
  sql: `
CREATE TABLE edc_terminal (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('paytm','pinelabs')),
  connection TEXT NOT NULL CHECK (connection IN ('cloud','wired')),
  modes TEXT NOT NULL DEFAULT 'CARD,UPI', config_json TEXT NOT NULL DEFAULT '{}',
  is_default INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE edc_txn (
  id TEXT PRIMARY KEY, terminal_id TEXT NOT NULL REFERENCES edc_terminal(id), order_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('SALE','VOID')), mode TEXT NOT NULL CHECK (mode IN ('CARD','UPI','ANY')),
  amount INTEGER NOT NULL CHECK (amount > 0), merchant_txn_id TEXT NOT NULL UNIQUE, provider_ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING','APPROVED','FAILED','CANCELLED','UNKNOWN')),
  result_json TEXT, message TEXT, invoice_id TEXT, original_txn_id TEXT REFERENCES edc_txn(id),
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX edc_txn_order ON edc_txn(order_id);
CREATE INDEX edc_txn_status ON edc_txn(status);
CREATE INDEX edc_txn_invoice ON edc_txn(invoice_id);
`,
}];

const STATUS_TEXT: Record<string, string> = { APPROVED: 'Approved', FAILED: 'Not approved', CANCELLED: 'Cancelled', PENDING: 'Waiting', UNKNOWN: 'Unclear: check the machine' };

/** The daily match: every amount sent to a machine and its result, matched with bills. */
export function dailyMatch(host: HostApi, ctx: Ctx, from: string, to: string) {
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (!day.test(from) || !day.test(to)) throw new host.AppError('VALIDATION', 'Dates must be YYYY-MM-DD.');
  const fromMs = Date.parse(`${from}T00:00:00Z`) - 330 * 60_000, toMs = Date.parse(`${to}T00:00:00Z`) - 330 * 60_000 + 86_400_000;
  const rows = host.db.all<{ at: number; machine: string; kind: string; status: string; mode: string; amount: number; invoiceNo: string | null; result_json: string | null; message: string | null; voided: number }>(
    `SELECT x.created_at AS at, t.name AS machine, x.kind, x.status, x.mode, x.amount, i.invoice_no AS invoiceNo, x.result_json, x.message,
       (SELECT count(*) FROM edc_txn v WHERE v.original_txn_id = x.id AND v.status = 'APPROVED') AS voided
     FROM edc_txn x JOIN edc_terminal t ON t.id = x.terminal_id LEFT JOIN invoice i ON i.id = x.invoice_id
     WHERE x.created_at >= ? AND x.created_at < ? ORDER BY x.created_at`, fromMs, toMs);
  const out = rows.map((r) => {
    const res = r.result_json ? JSON.parse(r.result_json) as Record<string, string> : {};
    const approved = r.status === 'APPROVED';
    const match = r.kind === 'VOID' ? (approved ? 'Reversed on the machine' : '') : !approved ? '' : r.voided ? 'Reversed (void)' : r.invoiceNo ? 'Matched to bill' : 'APPROVED, NO BILL: check';
    return {
      at: r.at, machine: r.machine, what: r.kind === 'VOID' ? 'Reverse (void)' : r.mode === 'UPI' ? 'UPI' : 'Card', status: STATUS_TEXT[r.status] ?? r.status,
      amount: approved ? (r.kind === 'VOID' ? -r.amount : r.amount) : 0, invoiceNo: r.invoiceNo ?? '', message: r.message ?? '',
      approval: [res.approvalCode, res.rrn ? `RRN ${res.rrn}` : '', res.cardLast4 ? `*${res.cardLast4}` : ''].filter(Boolean).join(' '), match,
    };
  });
  return {
    rows: out, approvedTotal: out.reduce((s, r) => s + r.amount, 0),
    noBill: out.filter((r) => r.match.startsWith('APPROVED, NO BILL')).length, unclear: out.filter((r) => r.status.startsWith('Unclear')).length,
  };
}

export function register(host: HostApi): void {
  if (!host.billing.order || !host.billing.finalize || !host.requireApproval) throw new host.AppError('POS_TOO_OLD', 'Payment machines need Tiffin POS 0.3.8 or newer.', 409);
  bindHost(host);
  host.migrations(MIGRATIONS);
  const ctx = host.ctx;
  const body = <T>(c: { body: unknown }) => (c.body ?? {}) as T;

  // a machine's payment cannot have its mode changed by hand: the machine decided how it was paid
  host.billing.paymentGuard?.((invoiceId) => (host.db.get("SELECT 1 FROM edc_txn WHERE invoice_id = ? AND kind = 'SALE' AND status = 'APPROVED'", invoiceId)
    ? 'This bill was paid on a payment machine; the machine decides how it was paid. Reverse it on the machine instead.' : null));
  // waiting payments from before a restart: after the database steps have run
  const boot = setTimeout(() => { try { resumeCharges(ctx); } catch (e) { host.log.warn('payment machines: resume failed', String(e)); } }, 0);
  host.onStop(() => clearTimeout(boot));

  // ---- settings (owner)
  host.route('GET', '/terminals', {}, (c) => listTerminals(ctx, c.actor));
  host.route('POST', '/terminals', {}, (c) => saveTerminal(ctx, c.actor, c.requestId, null, body<TerminalInput>(c)));
  host.route('PUT', '/terminals/:id', {}, (c) => saveTerminal(ctx, c.actor, c.requestId, c.params.id!, body<TerminalInput>(c)));
  host.route('DELETE', '/terminals/:id', {}, (c) => deleteTerminal(ctx, c.actor, c.requestId, c.params.id!));
  host.route('POST', '/terminals/:id/check', { idem: false }, (c) => checkTerminal(ctx, c.actor, c.params.id!));
  host.route('GET', '/report', {}, (c) => { host.assertPerm(c.actor, 'report.read'); return dailyMatch(host, ctx, c.query.get('from') ?? '', c.query.get('to') ?? ''); });

  // ---- the counter
  host.route('POST', '/charges', {}, (c) => {
    const b = body<{ orderId?: unknown; mode?: unknown; terminalId?: unknown }>(c);
    if (typeof b.orderId !== 'string' || (b.mode !== 'CARD' && b.mode !== 'UPI')) throw new host.AppError('VALIDATION', 'orderId and mode (CARD or UPI) are needed.');
    return startCharge(ctx, c.actor, c.requestId, { orderId: b.orderId, mode: b.mode, terminalId: typeof b.terminalId === 'string' ? b.terminalId : null });
  });
  host.route('GET', '/charges/:id', {}, (c) => getTxn(ctx, c.actor, c.params.id!));
  host.route('GET', '/orders/:id/charge', {}, (c) => openChargeFor(ctx, c.actor, c.params.id!));
  host.route('POST', '/charges/:id/cancel', { idem: false }, (c) => cancelCharge(ctx, c.actor, c.params.id!));
  host.route('POST', '/charges/:id/recheck', { idem: false }, (c) => recheckCharge(ctx, c.actor, c.params.id!));
  host.route('POST', '/charges/:id/complete', {}, (c) => completeCharge(ctx, c.actor, c.requestId, c.params.id!));
  host.route('POST', '/charges/:id/void', {}, (c) => voidCharge(ctx, c.actor, c.requestId, c.params.id!, body<{ override?: { userId: string; pin: string } }>(c).override));
  host.route('GET', '/invoices/:id/charges', {}, (c) => chargesForInvoice(ctx, c.actor, c.params.id!));
}
