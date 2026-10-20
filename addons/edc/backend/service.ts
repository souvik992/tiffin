import type { Actor, Ctx } from '../../../src/services/ctx.ts';
import type { Override } from '../../../src/services/auth.ts';
import type { HostApi } from '../../../src/addons/host.ts';
import { PaytmCloud, PaytmWired } from './paytm.ts';
import type { PaytmCloudConfig, PaytmWiredConfig } from './paytm.ts';
import { PineCloud, PineWired } from './pinelabs.ts';
import type { PineCloudConfig, PineWiredConfig } from './pinelabs.ts';
import type { Connection, Connector, PaidBy, Provider, SaleRequest, TerminalResult, TxnMode, TxnStatus } from './types.ts';

// The POS's toolbox (HostApi) for this POS: everything goes through it (add-on rule: no POS code is imported).
const hosts = new WeakMap<Ctx, HostApi>();
export function bindHost(host: HostApi): void { hosts.set(host.ctx, host); }
const h = (ctx: Ctx): HostApi => { const x = hosts.get(ctx); if (!x) throw new Error('The payment machines add-on has not started.'); return x; };
/** The day in India (YYYY-MM-DD). */
const istDay = (ms: number) => new Date(ms + 330 * 60_000).toISOString().slice(0, 10);

/**
 * Payment machines at the counter (Settings > Payment machines; Billing: Card or UPI on a machine).
 *
 * A charge never touches a bill until the machine says APPROVED: the amount sent is the backend's own bill total;
 * the attempt is a edc_txn row; the company is asked for the result in the background (outside any transaction);
 * only "complete" saves the bill, through the normal finalize, with the machine's approval code as the payment
 * reference. Anything unclear (no answer, the POS restarted) becomes UNKNOWN, never FAILED, so a customer is never
 * charged twice: the cashier checks the machine and, if it shows approved, completes or pays by hand with the slip.
 */

export const PROVIDER_NAME: Record<Provider, string> = { paytm: 'Paytm', pinelabs: 'Pine Labs' };
const WAIT_MS = 6 * 60_000; // Pine Labs cancels unanswered requests after 5 minutes (AutoCancelDurationInMinutes)
const POLL_MS = 3000;

export interface TerminalRow {
  id: string; name: string; provider: Provider; connection: Connection; modes: string; config_json: string;
  is_default: number; active: number; created_at: number; updated_at: number;
}
interface TxnRow {
  id: string; terminal_id: string; order_id: string; kind: 'SALE' | 'VOID'; mode: TxnMode; amount: number; merchant_txn_id: string;
  provider_ref: string | null; status: TxnStatus; result_json: string | null; message: string | null; invoice_id: string | null;
  original_txn_id: string | null; created_by: string; created_at: number; updated_at: number;
}

/** Secrets are "_key" settings (never listed to screens), named by the add-on rules. */
const secretKey = (id: string) => `edc_terminal_${id}_key`;

// ---------------------------------------------------------------- connectors (tests replace the factory)

export type ConnectorFactory = (t: TerminalRow, secret: string, config: Record<string, unknown>, host: HostApi) => Connector;
export const defaultFactory: ConnectorFactory = (t, secret, c, host) => {
  if (t.provider === 'paytm' && t.connection === 'cloud') return new PaytmCloud(c as unknown as PaytmCloudConfig, secret);
  if (t.provider === 'paytm') {
    if (!host.powershell) throw new host.AppError('POS_TOO_OLD', 'Paytm by cable needs Tiffin POS 0.3.8 or newer.', 409);
    return new PaytmWired(c as unknown as PaytmWiredConfig, host.powershell);
  }
  if (t.connection === 'cloud') return new PineCloud(c as unknown as PineCloudConfig, secret);
  return new PineWired(c as unknown as PineWiredConfig);
};
const factories = new WeakMap<Ctx, ConnectorFactory>();
const timings = new WeakMap<Ctx, { pollMs: number; waitMs: number }>();
/** Tests: fake machines, and short waits. */
export function setConnectorFactory(ctx: Ctx, f: ConnectorFactory, timing?: { pollMs: number; waitMs: number }): void { factories.set(ctx, f); if (timing) timings.set(ctx, timing); }
function connectorOf(ctx: Ctx, t: TerminalRow): Connector {
  return (factories.get(ctx) ?? defaultFactory)(t, h(ctx).getSetting(secretKey(t.id)), JSON.parse(t.config_json) as Record<string, unknown>, h(ctx));
}

// ---------------------------------------------------------------- settings

/** What each kind of machine needs. "secret" is the merchant key (Paytm) or security token (Pine Labs). */
const FIELDS: Record<string, { required: string[]; optional: string[]; secret: boolean }> = {
  'paytm/cloud': { required: ['mid', 'tid', 'channelId', 'env'], optional: ['liveUrl'], secret: true },
  'paytm/wired': { required: ['mid', 'comPort', 'libFolder'], optional: ['baud'], secret: false },
  'pinelabs/cloud': { required: ['merchantId', 'storeId', 'env'], optional: ['clientId'], secret: true },
  'pinelabs/wired': { required: ['host'], optional: ['port'], secret: false },
};

export interface TerminalInput {
  name: string; provider: Provider; connection: Connection; modes: Array<'CARD' | 'UPI'>; config: Record<string, string | number>;
  secret?: string | null; isDefault?: boolean; active?: boolean;
}

function cleanConfig(ctx: Ctx, input: TerminalInput): Record<string, string | number> {
  const spec = FIELDS[`${input.provider}/${input.connection}`];
  if (!spec) throw new (h(ctx).AppError)('VALIDATION', 'Choose Paytm or Pine Labs, and a wireless or wired connection.');
  const out: Record<string, string | number> = {};
  for (const k of [...spec.required, ...spec.optional]) {
    const v = input.config[k];
    if (v === undefined || v === null || String(v).trim() === '') { if (spec.required.includes(k)) throw new (h(ctx).AppError)('VALIDATION', `Fill in "${k}".`, 400, { field: k }); continue; }
    out[k] = typeof v === 'number' ? v : String(v).trim().slice(0, 300);
  }
  if ('env' in out && out.env !== 'test' && out.env !== 'live') throw new (h(ctx).AppError)('VALIDATION', 'Choose Test or Live.');
  if (out.env === 'live' && input.provider === 'paytm' && !/^https:\/\//.test(String(out.liveUrl ?? ''))) throw new (h(ctx).AppError)('VALIDATION', 'For Live, enter the https server address Paytm gave you.', 400, { field: 'liveUrl' });
  if ('port' in out && !(Number(out.port) >= 1 && Number(out.port) <= 65535)) throw new (h(ctx).AppError)('VALIDATION', 'The port must be a number from 1 to 65535.');
  if ('baud' in out && ![9600, 19200, 38400, 57600, 115200].includes(Number(out.baud))) throw new (h(ctx).AppError)('VALIDATION', 'Choose a speed (baud) of 9600 to 115200.');
  if ('comPort' in out && !/^COM\d{1,3}$/i.test(String(out.comPort))) throw new (h(ctx).AppError)('VALIDATION', 'The COM port looks like COM3.');
  for (const k of ['merchantId', 'storeId', 'clientId']) if (k in out && !/^\d{1,12}$/.test(String(out[k]))) throw new (h(ctx).AppError)('VALIDATION', `"${k}" is a number from Pine Labs.`, 400, { field: k });
  return out;
}

function view(ctx: Ctx, t: TerminalRow) {
  return {
    id: t.id, name: t.name, provider: t.provider, providerName: PROVIDER_NAME[t.provider], connection: t.connection,
    modes: t.modes.split(',').filter(Boolean) as Array<'CARD' | 'UPI'>, config: JSON.parse(t.config_json) as Record<string, string | number>,
    hasSecret: Boolean(h(ctx).getSetting(secretKey(t.id))), needsSecret: FIELDS[`${t.provider}/${t.connection}`]!.secret,
    isDefault: t.is_default === 1, active: t.active === 1,
  };
}
export type TerminalView = ReturnType<typeof view>;

/** Machines for the counter (no secrets). */
export function listTerminals(ctx: Ctx, actor: Actor): TerminalView[] {
  h(ctx).assertPerm(actor, 'invoice.finalize');
  return h(ctx).db.all<TerminalRow>('SELECT * FROM edc_terminal ORDER BY is_default DESC, name').map((t) => view(ctx, t));
}

export function saveTerminal(ctx: Ctx, actor: Actor, requestId: string, id: string | null, input: TerminalInput): TerminalView {
  return h(ctx).runCommand(ctx, requestId, 'terminal.save', actor, () => {
    h(ctx).assertPerm(actor, 'settings.write');
    const name = (input.name ?? '').trim();
    if (!name || name.length > 40) throw new (h(ctx).AppError)('VALIDATION', 'Name the machine (for example "Counter Paytm").');
    const modes = [...new Set(input.modes)].filter((m) => m === 'CARD' || m === 'UPI');
    if (!modes.length) throw new (h(ctx).AppError)('VALIDATION', 'Choose Card, UPI or both.');
    if (input.provider === 'pinelabs' && input.connection === 'wired' && modes.includes('UPI')) throw new (h(ctx).AppError)('VALIDATION', 'Pine Labs over a cable takes cards only here. Untick UPI, or use the internet connection.');
    const config = cleanConfig(ctx, input);
    const now = ctx.clock.now();
    let tid = id;
    if (tid) {
      const r = h(ctx).db.run('UPDATE edc_terminal SET name = ?, provider = ?, connection = ?, modes = ?, config_json = ?, active = ?, updated_at = ? WHERE id = ?',
        name, input.provider, input.connection, modes.join(','), JSON.stringify(config), input.active === false ? 0 : 1, now, tid);
      if (Number(r.changes) === 0) throw new (h(ctx).AppError)('NOT_FOUND', 'Machine not found.', 404);
    } else {
      tid = ctx.ids.next();
      h(ctx).db.run('INSERT INTO edc_terminal(id, name, provider, connection, modes, config_json, active, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
        tid, name, input.provider, input.connection, modes.join(','), JSON.stringify(config), input.active === false ? 0 : 1, now, now);
    }
    if (input.secret) h(ctx).setSetting(secretKey(tid), input.secret.trim());
    if (FIELDS[`${input.provider}/${input.connection}`]!.secret && !h(ctx).getSetting(secretKey(tid))) {
      throw new (h(ctx).AppError)('VALIDATION', input.provider === 'paytm' ? 'Enter the Paytm merchant key.' : 'Enter the Pine Labs security token.', 400, { field: 'secret' });
    }
    if (input.isDefault || !h(ctx).db.get('SELECT 1 FROM edc_terminal WHERE is_default = 1 AND active = 1 AND id <> ?', tid)) {
      h(ctx).db.run('UPDATE edc_terminal SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END', tid);
    }
    h(ctx).audit(ctx, actor.userId, 'terminal.save', 'edc_terminal', tid, { provider: input.provider, connection: input.connection });
    return view(ctx, h(ctx).db.get<TerminalRow>('SELECT * FROM edc_terminal WHERE id = ?', tid)!);
  });
}

/** Removes a machine; one that already took payments is only switched off (its history stays). */
export function deleteTerminal(ctx: Ctx, actor: Actor, requestId: string, id: string) {
  return h(ctx).runCommand(ctx, requestId, 'terminal.delete', actor, () => {
    h(ctx).assertPerm(actor, 'settings.write');
    if (h(ctx).db.get('SELECT 1 FROM edc_txn WHERE terminal_id = ?', id)) h(ctx).db.run('UPDATE edc_terminal SET active = 0, is_default = 0, updated_at = ? WHERE id = ?', ctx.clock.now(), id);
    else h(ctx).db.run('DELETE FROM edc_terminal WHERE id = ?', id);
    h(ctx).setSetting(secretKey(id), '');
    h(ctx).audit(ctx, actor.userId, 'terminal.delete', 'edc_terminal', id);
    return { ok: true };
  });
}

export async function checkTerminal(ctx: Ctx, actor: Actor, id: string) {
  h(ctx).assertPerm(actor, 'settings.write');
  const t = h(ctx).db.get<TerminalRow>('SELECT * FROM edc_terminal WHERE id = ?', id);
  if (!t) throw new (h(ctx).AppError)('NOT_FOUND', 'Machine not found.', 404);
  return connectorOf(ctx, t).check();
}

// ---------------------------------------------------------------- charging at the counter

export interface TxnResult extends Omit<TerminalResult, 'status' | 'message'> { paidBy?: PaidBy }
function txnView(ctx: Ctx, x: TxnRow) {
  const t = h(ctx).db.get<TerminalRow>('SELECT * FROM edc_terminal WHERE id = ?', x.terminal_id)!;
  const r = x.result_json ? JSON.parse(x.result_json) as TxnResult : null;
  return {
    id: x.id, kind: x.kind, terminalId: x.terminal_id, terminalName: t.name, provider: t.provider, connection: t.connection, orderId: x.order_id, mode: x.mode, amount: x.amount,
    status: x.status, message: x.message, result: r, invoiceId: x.invoice_id, createdAt: x.created_at, updatedAt: x.updated_at,
    canCancel: x.status === 'PENDING' && t.connection === 'cloud', merchantTxnId: x.merchant_txn_id,
  };
}
export type TxnView = ReturnType<typeof txnView>;

const txnRow = (ctx: Ctx, id: string) => {
  const x = h(ctx).db.get<TxnRow>('SELECT * FROM edc_txn WHERE id = ?', id);
  if (!x) throw new (h(ctx).AppError)('NOT_FOUND', 'Payment attempt not found.', 404);
  return x;
};
export function getTxn(ctx: Ctx, actor: Actor, id: string): TxnView { h(ctx).assertPerm(actor, 'invoice.finalize'); return txnView(ctx, txnRow(ctx, id)); }

const requestOf = (x: TxnRow, reference: string): SaleRequest => ({ merchantTxnId: x.merchant_txn_id, amount: x.amount, mode: x.mode, reference, startedAt: x.created_at });

function save(ctx: Ctx, id: string, status: TxnStatus, r: Partial<TerminalResult> & { message: string }): void {
  const { status: _s, message, ...rest } = r as TerminalResult;
  const keep = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  const prev = h(ctx).db.get<{ result_json: string | null }>('SELECT result_json FROM edc_txn WHERE id = ?', id);
  const merged = { ...(prev?.result_json ? JSON.parse(prev.result_json) as object : {}), ...keep };
  h(ctx).db.run("UPDATE edc_txn SET status = ?, message = ?, result_json = ?, provider_ref = coalesce(?, provider_ref), updated_at = ? WHERE id = ? AND status IN ('PENDING','UNKNOWN')",
    status, message.slice(0, 300), Object.keys(merged).length ? JSON.stringify(merged) : null, (keep.providerRef as string | undefined) ?? null, ctx.clock.now(), id);
  ctx.events.emit('terminal', { id, status });
}

const running = new WeakMap<Ctx, Set<string>>();
const runningSet = (ctx: Ctx) => { let s = running.get(ctx); if (!s) { s = new Set(); running.set(ctx, s); } return s; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Talks to the machine until the attempt is final. Never throws: problems end as FAILED (not sent) or UNKNOWN. */
async function drive(ctx: Ctx, id: string, opts: { resume?: boolean } = {}): Promise<void> {
  const set = runningSet(ctx);
  if (set.has(id)) return;
  set.add(id);
  try {
    let x = txnRow(ctx, id);
    const t = h(ctx).db.get<TerminalRow>('SELECT * FROM edc_terminal WHERE id = ?', x.terminal_id)!;
    const conn = connectorOf(ctx, t);
    const order = h(ctx).db.get<{ token_no: number | null }>('SELECT token_no FROM sale_order WHERE id = ?', x.order_id);
    const req = requestOf(x, order?.token_no ? `Token ${order.token_no}` : x.merchant_txn_id);
    if (x.kind === 'VOID') {
      const orig = txnRow(ctx, x.original_txn_id!);
      try {
        const r = conn.void ? await conn.void(requestOf(orig, req.reference), JSON.parse(orig.result_json ?? '{}') as TerminalResult, x.merchant_txn_id) : { status: 'FAILED' as const, message: 'Reverse this payment on the machine itself.' };
        save(ctx, id, r.status === 'APPROVED' ? 'APPROVED' : r.status === 'PENDING' ? 'UNKNOWN' : 'FAILED', r);
      } catch (e) { save(ctx, id, 'UNKNOWN', { message: `${(e as Error).message} Check the machine.` }); }
      return;
    }
    if (!opts.resume) {
      let r: TerminalResult;
      try { r = await conn.start(req); } catch (e) {
        save(ctx, id, t.connection === 'wired' ? 'UNKNOWN' : 'FAILED', { message: (e as Error).message });
        return;
      }
      save(ctx, id, r.status, r);
      if (r.status !== 'PENDING') return;
    }
    if (!conn.status) return;
    const { pollMs, waitMs } = timings.get(ctx) ?? { pollMs: POLL_MS, waitMs: WAIT_MS };
    const since = Date.now();
    for (;;) {
      x = txnRow(ctx, id);
      if (x.status !== 'PENDING') return;
      if (Date.now() - since > waitMs) {
        try { if (conn.cancel) await conn.cancel(req, x.provider_ref); } catch { /* reported below */ }
        save(ctx, id, 'UNKNOWN', { message: 'No answer from the machine in 6 minutes. Check it: if it shows approved, use "Check again".' });
        return;
      }
      await sleep(pollMs);
      try {
        const r = await conn.status(req, x.provider_ref);
        if (r.status !== 'PENDING') { save(ctx, id, r.status, r); return; }
      } catch { /* the internet dropped for a moment: keep asking until the time is up */ }
    }
  } catch (e) {
    try { save(ctx, id, 'UNKNOWN', { message: String((e as Error).message ?? e) }); } catch { /* database closed */ }
  } finally { set.delete(id); }
}

/** Sends the bill total to a machine. Returns at once with the attempt; the result arrives in the background. */
export function startCharge(ctx: Ctx, actor: Actor, requestId: string, input: { orderId: string; mode: 'CARD' | 'UPI'; terminalId?: string | null }): TxnView {
  const out = h(ctx).runCommand(ctx, requestId, 'terminal.charge', actor, () => {
    h(ctx).assertPerm(actor, 'invoice.finalize');
    const order = h(ctx).billing.order!(input.orderId);
    if (order.status !== 'DRAFT' && order.status !== 'HELD') throw new (h(ctx).AppError)('ORDER_NOT_OPEN', 'This bill is not open.', 409);
    if (h(ctx).db.get("SELECT 1 FROM edc_txn WHERE order_id = ? AND kind = 'SALE' AND status = 'PENDING'", order.id)) throw new (h(ctx).AppError)('TERMINAL_BUSY', 'This bill is already waiting on a machine.', 409);
    if (h(ctx).db.get("SELECT 1 FROM edc_txn WHERE order_id = ? AND kind = 'SALE' AND status = 'APPROVED' AND invoice_id IS NULL", order.id)) {
      throw new (h(ctx).AppError)('ALREADY_PAID_ON_MACHINE', 'A machine already approved a payment for this bill. Finish the bill instead of charging again.', 409);
    }
    const t = input.terminalId
      ? h(ctx).db.get<TerminalRow>('SELECT * FROM edc_terminal WHERE id = ? AND active = 1', input.terminalId)
      : h(ctx).db.get<TerminalRow>("SELECT * FROM edc_terminal WHERE active = 1 AND (',' || modes || ',') LIKE ? ORDER BY is_default DESC, name LIMIT 1", `%,${input.mode},%`);
    if (!t) throw new (h(ctx).AppError)('NO_TERMINAL', 'No payment machine is set up for this. Settings > Payment machines.', 409);
    if (!t.modes.split(',').includes(input.mode)) throw new (h(ctx).AppError)('VALIDATION', `${t.name} is not set up for ${input.mode === 'UPI' ? 'UPI' : 'cards'}.`);
    const amount = order.grandTotal; // the POS's own total, never the screen's
    if (amount <= 0) throw new (h(ctx).AppError)('VALIDATION', 'Nothing to charge on this bill.');
    const id = ctx.ids.next(), now = ctx.clock.now();
    const merchantTxnId = `TP${now.toString(36).toUpperCase()}${id.replace(/[^A-Za-z0-9]/g, '').slice(-10).toUpperCase()}`.slice(0, 25);
    h(ctx).db.run(`INSERT INTO edc_txn(id, terminal_id, order_id, kind, mode, amount, merchant_txn_id, status, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?, 'PENDING', ?,?,?)`, id, t.id, order.id, 'SALE', input.mode, amount, merchantTxnId, actor.userId, now, now);
    h(ctx).audit(ctx, actor.userId, 'terminal.charge', 'sale_order', order.id, { terminal: t.id, amount, mode: input.mode });
    return { id };
  });
  if (txnRow(ctx, out.id).status === 'PENDING') void drive(ctx, out.id);
  return txnView(ctx, txnRow(ctx, out.id));
}

/** Stops a waiting payment: from the POS for internet machines, otherwise the cashier presses Cancel on the machine. */
export async function cancelCharge(ctx: Ctx, actor: Actor, id: string): Promise<TxnView> {
  h(ctx).assertPerm(actor, 'invoice.finalize');
  const x = txnRow(ctx, id);
  if (x.status !== 'PENDING') return txnView(ctx, x);
  const t = h(ctx).db.get<TerminalRow>('SELECT * FROM edc_terminal WHERE id = ?', x.terminal_id)!;
  const conn = connectorOf(ctx, t);
  if (!conn.cancel) throw new (h(ctx).AppError)('CANCEL_ON_MACHINE', 'Press Cancel on the machine. The POS waits for its answer.', 409);
  const r = await conn.cancel(requestOf(x, x.merchant_txn_id), x.provider_ref);
  if (r.status === 'CANCELLED') save(ctx, id, 'CANCELLED', r);
  else throw new (h(ctx).AppError)('CANCEL_FAILED', r.message, 409);
  h(ctx).audit(ctx, actor.userId, 'terminal.cancel', 'edc_txn', id);
  return txnView(ctx, txnRow(ctx, id));
}

/** UNKNOWN: asks the company again (where it can be asked). */
export async function recheckCharge(ctx: Ctx, actor: Actor, id: string): Promise<TxnView> {
  h(ctx).assertPerm(actor, 'invoice.finalize');
  const x = txnRow(ctx, id);
  if (x.status !== 'UNKNOWN' && x.status !== 'PENDING') return txnView(ctx, x);
  const t = h(ctx).db.get<TerminalRow>('SELECT * FROM edc_terminal WHERE id = ?', x.terminal_id)!;
  const conn = connectorOf(ctx, t);
  if (!conn.status) throw new (h(ctx).AppError)('CHECK_ON_MACHINE', 'This machine cannot be asked from the POS. Look at its screen or last slip.', 409);
  const r = await conn.status(requestOf(x, x.merchant_txn_id), x.provider_ref).catch((e: Error) => ({ status: 'PENDING' as const, message: e.message }));
  if (r.status !== 'PENDING') save(ctx, id, r.status, r);
  else h(ctx).db.run('UPDATE edc_txn SET message = ?, updated_at = ? WHERE id = ?', r.message.slice(0, 300), ctx.clock.now(), id);
  return txnView(ctx, txnRow(ctx, id));
}

const POS_MODE: Record<PaidBy, string> = { CARD: 'CARD', UPI: 'UPI', WALLET: 'WALLET', OTHER: 'OTHER' };
/** The payment reference kept on the bill (60 characters at most): company, approval code, RRN, card's last 4. */
export function referenceOf(provider: Provider, r: TxnResult | null): string {
  const parts = [PROVIDER_NAME[provider], r?.approvalCode ? `Auth ${r.approvalCode}` : null, r?.rrn ? `RRN ${r.rrn}` : null, r?.cardLast4 ? `*${r.cardLast4}` : null].filter(Boolean);
  return parts.join(' ').slice(0, 60);
}

/** Saves the bill paid by the approved machine payment (the normal finalize; the amount must still be the bill total). */
export function completeCharge(ctx: Ctx, actor: Actor, requestId: string, id: string) {
  h(ctx).assertPerm(actor, 'invoice.finalize');
  const x = txnRow(ctx, id);
  if (x.kind !== 'SALE' || x.status !== 'APPROVED') throw new (h(ctx).AppError)('NOT_APPROVED', 'The machine has not approved this payment.', 409);
  const order = h(ctx).billing.order!(x.order_id);
  if (order.status === 'INVOICED' || x.invoice_id) {
    const inv = h(ctx).db.get<{ id: string }>("SELECT id FROM invoice WHERE order_id = ? AND doc_type = 'TAX_INVOICE' ORDER BY issued_at LIMIT 1", x.order_id);
    if (inv && !x.invoice_id) h(ctx).db.run('UPDATE edc_txn SET invoice_id = ?, updated_at = ? WHERE id = ?', inv.id, ctx.clock.now(), id);
  }
  const total = order.status === 'INVOICED' ? x.amount : order.grandTotal;
  if (total !== x.amount) throw new (h(ctx).AppError)('AMOUNT_CHANGED', 'The bill changed after it was sent to the machine. Reverse the machine payment (void) and charge again.', 409, { approved: x.amount, bill: total });
  const t = h(ctx).db.get<TerminalRow>('SELECT * FROM edc_terminal WHERE id = ?', x.terminal_id)!;
  const r = x.result_json ? JSON.parse(x.result_json) as TxnResult : null;
  const paidBy: PaidBy = r?.paidBy && r.paidBy !== 'OTHER' ? r.paidBy : x.mode === 'UPI' ? 'UPI' : 'CARD';
  const res = h(ctx).billing.finalize!(ctx, actor, requestId, { orderId: x.order_id, payments: [{ mode: POS_MODE[paidBy], amount: x.amount, reference: referenceOf(t.provider, r) }] });
  h(ctx).db.run('UPDATE edc_txn SET invoice_id = ?, updated_at = ? WHERE id = ? AND invoice_id IS NULL', res.invoice.id, ctx.clock.now(), id);
  return res;
}

/** The open bill's attempt that still needs attention (after a reload): waiting, approved without a bill, or unclear. */
export function openChargeFor(ctx: Ctx, actor: Actor, orderId: string): TxnView | null {
  h(ctx).assertPerm(actor, 'invoice.finalize');
  const x = h(ctx).db.get<TxnRow>("SELECT * FROM edc_txn WHERE order_id = ? AND kind = 'SALE' AND (status IN ('PENDING','UNKNOWN') OR (status = 'APPROVED' AND invoice_id IS NULL)) ORDER BY created_at DESC LIMIT 1", orderId);
  return x ? txnView(ctx, x) : null;
}

/** Reverses an approved machine payment of today (where the machine allows it from the POS). A manager approves. */
export function voidCharge(ctx: Ctx, actor: Actor, requestId: string, id: string, override?: Override): TxnView {
  const out = h(ctx).runCommand(ctx, requestId, 'terminal.void', actor, () => {
    const approver = h(ctx).requireApproval!(ctx, actor, 'invoice.cancel', override);
    const x = txnRow(ctx, id);
    if (x.kind !== 'SALE' || x.status !== 'APPROVED') throw new (h(ctx).AppError)('VALIDATION', 'Only an approved machine payment can be reversed.');
    if (istDay(x.created_at) !== istDay(ctx.clock.now())) throw new (h(ctx).AppError)('VOID_TOO_LATE', 'Machine payments can be reversed on the same day only. Refund the customer instead.', 409);
    if (h(ctx).db.get("SELECT 1 FROM edc_txn WHERE original_txn_id = ? AND status IN ('PENDING','APPROVED')", id)) throw new (h(ctx).AppError)('ALREADY_VOIDED', 'This payment is already reversed (or being reversed).', 409);
    const vid = ctx.ids.next(), now = ctx.clock.now();
    h(ctx).db.run(`INSERT INTO edc_txn(id, terminal_id, order_id, kind, mode, amount, merchant_txn_id, status, original_txn_id, created_by, created_at, updated_at)
      VALUES (?,?,?, 'VOID', ?,?,?, 'PENDING', ?,?,?,?)`, vid, x.terminal_id, x.order_id, x.mode, x.amount, `TV${now.toString(36).toUpperCase()}${vid.replace(/[^A-Za-z0-9]/g, '').slice(-10).toUpperCase()}`.slice(0, 25), id, actor.userId, now, now);
    h(ctx).audit(ctx, actor.userId, 'terminal.void', 'edc_txn', id, { approver, amount: x.amount });
    return { id: vid };
  });
  if (txnRow(ctx, out.id).status === 'PENDING') void drive(ctx, out.id);
  return txnView(ctx, txnRow(ctx, out.id));
}

/** Machine payments of a bill (Orders screen: reverse on the machine). */
export function chargesForInvoice(ctx: Ctx, actor: Actor, invoiceId: string): TxnView[] {
  h(ctx).assertPerm(actor, 'invoice.read');
  return h(ctx).db.all<TxnRow>("SELECT t.* FROM edc_txn t WHERE t.invoice_id = ? OR t.original_txn_id IN (SELECT id FROM edc_txn WHERE invoice_id = ?) ORDER BY t.created_at", invoiceId, invoiceId).map((x) => txnView(ctx, x));
}

/**
 * At start-up: a wired machine was waiting when the POS stopped (its answer is lost), so it becomes UNKNOWN;
 * internet machines are asked again in the background.
 */
export function resumeCharges(ctx: Ctx): number {
  const open = h(ctx).db.all<TxnRow & { connection: Connection }>("SELECT x.*, t.connection FROM edc_txn x JOIN edc_terminal t ON t.id = x.terminal_id WHERE x.status = 'PENDING'");
  for (const x of open) {
    if (x.connection === 'wired' || x.kind === 'VOID') save(ctx, x.id, 'UNKNOWN', { message: 'The POS restarted while waiting for the machine. Check the machine: if it shows approved, finish the bill.' });
    else void drive(ctx, x.id, { resume: true });
  }
  return open.length;
}
