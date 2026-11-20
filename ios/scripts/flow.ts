// A first day at the counter, through the app's gatekeeper with its private cookie: the screens load (and not without
// the cookie), the shop is set up, an item is added, a shift opened and a cash bill made. Used by smoke.ts (the backend
// bundle on any computer) and simulator-test.ts (the real app in the iPhone simulator).
import { randomBytes } from 'node:crypto';

export async function billingFlow(base: string, token: string): Promise<string> {
  const cookie = { cookie: `pos_k=${token}` };
  let auth = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { ...cookie, 'content-type': 'application/json', 'idempotency-key': randomBytes(8).toString('hex'), ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${path}: HTTP ${r.status} ${text.slice(0, 300)}`);
    return JSON.parse(text) as Record<string, unknown>;
  };
  if ((await fetch(base + '/')).status !== 403) throw new Error('the gatekeeper let a request without the app cookie in');
  const page = await fetch(base + '/', { headers: cookie });
  if (page.status !== 200 || !(await page.text()).includes('<div id="root">')) throw new Error('the screens did not load');
  await call('POST', '/api/setup', {
    outlet: { name: 'Smoke Test Cafe', gstin: null, stateCode: '29', address: 'Bengaluru', phone: '9876543210' },
    device: { name: 'iPhone', seriesPrefix: 'I1' },
    owner: { name: 'Owner', pin: '1234', mobile: '9000000001' },
  });
  auth = String((await call('POST', '/api/auth/login', { mobile: '9000000001', pin: '1234' })).token);
  const cat = await call('POST', '/api/categories', { name: 'Snacks' });
  const taxes = (await call('GET', '/api/catalog')).taxGroups as Array<{ id: string; rateBp: number }>;
  const item = await call('POST', '/api/items', { name: 'Samosa', categoryId: cat.id, price: 2000, taxGroupId: taxes.find((t) => t.rateBp === 500)?.id ?? taxes[0]!.id });
  await call('POST', '/api/shifts/open', { openingCash: 0 });
  const order = (await call('POST', '/api/orders', {})).order as { id: string };
  const cart = await call('POST', `/api/orders/${order.id}/lines`, { itemId: item.id, qtyMilli: 2000 });
  const total = (cart.totals as { grandTotal: number }).grandTotal;
  const bill = await call('POST', `/api/orders/${order.id}/finalize`, { payments: [{ mode: 'CASH', amount: total }] });
  const inv = bill.invoice as { invoiceNo?: string; grandTotal?: number } | undefined;
  if (!inv) throw new Error(`no invoice in the answer: ${JSON.stringify(bill).slice(0, 200)}`);
  return `bill ${inv.invoiceNo ?? '?'} for Rs ${total / 100}`;
}
