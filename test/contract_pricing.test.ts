import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceOrder } from '../contract/src/menu.ts';
import { billOnlineOrder, onlineMenu } from '../src/services/onlineBilling.ts';
import { get } from '../src/store/db.ts';
import { makeEnv, rid, startShift } from './helpers.ts';

test('the hub prices an order exactly like the POS bills it: items merged, options, GST, fee lines and rounding', () => {
  const env = makeEnv(); try {
    startShift(env, 50000);
    const m = onlineMenu(env.ctx);
    const fiveGroup = get<{ id: string }>(env.ctx.db, 'SELECT id FROM tax_group WHERE rate_bp = 500 LIMIT 1')!.id;
    const feeTax = { rateBp: 500, cessBp: 0, priceIncludesTax: true };
    const id = (n: string) => m.items.find((i) => i.name === n)!.id;
    const burger = m.items.find((i) => i.name === 'Cheese Burger')!;
    const extra = m.modifierGroups.find((g) => burger.modifierGroupIds.includes(g.id))!.modifiers[0]!;
    const cart = [
      { itemId: id('Cheese Burger'), qtyMilli: 1000, modifierIds: [extra.id] },
      { itemId: id('Cheese Burger'), qtyMilli: 1000, modifierIds: [extra.id] }, // merged with the line above, like the POS does
      { itemId: id('Cola 300ml'), qtyMilli: 3000 },
    ];
    const p = priceOrder({ ...m, feeTax }, cart, { delivery: 3500, packaging: 1250 });
    assert.ok(p.ok);
    assert.equal(p.lines.length, 2);
    assert.equal(p.lines[0]!.qtyMilli, 2000);
    const bill = billOnlineOrder(env.ctx, env.cashier, rid(), { channel: 'APP', externalId: 'A-1', lines: cart, fees: { delivery: 3500, packaging: 1250, taxGroupId: fiveGroup }, paymentMode: 'CASH' });
    assert.equal(p.total, bill.grandTotal, 'customer total = POS bill');
    assert.deepEqual([p.deliveryFee, p.packagingFee], [3500, 1250]);
    // unavailable items and wrong options are refused with a reason
    assert.deepEqual(priceOrder({ ...m, feeTax }, [{ itemId: 'gone', qtyMilli: 1000 }]).ok, false);
    const r = priceOrder({ ...m, feeTax, items: m.items.map((i) => (i.id === burger.id ? { ...i, available: false } : i)) }, cart);
    assert.ok(!r.ok && r.reason === 'ITEM_UNAVAILABLE' && /Cheese Burger/.test(r.message));
    const bad = priceOrder({ ...m, feeTax }, [{ itemId: burger.id, qtyMilli: 1000, modifierIds: ['not-an-option'] }]);
    assert.ok(!bad.ok && bad.reason === 'OPTION_INVALID');
    assert.equal(priceOrder({ ...m, feeTax: null }, cart, { delivery: 100, packaging: 0 }).ok, false); // fees need a GST rate
  } finally { env.cleanup(); }
});
