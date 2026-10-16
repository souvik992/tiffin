// Child process: finalizes N bills against a shared database, printing the invoice numbers.
import { createCtx, silentLogger } from '../../src/services/ctx.ts';
import { actorsFor } from '../helpers.ts';
import { addLine, createOrder } from '../../src/services/orders.ts';
import { finalizeInvoice } from '../../src/services/invoices.ts';
import { get } from '../../src/store/db.ts';

const [dir, n, tag] = process.argv.slice(2) as [string, string, string];
const ctx = createCtx({ dataDir: dir, logger: silentLogger, scryptCost: 1024, clock: { now: () => Date.UTC(2026, 9, 12, 5, 0, 0) } });
const { cashier } = actorsFor(ctx);
const item = get<{ id: string }>(ctx.db, "SELECT id FROM item WHERE name = 'Masala Chai'")!.id;
const nos: string[] = [];
for (let i = 0; i < Number(n); i++) {
  const cart = createOrder(ctx, cashier, `${tag}-o-${i}`.padEnd(10, 'x'));
  const filled = addLine(ctx, cashier, `${tag}-l-${i}`.padEnd(10, 'x'), { orderId: cart.order.id, itemId: item });
  nos.push(finalizeInvoice(ctx, cashier, `${tag}-f-${i}`.padEnd(10, 'x'), { orderId: cart.order.id, payments: [{ mode: 'CASH', amount: filled.totals.grandTotal }] }).invoice.invoiceNo);
}
console.log(JSON.stringify(nos));
