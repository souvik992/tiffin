// Which orders on the live ODS feed are new since the last update (for the buzzer). No browser or POS parts: tested alone.

export interface FeedOrder { id: string; number: string; state: string; billInvoiceId: string | null; order?: { etaAt?: number | null } }

/** Accepted and in the kitchen: the preparation clock runs for these. */
const COOKING = new Set(['ACCEPTED', 'PREPARING']);
const SOON_MS = 2 * 60_000;

/** Orders in the kitchen whose promised ready time has passed (not yet marked Ready). */
export const lateOrders = (orders: FeedOrder[], now: number) =>
  orders.filter((o) => COOKING.has(o.state) && typeof o.order?.etaAt === 'number' && now >= o.order.etaAt);

/**
 * The preparation clock on an ODS card: time left until the promised ready time (m:ss), "soon" in the last 2 minutes,
 * then how late it is in whole minutes (at least 1). Null when the order has no ready time or is not in the kitchen.
 */
export function prepClock(state: string, etaAt: number | null | undefined, now: number): { text: string; soon: boolean; late: boolean } | null {
  if (!COOKING.has(state) || typeof etaAt !== 'number') return null;
  const ms = etaAt - now;
  if (ms > 0) {
    const s = Math.ceil(ms / 1000);
    return { text: `Ready in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`, soon: ms <= SOON_MS, late: false };
  }
  return { text: `Late by ${Math.max(1, Math.ceil(-ms / 60_000))} min`, soon: false, late: true };
}

const FINISHED = new Set(['REJECTED', 'AUTO_REJECTED', 'CANCELLED', 'DELIVERED', 'PICKED_UP']);
/** Waiting for staff to accept or reject (the buzzer keeps ringing for these). */
export const isWaiting = (o: FeedOrder) => (o.state === 'SENT_TO_STORE' || o.state === 'RECEIVED') && !o.billInvoiceId;

/**
 * prev: the order ids of the last update, or null before the first one (then nothing counts as new: the POS just
 * started). arrived: new orders not already finished; autoAccepted: those of them no longer waiting (accepted by the
 * automatic accept mode before the feed showed them), which ring once instead of until accepted.
 */
export function arrivals(prev: Set<string> | null, orders: FeedOrder[]) {
  const ids = new Set(orders.map((o) => o.id));
  const arrived = prev ? orders.filter((o) => !prev.has(o.id) && !FINISHED.has(o.state)) : [];
  return { ids, arrived, autoAccepted: arrived.filter((o) => !isWaiting(o)) };
}
