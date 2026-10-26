import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, get, run, AppError } from '../src/store/db.ts';
import { addLine, cancelOrder, getCart, updateLine, removeLine } from '../src/services/orders.ts';
import { finalizeInvoice } from '../src/services/invoices.ts';
import { requireApproval } from '../src/services/auth.ts';
import { createStation, deleteStation, listStations, updateStation } from '../src/services/stations.ts';
import { clearKotDesign, getKotSettings, previewKotDesign, reprintOrderKot, sendKot, setKotDesignFile, setKotMode } from '../src/services/printing/kot.ts';
import { reprintKot, createPrinter } from '../src/services/printing/jobs.ts';
import { billOnlineOrder } from '../src/services/onlineBilling.ts';
import { parseEscPos } from '../src/services/printing/virtual.ts';
import { cartOf, makeEnv, rid, startShift } from './helpers.ts';
import type { Env } from './helpers.ts';

const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as AppError).code; } return 'NO_ERROR'; };
const station = (env: Env, name: string) => get<{ id: string }>(env.ctx.db, 'SELECT id FROM prep_station WHERE name = ? AND deleted_at IS NULL', name)!.id;
const printerId = (env: Env, name: string) => get<{ id: string }>(env.ctx.db, 'SELECT id FROM printer WHERE name = ?', name)!.id;
/** Kitchen tickets queued after a point, as text, with the printer they go to. */
function tickets(env: Env, after = 0) {
  return all<{ rowid: number; printer_id: string; payload: Uint8Array }>(env.ctx.db, "SELECT rowid, printer_id, payload FROM print_job WHERE kind = 'KOT' AND rowid > ? ORDER BY rowid", after)
    .map((j) => ({ rowid: j.rowid, printer: j.printer_id, text: parseEscPos(j.payload).lines.map((l) => l.trimEnd()).join('\n') }));
}
const lastRow = (env: Env) => get<{ r: number | null }>(env.ctx.db, 'SELECT max(rowid) r FROM print_job')!.r ?? 0;
const pay = (env: Env, orderId: string) => finalizeInvoice(env.ctx, env.cashier, rid(), { orderId, payments: [{ mode: 'CASH', amount: getCart(env.ctx, orderId).totals.grandTotal }] });

test('prep stations: create, rename, map categories and items (the item\'s own station wins), delete unmaps; printers list stations', () => {
  const env = makeEnv(); try {
    assert.deepEqual(listStations(env.ctx).map((s) => s.name), ['Kitchen', 'Bar'], 'the demo stations');
    assert.equal(code(() => createStation(env.ctx, env.cashier, rid(), { name: 'Tandoor' })), 'FORBIDDEN');
    assert.equal(code(() => createStation(env.ctx, env.manager, rid(), { name: 'kitchen' })), 'DUPLICATE');
    const tandoor = createStation(env.ctx, env.manager, rid(), { name: 'Tandoor' }).id;
    const sides = get<{ id: string }>(env.ctx.db, "SELECT id FROM category WHERE name = 'Sides'")!.id;
    updateStation(env.ctx, env.manager, rid(), tandoor, { name: 'Tandoor Oven', categoryIds: [sides], itemIds: [env.items['Cheese Burger']!] });
    const t = listStations(env.ctx).find((s) => s.id === tandoor)!;
    assert.equal(t.name, 'Tandoor Oven');
    assert.deepEqual(t.categoryIds, [sides]);
    assert.deepEqual(t.itemIds, [env.items['Cheese Burger']]);
    assert.ok(t.itemCount >= 2, 'the Sides items and the burger are made there');
    assert.deepEqual(t.printers, [], 'no printer prints it yet');
    assert.equal(code(() => createPrinter(env.ctx, env.owner, rid(), { name: 'X', transport: 'memory', stations: ['no-such-station'] })), 'VALIDATION');
    createPrinter(env.ctx, env.owner, rid(), { name: 'Tandoor printer', transport: 'memory', widthMm: 58, stations: [tandoor] });
    assert.deepEqual(listStations(env.ctx).find((s) => s.id === tandoor)!.printers.map((p) => p.name), ['Tandoor printer']);
    deleteStation(env.ctx, env.manager, rid(), tandoor);
    assert.equal(get<{ s: string | null }>(env.ctx.db, 'SELECT prep_station_id s FROM category WHERE id = ?', sides)!.s, null);
    assert.equal(get<{ s: string | null }>(env.ctx.db, 'SELECT prep_station_id s FROM item WHERE id = ?', env.items['Cheese Burger']!)!.s, null);
    assert.equal(get<{ s: string }>(env.ctx.db, "SELECT stations s FROM printer WHERE name = 'Tandoor printer'")!.s, '[]');
  } finally { env.cleanup(); }
});

test('KOT at prep stations: split by station; the cart sends only what is new; add-ons and cancels; billing prints only what is left', () => {
  const env = makeEnv(); try {
    startShift(env);
    const kitchenPrinter = printerId(env, 'Kitchen (virtual)');
    const cart = cartOf(env, [['Cheese Burger'], ['Cola 300ml', 2000]]);
    assert.deepEqual(getCart(env.ctx, cart.order.id).kot, { mode: 'stations', sentTickets: 0, pending: 2 });
    const first = sendKot(env.ctx, env.cashier, rid(), { orderId: cart.order.id });
    assert.equal(first.kotNo, 1);
    const t1 = tickets(env);
    assert.equal(t1.length, 2, 'one ticket per station');
    assert.ok(t1.every((t) => t.printer === kitchenPrinter));
    const kitchen = t1.find((t) => /^ *Kitchen$/m.test(t.text))!, bar = t1.find((t) => /^ *Bar$/m.test(t.text))!;
    assert.ok(kitchen.text.includes('1 x Cheese Burger') && !kitchen.text.includes('Cola'));
    assert.ok(bar.text.includes('2 x Cola 300ml') && !bar.text.includes('Cheese Burger'));
    assert.ok(kitchen.text.includes('TOKEN 1'));
    assert.ok(!/\d+\.\d\d/.test(kitchen.text.replace(/\d\d:\d\d/g, '')), 'no prices on kitchen tickets');
    assert.equal(code(() => sendKot(env.ctx, env.cashier, rid(), { orderId: cart.order.id })), 'NOTHING_TO_SEND');
    // one more burger, the cola taken off: ticket 2 is an add-on with a cancel
    const burgerLine = getCart(env.ctx, cart.order.id).lines.find((l) => l.name === 'Cheese Burger')!;
    updateLine(env.ctx, env.cashier, rid(), { lineId: burgerLine.id, qtyMilli: 2000 });
    removeLine(env.ctx, env.cashier, rid(), getCart(env.ctx, cart.order.id).lines.find((l) => l.name === 'Cola 300ml')!.id);
    const mark = lastRow(env);
    assert.equal(sendKot(env.ctx, env.cashier, rid(), { orderId: cart.order.id }).kotNo, 2);
    const t2 = tickets(env, mark);
    assert.equal(t2.length, 2);
    assert.ok(t2.every((t) => t.text.includes('ADD-ON KOT 2')));
    assert.ok(t2.find((t) => t.text.includes('Cheese Burger'))!.text.includes('1 x Cheese Burger'), 'only the extra one');
    assert.ok(t2.find((t) => t.text.includes('Cola'))!.text.includes('CANCEL 2 x Cola 300ml'));
    // billing: everything is with the kitchen already, so no new ticket; the receipt prints
    const before = lastRow(env);
    const bill = pay(env, cart.order.id);
    assert.equal(bill.print.kitchenTickets, 0);
    assert.equal(tickets(env, before).length, 0);
    // an order billed straight away: its tickets print with the bill
    const quick = cartOf(env, [['Brownie']]);
    const b2 = pay(env, quick.order.id);
    assert.equal(b2.print.kitchenTickets, 1);
    assert.ok(tickets(env, before).some((t) => t.text.includes('1 x Brownie')));
  } finally { env.cleanup(); }
});

test('KOT reprint (manager approves) prints every ticket again marked REPRINT; a cleared cart tells the kitchen', () => {
  const env = makeEnv(); try {
    startShift(env);
    const cart = cartOf(env, [['Cheese Burger']]);
    sendKot(env.ctx, env.cashier, rid(), { orderId: cart.order.id });
    addLine(env.ctx, env.cashier, rid(), { orderId: cart.order.id, itemId: env.items['Brownie']!, qtyMilli: 1000 });
    const bill = pay(env, cart.order.id);
    assert.equal(bill.print.kitchenTickets, 1, 'the brownie, added after the first ticket');
    const asCashier = (perm: 'invoice.reprint') => requireApproval(env.ctx, env.cashier, perm, undefined);
    assert.equal(code(() => reprintKot(env.ctx, env.cashier, rid(), { invoiceId: bill.invoice.id }, asCashier)), 'APPROVAL_REQUIRED');
    const mark = lastRow(env);
    const r = reprintKot(env.ctx, env.manager, rid(), { invoiceId: bill.invoice.id }, (perm) => requireApproval(env.ctx, env.manager, perm, undefined));
    assert.equal(r.queued, 2);
    const again = tickets(env, mark);
    assert.ok(again.every((t) => t.text.includes('*** REPRINT ***')));
    assert.ok(again.some((t) => t.text.includes('1 x Cheese Burger')) && again.some((t) => t.text.includes('1 x Brownie')));
    // reprint from the open cart too
    const open = cartOf(env, [['Cheese Burger', 3000]]);
    sendKot(env.ctx, env.cashier, rid(), { orderId: open.order.id });
    reprintOrderKot(env.ctx, env.manager, rid(), { orderId: open.order.id }, () => env.manager.userId);
    // the customer leaves: the cart is cleared after its ticket went out
    const m2 = lastRow(env);
    cancelOrder(env.ctx, env.cashier, rid(), open.order.id);
    assert.ok(tickets(env, m2).some((t) => t.text.includes('CANCEL 3 x Cheese Burger')));
    // a cart that never went to the kitchen: nothing to cancel
    const m3 = lastRow(env);
    cancelOrder(env.ctx, env.cashier, rid(), cartOf(env, [['Brownie']]).order.id);
    assert.equal(tickets(env, m3).length, 0);
  } finally { env.cleanup(); }
});

test('KOT modes: with the bill (customer design on the receipt printer, one per station), or off', () => {
  const env = makeEnv(); try {
    startShift(env);
    assert.equal(code(() => setKotMode(env.ctx, env.manager, rid(), 'with_bill')), 'FORBIDDEN');
    assert.equal(code(() => setKotMode(env.ctx, env.owner, rid(), 'loud')), 'VALIDATION');
    setKotMode(env.ctx, env.owner, rid(), 'with_bill');
    const mark = lastRow(env);
    const bill = pay(env, cartOf(env, [['Cheese Burger'], ['Cola 300ml']]).order.id);
    const t = tickets(env, mark);
    assert.equal(t.length, 2);
    assert.ok(t.every((x) => x.printer === printerId(env, 'Counter receipt (virtual)')), 'on the receipt printer');
    assert.ok(t.every((x) => x.text.includes('KITCHEN ORDER TICKET') && x.text.includes('TOKEN')), 'the customer KOT design');
    assert.ok(t.some((x) => x.text.includes('1 | Kitchen')) && t.some((x) => x.text.includes('1 | Bar')), 'token | station, per station');
    assert.ok(t.every((x) => x.text.includes(bill.invoice.invoiceNo)), 'the bill number');
    setKotMode(env.ctx, env.owner, rid(), 'off');
    const m2 = lastRow(env);
    const c = cartOf(env, [['Cheese Burger']]);
    assert.equal(code(() => sendKot(env.ctx, env.cashier, rid(), { orderId: c.order.id })), 'KOT_OFF');
    assert.equal(pay(env, c.order.id).print.kitchenTickets, 0);
    assert.equal(tickets(env, m2).length, 0);
    assert.equal(getKotSettings(env.ctx, env.manager).mode, 'off');
  } finally { env.cleanup(); }
});

test('KOT for online orders: the online design (channel, number, delivery); printing on accept can be switched off', () => {
  const env = makeEnv(); try {
    startShift(env);
    const mark = lastRow(env);
    const order = (n: string, print?: { receipt?: boolean; kot?: boolean }) => billOnlineOrder(env.ctx, env.cashier, rid(), {
      channel: 'WEBSITE', externalId: n, customerName: 'Asha', customerPhone: '9876543210', fulfilment: 'DELIVERY',
      lines: [{ itemId: env.items['Cheese Burger']!, qtyMilli: 1000 }], fees: { delivery: 0, packaging: 0, taxGroupId: null }, paymentMode: 'CASH', ...(print ? { print } : {}),
    });
    order('W-1042');
    const t = tickets(env, mark);
    assert.equal(t.length, 1);
    assert.ok(t[0]!.text.includes('ONLINE ORDER - KOT'));
    assert.ok(t[0]!.text.includes('Website W-1042'));
    assert.ok(t[0]!.text.includes('WEBSITE - DELIVERY'));
    assert.ok(t[0]!.text.includes('Asha'));
    const m2 = lastRow(env);
    const quiet = order('W-1043', { receipt: false, kot: false });
    assert.equal(all(env.ctx.db, 'SELECT 1 FROM print_job WHERE rowid > ?', m2).length, 0, 'nothing prints: the ODS prints by hand');
    reprintOrderKot(env.ctx, env.manager, rid(), { invoiceId: quiet.invoiceId }, () => env.manager.userId);
    assert.ok(tickets(env, m2).some((x) => x.text.includes('W-1043')), 'a bill never sent to the kitchen prints from its items');
  } finally { env.cleanup(); }
});

test('KOT designs: upload per slot (owner), preview without saving, used for printing, back to standard', () => {
  const env = makeEnv(); try {
    startShift(env);
    const design = JSON.stringify({ format: 'tiffin-kot', version: 1, name: 'Big station', blocks: [{ type: 'text', text: '*** {{kot.station}} ***', align: 'center', size: 'big' }, { type: 'items', size: 'tall' }] });
    const p = previewKotDesign(env.ctx, env.manager, 'station', { fileName: 'big.tiffinkot', content: design, widthMm: 58 });
    assert.equal(p.name, 'Big station');
    assert.ok(p.lines.some((l) => l.includes('T A N D O O R')), 'the sample, double width');
    assert.ok(previewKotDesign(env.ctx, env.manager, 'customer', { widthMm: 80 }).lines.some((l) => l.includes('KITCHEN ORDER TICKET')), 'the design in use, without a file');
    assert.equal(code(() => previewKotDesign(env.ctx, env.manager, 'station', { fileName: 'big.txt', content: design, widthMm: 58 })), 'VALIDATION');
    assert.equal(code(() => setKotDesignFile(env.ctx, env.manager, rid(), 'station', { fileName: 'big.tiffinkot', content: design })), 'FORBIDDEN');
    setKotDesignFile(env.ctx, env.owner, rid(), 'station', { fileName: 'big.tiffinkot', content: design });
    assert.equal(getKotSettings(env.ctx, env.manager).slots.station.custom!.name, 'Big station');
    const mark = lastRow(env);
    pay(env, cartOf(env, [['Cheese Burger']]).order.id);
    assert.ok(tickets(env, mark)[0]!.text.includes('*** Kitchen ***'));
    clearKotDesign(env.ctx, env.owner, rid(), 'station');
    assert.equal(getKotSettings(env.ctx, env.manager).slots.station.custom, null);
    assert.ok(!('kot_template_station' in Object.fromEntries(all<{ key: string }>(env.ctx.db, 'SELECT key FROM settings').map((r) => [r.key, 1]))));
    void run;
  } finally { env.cleanup(); }
});
