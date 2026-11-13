import { randomBytes } from 'node:crypto';
import { all, get } from '../store/db.ts';
import { istDay } from '../core/numbering.ts';
import type { Ctx } from './ctx.ts';
import { getSetting, setSetting } from './settings.ts';
import type { InvoiceRecord, LineRecord, PaymentRecord } from './invoiceStore.ts';

/**
 * Sales sync: sends each bill up to PosiNext Cloud (POST /v1/pos/sync/batches) for the owner's portal (Analytics).
 * Billing never waits for it and never needs it: this only reads the outbox that billing already writes, after the
 * bill is committed, and keeps its own place in a setting. Nothing is sent until this POS is linked with the cloud:
 * the owner signed in to their account on this PC (Settings > Licence), or connected online orders or online backups.
 * It can be switched off (setting sales_sync_on = 0).
 *
 * What is sent per bill: number, time, totals, tax, discount, the items with their category, the payment modes, the
 * sales channel and the billing counter's name. No customer phone, name or GSTIN.
 *
 * Failure handling:
 *  - No internet or the cloud is down: the error is recorded and the next run (a minute later) carries on from the same bill.
 *  - The same batch sent twice (the answer was lost): the cloud stores it once.
 *  - The cloud does not hold what this POS thinks it sent (the cloud was restored), or this POS was restored from a
 *    backup: a new stream starts and every bill is sent again; the cloud counts each bill once (by its id).
 */

const STATE = 'sales_sync_state', ON = 'sales_sync_on', LAST = 'sales_sync_last_at', ERROR = 'sales_sync_error';
const BATCH_ROWS = 100, MAX_BATCHES = 200;

interface State { stream: string; /** the last outbox row sent */ cursor: number; /** the last event number the cloud holds */ seq: number }
interface Event { seq: number; kind: string; payload: unknown; createdAt: string }
interface OutboxRow { seq: number; entity_id: string; op: string; payload: string; created_at: number }
export interface SalesSyncStatus { linked: boolean; on: boolean; pending: number; lastAt: number | null; error: string | null }
export interface SalesSyncOptions { fetch?: typeof fetch }

const newState = (): State => ({ stream: randomBytes(16).toString('hex'), cursor: 0, seq: 0 });
function readState(ctx: Ctx): State {
  try {
    const s = JSON.parse(getSetting(ctx, STATE)) as State;
    if (typeof s.stream === 'string' && Number.isSafeInteger(s.cursor) && Number.isSafeInteger(s.seq)) return s;
  } catch { /* not started yet */ }
  return newState();
}

/** The cloud this POS is linked with: its account link (licence), else online orders, else online backups. */
function link(ctx: Ctx): { url: string; key: string } | null {
  const lic = get<{ cloud_url: string | null; device_key: string | null }>(ctx.db, 'SELECT cloud_url, device_key FROM licence WHERE id = 1');
  if (lic?.cloud_url && lic.device_key) return { url: lic.cloud_url, key: lic.device_key };
  for (const [u, k] of [['ods_hub_url', 'ods_hub_key'], ['cloud_backup_url', 'cloud_backup_key']] as const) {
    const url = getSetting(ctx, u), key = getSetting(ctx, k);
    if (url && key) return { url, key };
  }
  return null;
}

const pendingRows = (ctx: Ctx, cursor: number) => get<{ n: number }>(ctx.db, "SELECT count(*) AS n FROM outbox WHERE entity = 'invoice' AND seq > ?", cursor)!.n;

export function salesSyncStatus(ctx: Ctx): SalesSyncStatus {
  return { linked: link(ctx) !== null, on: getSetting(ctx, ON) !== '0', pending: pendingRows(ctx, readState(ctx).cursor), lastAt: Number(getSetting(ctx, LAST)) || null, error: getSetting(ctx, ERROR) || null };
}
export function setSalesSync(ctx: Ctx, on: boolean): SalesSyncStatus {
  setSetting(ctx, ON, on ? '1' : '0');
  return salesSyncStatus(ctx);
}

const CHANNEL: Record<string, string> = { COUNTER: 'pos', APP: 'app', WEBSITE: 'website', SWIGGY: 'swiggy', ZOMATO: 'zomato' };

/** One outbox row as the cloud's sync events (hub/src/analytics.ts in posinext-cloud reads these fields). */
function toEvents(ctx: Ctx, row: OutboxRow): Array<Omit<Event, 'seq'>> {
  if (row.op === 'cancel') {
    const iv = get<{ issued_at: number; grand_total: number }>(ctx.db, 'SELECT issued_at, grand_total FROM invoice WHERE id = ?', row.entity_id);
    return [{ kind: 'bill.voided', createdAt: new Date(row.created_at).toISOString(), payload: { billId: row.entity_id, totalPaise: iv?.grand_total ?? 0, businessDate: istDay(iv?.issued_at ?? row.created_at) } }];
  }
  const f = JSON.parse(row.payload) as { invoice: InvoiceRecord; lines: LineRecord[]; payments: PaymentRecord[] };
  const iv = f.invoice, at = new Date(iv.issuedAt).toISOString(), businessDate = istDay(iv.issuedAt);
  const terminal = get<{ name: string }>(ctx.db, 'SELECT name FROM device WHERE id = ?', iv.deviceId)?.name ?? null;
  const tenders = f.payments.map((p) => ({ mode: p.mode.toLowerCase(), amountPaise: p.amount }));
  if (iv.docType === 'CREDIT_NOTE') {
    return [{ kind: 'bill.refunded', createdAt: at, payload: { billId: iv.id, billNo: iv.invoiceNo, refundPaise: iv.grandTotal, originalBillId: iv.originalInvoiceId, businessDate, terminal, tenders } }];
  }
  const order = get<{ channel: string; fulfilment: string | null }>(ctx.db, 'SELECT channel, fulfilment FROM sale_order WHERE id = ?', iv.orderId);
  const category = (itemId: string | null) => (itemId ? get<{ name: string }>(ctx.db, 'SELECT c.name FROM item i JOIN category c ON c.id = i.category_id WHERE i.id = ?', itemId)?.name ?? null : null);
  return [
    { kind: 'bill.printed', createdAt: at, payload: {
      billId: iv.id, billNo: iv.invoiceNo, totalPaise: iv.grandTotal, businessDate,
      // a counter sale is neither a table order nor an online one: the cloud shows it as "Counter"
      orderType: order?.fulfilment === 'DELIVERY' ? 'delivery' : order?.fulfilment === 'PICKUP' ? 'takeaway' : 'counter',
      channel: CHANNEL[order?.channel ?? 'COUNTER'] ?? 'pos', terminal,
      taxPaise: iv.cgst + iv.sgst + iv.igst + iv.cess, discountPaise: iv.discountTotal,
      lines: f.lines.map((l) => ({ name: l.name, category: category(l.itemId), qtyMilli: l.qtyMilli, amountPaise: l.lineTotal })),
    } },
    { kind: 'bill.settled', createdAt: at, payload: { billId: iv.id, totalPaise: iv.grandTotal, tenders, changePaise: 0, businessDate } },
  ];
}

const running = new WeakSet<Ctx>();

/** Sends every bill not sent yet. Returns how many outbox rows went up. Never throws: problems are recorded for the screen. */
export async function syncSales(ctx: Ctx, o: SalesSyncOptions = {}): Promise<number> {
  const to = link(ctx);
  if (!to || getSetting(ctx, ON) === '0' || running.has(ctx)) return 0;
  running.add(ctx);
  let sent = 0, restarted = false;
  try {
    // the stream's name is saved before anything is sent, so a batch sent again after a lost answer is the same batch
    if (!getSetting(ctx, STATE)) setSetting(ctx, STATE, JSON.stringify(newState()));
    for (let n = 0; n < MAX_BATCHES; n++) {
      const st = readState(ctx);
      const rows = all<OutboxRow>(ctx.db, "SELECT seq, entity_id, op, payload, created_at FROM outbox WHERE entity = 'invoice' AND seq > ? ORDER BY seq LIMIT ?", st.cursor, BATCH_ROWS);
      if (rows.length === 0) break;
      const events: Event[] = rows.flatMap((r) => toEvents(ctx, r)).map((e, i) => ({ seq: st.seq + 1 + i, ...e }));
      const res = await (o.fetch ?? fetch)(`${to.url.replace(/\/+$/, '')}/v1/pos/sync/batches`, {
        method: 'POST', signal: AbortSignal.timeout(60_000),
        headers: { authorization: `Bearer ${to.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ streamId: st.stream, fromSeq: st.seq + 1, events }),
      });
      if (res.status === 409 && !restarted) { // the cloud and this POS disagree about what was sent: send everything again as a new stream
        restarted = true;
        setSetting(ctx, STATE, JSON.stringify(newState()));
        continue;
      }
      if (res.status === 401) throw new Error('This POS is no longer linked with the cloud. Sign in to your account again in Settings > Licence.');
      if (!res.ok) throw new Error(`The cloud answered ${res.status}. The POS will try again in a minute.`);
      const ack = ((await res.json()) as { ackSeq?: number }).ackSeq;
      const last = events[events.length - 1]!.seq;
      if (ack !== last) throw new Error('The cloud did not confirm the bills sent. The POS will try again in a minute.');
      setSetting(ctx, STATE, JSON.stringify({ stream: st.stream, cursor: rows[rows.length - 1]!.seq, seq: last } satisfies State)); // one write: the place moves on whole or not at all
      sent += rows.length;
    }
    if (sent > 0) setSetting(ctx, LAST, String(ctx.clock.now()));
    if (getSetting(ctx, ERROR)) setSetting(ctx, ERROR, '');
  } catch (e) {
    const offline = e instanceof TypeError || (e as Error).name === 'TimeoutError' || (e as Error).name === 'AbortError';
    const msg = offline ? 'Could not reach the cloud. Bills are kept and sent when the internet is back.' : String((e as Error).message ?? e);
    if (getSetting(ctx, ERROR) !== msg) setSetting(ctx, ERROR, msg);
    ctx.logger.warn('sales sync failed', msg);
  } finally {
    running.delete(ctx);
  }
  return sent;
}

/** Sends soon after each bill, and every minute (first after 15 seconds) for anything left over. */
export function scheduleSalesSync(ctx: Ctx, o: SalesSyncOptions = {}): () => void {
  const tick = () => { void syncSales(ctx, o); };
  let soon: NodeJS.Timeout | null = null;
  const onBill = () => { soon ??= setTimeout(() => { soon = null; tick(); }, 3000); soon.unref(); };
  ctx.events.on('invoice', onBill);
  const first = setTimeout(tick, 15_000), t = setInterval(tick, 60_000);
  first.unref(); t.unref();
  return () => { ctx.events.off('invoice', onBill); clearTimeout(first); clearInterval(t); if (soon) clearTimeout(soon); };
}
