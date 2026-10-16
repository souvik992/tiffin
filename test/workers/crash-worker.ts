// Child process: creates a bill and SIGKILLs itself at the requested point inside finalize.
import { createCtx, silentLogger } from '../../src/services/ctx.ts';
import { actorsFor } from '../helpers.ts';
import { addLine, createOrder } from '../../src/services/orders.ts';
import { finalizeInvoice } from '../../src/services/invoices.ts';
import { get } from '../../src/store/db.ts';
import { writeSync } from 'node:fs';

const [dir, point] = process.argv.slice(2) as [string, string];
const ctx = createCtx({ dataDir: dir, logger: silentLogger, scryptCost: 1024, clock: { now: () => Date.UTC(2026, 9, 12, 5, 0, 0) } });
const { cashier } = actorsFor(ctx);
const item = get<{ id: string }>(ctx.db, "SELECT id FROM item WHERE name = 'Cheese Burger'")!.id;
const cart = createOrder(ctx, cashier, `crash-order-${point}`);
const filled = addLine(ctx, cashier, `crash-line-${point}`, { orderId: cart.order.id, itemId: item });
// The marker is written synchronously, so the test can tell this kill from an ordinary crash on Windows,
// where there are no signals: SIGKILL becomes TerminateProcess and the exit shows as status 1, signal null.
ctx.hooks.fault = (p) => { if (p === point) { writeSync(2, `KILLING at ${point}
`); process.kill(process.pid, 'SIGKILL'); } };
finalizeInvoice(ctx, cashier, `crash-final-${point}`, { orderId: cart.order.id, payments: [{ mode: 'CASH', amount: filled.totals.grandTotal }] });
console.log('COMPLETED');
