import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get, AppError } from '../src/store/db.ts';
import {
  createCategory, createItem, deleteCategory, deleteItem, getCatalog, importItemsCsv, previewItemsCsv, reorderCategories, updateCategory, updateItem,
} from '../src/services/catalog.ts';
import { makeEnv, quickBill, rid, startShift } from './helpers.ts';

const code = (fn: () => unknown): string => { try { fn(); } catch (e) { if (e instanceof AppError) return e.code; throw e; } return 'NO_ERROR'; };
const gst5 = (env: ReturnType<typeof makeEnv>) => get<{ id: string }>(env.ctx.db, 'SELECT id FROM tax_group WHERE rate_bp = 500')!.id;

test('items: veg, non-veg or not set; duplicate names refused on create and rename', () => {
  const env = makeEnv(); try {
    const tg = gst5(env);
    const dosa = createItem(env.ctx, env.manager, rid(), { name: 'Masala Dosa', taxGroupId: tg, price: 9000, isVeg: true }).id;
    const kebab = createItem(env.ctx, env.manager, rid(), { name: 'Seekh Kebab', taxGroupId: tg, price: 22000, isVeg: false }).id;
    const water = createItem(env.ctx, env.manager, rid(), { name: 'Water 500ml', taxGroupId: tg, price: 2000, isVeg: null }).id;
    const veg = (id: string) => get<{ v: number | null }>(env.ctx.db, 'SELECT is_veg v FROM item WHERE id = ?', id)!.v;
    assert.deepEqual([veg(dosa), veg(kebab), veg(water)], [1, 0, null]);

    assert.equal(code(() => createItem(env.ctx, env.manager, rid(), { name: ' masala DOSA ', taxGroupId: tg, price: 1 })), 'DUPLICATE');
    assert.equal(code(() => updateItem(env.ctx, env.manager, rid(), kebab, { name: 'Masala Dosa' })), 'DUPLICATE');
    updateItem(env.ctx, env.manager, rid(), kebab, { name: 'Seekh Kebab', isVeg: true }); // same name on itself is fine
    assert.equal(veg(kebab), 1);
    updateItem(env.ctx, env.manager, rid(), kebab, { isVeg: null });
    assert.equal(veg(kebab), null);
    // a deleted item's name can be reused
    deleteItem(env.ctx, env.manager, rid(), water);
    assert.equal(code(() => createItem(env.ctx, env.manager, rid(), { name: 'Water 500ml', taxGroupId: tg, price: 2000 })), 'NO_ERROR');
  } finally { env.cleanup(); }
});

test('categories: create, rename, reorder in one step, item counts, and delete only when empty', () => {
  const env = makeEnv(); try {
    const tg = gst5(env);
    const combos = createCategory(env.ctx, env.manager, rid(), { name: 'Combos', prepStationId: get<{ id: string }>(env.ctx.db, "SELECT id FROM prep_station WHERE name = 'Kitchen'")!.id }).id;
    assert.equal(code(() => createCategory(env.ctx, env.manager, rid(), { name: 'combos' })), 'DUPLICATE');
    assert.equal(code(() => createCategory(env.ctx, env.cashier, rid(), { name: 'X' })), 'FORBIDDEN');
    const burgers = get<{ id: string }>(env.ctx.db, "SELECT id FROM category WHERE name = 'Burgers'")!.id;
    assert.equal(code(() => updateCategory(env.ctx, env.manager, rid(), combos, { name: 'Burgers' })), 'DUPLICATE');
    updateCategory(env.ctx, env.manager, rid(), combos, { name: 'Meal Combos' });

    const ids = getCatalog(env.ctx).categories.map((c) => c.id as string);
    const wanted = [combos, ...ids.filter((x) => x !== combos)];
    reorderCategories(env.ctx, env.manager, rid(), wanted);
    const after = getCatalog(env.ctx).categories;
    assert.deepEqual(after.map((c) => c.id), wanted);
    assert.equal(after[0]!.name, 'Meal Combos');
    assert.equal(after.find((c) => c.id === burgers)!.itemCount, 4);
    assert.equal(after[0]!.itemCount, 0);
    assert.equal(code(() => reorderCategories(env.ctx, env.manager, rid(), wanted.slice(1))), 'VALIDATION'); // must list every category
    assert.equal(code(() => reorderCategories(env.ctx, env.manager, rid(), [...wanted.slice(1), 'nope'])), 'VALIDATION');
    assert.equal(code(() => reorderCategories(env.ctx, env.manager, rid(), [wanted[0]!, ...wanted])), 'VALIDATION');

    assert.equal(code(() => deleteCategory(env.ctx, env.manager, rid(), burgers)), 'IN_USE');
    createItem(env.ctx, env.manager, rid(), { name: 'Burger Combo', categoryId: combos, taxGroupId: tg, price: 19900, isVeg: true });
    assert.equal(code(() => deleteCategory(env.ctx, env.manager, rid(), combos)), 'IN_USE');
    const comboItem = get<{ id: string }>(env.ctx.db, "SELECT id FROM item WHERE name = 'Burger Combo'")!.id;
    deleteItem(env.ctx, env.manager, rid(), comboItem);
    deleteCategory(env.ctx, env.manager, rid(), combos);
    assert.ok(!getCatalog(env.ctx).categories.some((c) => c.id === combos));
    assert.equal(code(() => deleteCategory(env.ctx, env.manager, rid(), combos)), 'NOT_FOUND');
    assert.equal(code(() => createItem(env.ctx, env.manager, rid(), { name: 'Late', categoryId: combos, taxGroupId: tg, price: 1 })), 'VALIDATION');
    // a new category with the old name is allowed after deletion
    assert.equal(code(() => createCategory(env.ctx, env.manager, rid(), { name: 'Meal Combos' })), 'NO_ERROR');
  } finally { env.cleanup(); }
});

test('bulk upload: strict veg column, integer tax parsing, duplicates refused, all or nothing', () => {
  const env = makeEnv(); try {
    const head = 'name,category,price,tax_percent,hsn,barcode,unit,veg\n';
    const ok = previewItemsCsv(env.ctx, head + 'Paneer Tikka,Starters,249,5,,,pcs,veg\nChicken 65,Starters,269,5,,,pcs,non-veg\nEgg Roll,Rolls,99,5,,,pcs,NV\nSoda,Drinks,30,18,,,pcs,\nTea,Drinks,20,2.5,,,pcs,yes\n');
    assert.deepEqual(ok.errors, []);
    assert.deepEqual(ok.items.map((i) => i.isVeg), [true, false, false, null, true]);
    assert.deepEqual(ok.items.map((i) => i.taxPercent), [500, 500, 500, 1800, 250]);

    const bad = previewItemsCsv(env.ctx, head + 'Thing,X,10,5,,,pcs,veggie\nCheese Burger,X,10,5,,,pcs,veg\nNew One,X,10,5,,,pcs,veg\nnew one,X,10,5,,,pcs,veg\nOdd Tax,X,10,5.555,,,pcs,\n');
    assert.deepEqual(bad.errors.map((e) => e.row), [2, 3, 5, 6]);
    assert.match(bad.errors[0]!.message, /veg/);
    assert.match(bad.errors[1]!.message, /already on the menu/);
    assert.match(bad.errors[2]!.message, /repeated/);

    const r = importItemsCsv(env.ctx, env.manager, rid(), head + 'Paneer Tikka,Starters,249,5,,,pcs,veg\nChicken 65,Starters,269,5,,,pcs,non-veg\n');
    assert.equal(r.imported, 2);
    assert.equal(r.categoriesCreated, 1);
    assert.equal(get<{ v: number }>(env.ctx.db, "SELECT is_veg v FROM item WHERE name = 'Chicken 65'")!.v, 0);
    // uploading the same file again is refused instead of creating duplicates
    assert.equal(code(() => importItemsCsv(env.ctx, env.manager, rid(), head + 'Paneer Tikka,Starters,249,5,,,pcs,veg\n')), 'IMPORT_ERRORS');
  } finally { env.cleanup(); }
});

test('bulk upload categories: an existing one is reused (any capitals or spacing), a missing one is created once, and the preview says which are new', () => {
  const env = makeEnv(); try {
    const head = 'name,category,price,tax_percent,hsn,barcode,unit,veg\n';
    const csv = head + 'Aloo Tikki Burger,  burgers ,99,5,,,pcs,veg\nMango Shake,Shakes,129,5,,,pcs,veg\nOreo Shake,SHAKES,149,5,,,pcs,veg\nBerry  Shake,shakes,149,5,,,pcs,veg\nPlain Water,,20,0,,,pcs,\nVanilla Shake,Thick   Shakes,149,5,,,pcs,veg\nChoco Shake,thick shakes,149,5,,,pcs,veg\n';
    const p = previewItemsCsv(env.ctx, csv);
    assert.deepEqual(p.errors, []);
    assert.deepEqual(p.items.map((i) => [i.category, i.newCategory]), [
      ['Burgers', false], // existing: shown with its saved name
      ['Shakes', true], ['Shakes', true], ['Shakes', true], // one new category, written as first seen
      ['General', true],
      ['Thick Shakes', true], ['Thick Shakes', true], // extra spaces do not make a second category
    ]);
    assert.deepEqual(p.newCategories, ['Shakes', 'General', 'Thick Shakes']);
    const before = getCatalog(env.ctx).categories.length;
    const r = importItemsCsv(env.ctx, env.manager, rid(), csv);
    assert.deepEqual([r.imported, r.categoriesCreated], [7, 3]);
    const cats = getCatalog(env.ctx).categories;
    assert.equal(cats.length, before + 3);
    const burgers = cats.find((c) => c.name === 'Burgers')! as { id: string };
    assert.equal(get<{ c: string }>(env.ctx.db, "SELECT category_id c FROM item WHERE name = 'Aloo Tikki Burger'")!.c, burgers.id);
    // the next upload finds them all
    const again = previewItemsCsv(env.ctx, head + 'Kesar Shake,shakes,149,5,,,pcs,veg\nGinger Ale,general,60,18,,,pcs,\n');
    assert.deepEqual([again.newCategories, again.items.map((i) => i.category)], [[], ['Shakes', 'General']]);
    // adding one by hand follows the same rule
    assert.equal(code(() => createCategory(env.ctx, env.manager, rid(), { name: 'thick  SHAKES' })), 'DUPLICATE');
    assert.equal(code(() => updateCategory(env.ctx, env.manager, rid(), burgers.id, { name: ' shakes ' })), 'DUPLICATE');
    // capitals never matter: BURGERS, burgers and Burgers are one category
    assert.equal(code(() => createCategory(env.ctx, env.manager, rid(), { name: 'BURGERS' })), 'DUPLICATE');
    assert.equal(code(() => createCategory(env.ctx, env.manager, rid(), { name: 'burgers' })), 'DUPLICATE');
    assert.equal(previewItemsCsv(env.ctx, head + 'Spicy Burger,bUrGeRs,99,5,,,pcs,veg\n').items[0]!.category, 'Burgers');
    // a category may be renamed to a different capitalisation of its own name
    updateCategory(env.ctx, env.manager, rid(), burgers.id, { name: 'BURGERS' });
    assert.ok(getCatalog(env.ctx).categories.some((c) => c.name === 'BURGERS'));
  } finally { env.cleanup(); }
});

test('menu changes reach billing: a new item can be sold, and a renamed item keeps its old name on past bills', () => {
  const env = makeEnv(); try {
    startShift(env);
    const b = quickBill(env, [['Cheese Burger']]);
    updateItem(env.ctx, env.manager, rid(), env.items['Cheese Burger']!, { name: 'Cheese Burger Deluxe', price: 13900 });
    assert.equal(get<{ name: string }>(env.ctx.db, 'SELECT name FROM invoice_line WHERE invoice_id = ?', b.invoice.id)!.name, 'Cheese Burger');
    assert.ok(getCatalog(env.ctx).items.some((i) => i.name === 'Cheese Burger Deluxe' && i.price === 13900));
  } finally { env.cleanup(); }
});
