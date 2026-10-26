// Which orders on the live ODS feed are new since the last update (for the buzzer). No browser or POS parts: tested alone.

export interface FeedOrder { id: string; number: string; state: string; billInvoiceId: string | null }

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
