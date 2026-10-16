import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/store/db.ts';
import { addLine, applyBillDiscount, createOrder, holdOrder, listOpenOrders, removeLine, updateOrder } from '../src/services/orders.ts';
import { checkPayments, creditNoteOptions, createCreditNote, previewCreditNote } from '../src/services/invoices.ts';
import { cartOf, makeEnv, quickBill, rid, startShift } from './helpers.ts';

const code = (fn: () => unknown): string => { try { fn(); } catch (e) { if (e instanceof AppError) return e.code; throw e; } return 'NO_ERROR'; };

test('removing an item after an approved amount discount needs approval again, and the approval is accepted', () => {
  const env = makeEnv(); try {
    startShift(env);
    const cart = cartOf(env, [['Cheese Burger'], ['Brownie']]);
    const mgr = { userId: env.manager.userId, pin: '2345' };
    applyBillDiscount(env.ctx, env.cashier, rid(), { orderId: cart.order.id, discount: { type: 'amount', value: 2000 }, override: mgr }); // Rs 20 of 218: under the 10% limit? no, approved anyway
    const brownie = cart.lines.find((l) => l.name === 'Brownie')!.id;
    // Rs 20 off a Rs 129 bill is above the cashier's 10% limit: the removal needs the manager again
    assert.equal(code(() => removeLine(env.ctx, env.cashier, rid(), brownie)), 'APPROVAL_REQUIRED');
    const after = removeLine(env.ctx, env.cashier, rid(), brownie, mgr);
    assert.equal(after.lines.length, 1);
    // order details can be edited with an approval too
    assert.equal(updateOrder(env.ctx, env.cashier, rid(), { orderId: cart.order.id, customerPhone: '9876543210' }, mgr).order.customerPhone, '9876543210');
  } finally { env.cleanup(); }
});

test('held bills list shows total, customer and cashier, and can be filtered', () => {
  const env = makeEnv(); try {
    startShift(env);
    const a = cartOf(env, [['Cheese Burger', 2000]]);
    updateOrder(env.ctx, env.cashier, rid(), { orderId: a.order.id, customerPhone: '9123456789', note: 'Table 4' });
    holdOrder(env.ctx, env.cashier, rid(), a.order.id);
    createOrder(env.ctx, env.cashier, rid()); // an empty draft
    const held = listOpenOrders(env.ctx, { status: 'HELD' });
    assert.equal(held.length, 1);
    assert.deepEqual([held[0]!.grandTotal, held[0]!.customerPhone, held[0]!.note, held[0]!.createdByName, held[0]!.lineCount], [25800, '9123456789', 'Table 4', 'Cashier', 1]);
    assert.equal(listOpenOrders(env.ctx).length, 2);
    assert.equal(listOpenOrders(env.ctx, { status: 'DRAFT' })[0]!.grandTotal, 0);
  } finally { env.cleanup(); }
});

test('payment check: the backend says what is left to pay and the change, so the UI never does the sums', () => {
  const env = makeEnv(); try {
    startShift(env);
    const cart = cartOf(env, [['Cheese Burger', 2000]]); // Rs 258
    const id = cart.order.id;
    assert.deepEqual(checkPayments(env.ctx, id, []), { total: 25800, paid: 0, remaining: 25800, changeDue: 0, ok: false, message: 'Add a payment.' });
    const part = checkPayments(env.ctx, id, [{ mode: 'UPI', amount: 10000 }]);
    assert.deepEqual([part.paid, part.remaining, part.ok], [10000, 15800, false]);
    const split = checkPayments(env.ctx, id, [{ mode: 'UPI', amount: 10000 }, { mode: 'CASH', amount: 15800, tendered: 20000 }]);
    assert.deepEqual([split.remaining, split.changeDue, split.ok, split.message], [0, 4200, true, null]);
    const over = checkPayments(env.ctx, id, [{ mode: 'CARD', amount: 30000 }]);
    assert.deepEqual([over.remaining, over.ok], [-4200, false]);
    assert.match(over.message ?? '', /more than the bill/);
    const low = checkPayments(env.ctx, id, [{ mode: 'CASH', amount: 25800, tendered: 20000 }]);
    assert.equal(low.ok, false);
    assert.match(low.message ?? '', /less than/);
    assert.equal(checkPayments(env.ctx, id, [{ mode: 'BITCOIN', amount: 25800 }]).ok, false);
  } finally { env.cleanup(); }
});

test('refund preview equals the credit note that is then issued; returnable quantities go down', () => {
  const env = makeEnv(); try {
    startShift(env);
    const b = quickBill(env, [['Cheese Burger', 3000], ['Cola 300ml']]);
    const opts = creditNoteOptions(env.ctx, b.invoice.id);
    const burger = opts.lines.find((l) => l.name === 'Cheese Burger')!;
    assert.deepEqual([burger.soldQtyMilli, burger.returnedQtyMilli, burger.remainingQtyMilli], [3000, 0, 3000]);
    const pv = previewCreditNote(env.ctx, b.invoice.id, [{ invoiceLineId: burger.invoiceLineId, qtyMilli: 1000 }]);
    const cn = createCreditNote(env.ctx, env.manager, rid(), { invoiceId: b.invoice.id, lines: [{ invoiceLineId: burger.invoiceLineId, qtyMilli: 1000 }], reason: 'Cold', refunds: [{ mode: 'CASH', amount: pv.total }] });
    assert.equal(cn.invoice.grandTotal, pv.total);
    assert.equal(pv.lines[0]!.amount, cn.lines[0]!.lineTotal);
    assert.equal(creditNoteOptions(env.ctx, b.invoice.id).lines.find((l) => l.invoiceLineId === burger.invoiceLineId)!.remainingQtyMilli, 2000);
    assert.equal(code(() => previewCreditNote(env.ctx, b.invoice.id, [{ invoiceLineId: burger.invoiceLineId, qtyMilli: 3000 }])), 'CREDIT_EXCEEDS');
    assert.equal(code(() => previewCreditNote(env.ctx, b.invoice.id, [])), 'VALIDATION');
    // the full remainder (including the original round-off) is exactly what is left
    const rest = creditNoteOptions(env.ctx, b.invoice.id).lines.filter((l) => l.remainingQtyMilli > 0).map((l) => ({ invoiceLineId: l.invoiceLineId, qtyMilli: l.remainingQtyMilli }));
    const pvAll = previewCreditNote(env.ctx, b.invoice.id, rest);
    assert.equal(pvAll.total + pv.total, b.invoice.grandTotal);
  } finally { env.cleanup(); }
});
