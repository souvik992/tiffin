import { istDay } from '../core/numbering.ts';
import { all, get, run, AppError } from '../store/db.ts';
import type { Actor, Ctx } from './ctx.ts';
import { runCommand } from './commands.ts';
import { audit } from './audit.ts';
import { emit } from './outbox.ts';
import { assertPerm } from './permissions.ts';
import { camel, camelAll } from './camel.ts';
import { parsePaise } from '../core/money.ts';
import { checkStationId } from './stations.ts';

const MAX_PRICE = 1_000_000_000; // Rs 1 crore per unit

interface ItemRow { id: string; category_id: string | null; name: string; short_name: string | null; sku: string | null; barcode: string | null; hsn_code: string | null; tax_group_id: string; price: number; unit: string; is_veg: number | null; image_file: string | null; description: string | null; active: number; version: number; updated_at: number; deleted_at: number | null }

function fail(msg: string): never { throw new AppError('VALIDATION', msg); }
function clean(s: unknown, label: string, max: number, required = true): string | null {
  if (s === undefined || s === null || s === '') { if (required) fail(`${label} is required.`); return null; }
  if (typeof s !== 'string') fail(`${label} must be text.`);
  const t = (s as string).trim();
  if (!t && required) fail(`${label} is required.`);
  if (t.length > max) fail(`${label} is too long (max ${max}).`);
  return t || null;
}

export function getCatalog(ctx: Ctx) {
  const categories = camelAll<Record<string, unknown>>(all(ctx.db, `SELECT c.id, c.name, c.sort_order, c.prep_station_id,
      (SELECT count(*) FROM item i WHERE i.category_id = c.id AND i.deleted_at IS NULL) AS item_count
    FROM category c WHERE c.deleted_at IS NULL ORDER BY c.sort_order, c.name`));
  const taxGroups = camelAll(all(ctx.db, 'SELECT id, name, rate_bp, cess_bp, price_includes_tax FROM tax_group WHERE deleted_at IS NULL ORDER BY rate_bp'));
  const items = camelAll<Record<string, unknown>>(all(ctx.db, 'SELECT id, category_id, name, short_name, sku, barcode, hsn_code, tax_group_id, price, unit, is_veg, image_file, description, unavailable_on, prep_station_id FROM item WHERE deleted_at IS NULL AND active = 1 ORDER BY name'));
  const links = all<{ item_id: string; group_id: string }>(ctx.db, 'SELECT item_id, group_id FROM item_modifier_group');
  const byItem = new Map<string, string[]>();
  for (const l of links) byItem.set(l.item_id, [...(byItem.get(l.item_id) ?? []), l.group_id]);
  const today = istDay(ctx.clock.now());
  for (const it of items) { it.modifierGroupIds = byItem.get(it.id as string) ?? []; it.availableToday = it.unavailableOn !== today; delete it.unavailableOn; }
  const groups = all<{ id: string; name: string; min_select: number; max_select: number }>(ctx.db, 'SELECT id, name, min_select, max_select FROM modifier_group WHERE deleted_at IS NULL');
  const mods = all<{ id: string; group_id: string; name: string; price: number }>(ctx.db, 'SELECT id, group_id, name, price FROM modifier WHERE active = 1');
  const modifierGroups = groups.map((g) => ({ id: g.id, name: g.name, minSelect: g.min_select, maxSelect: g.max_select, modifiers: mods.filter((m) => m.group_id === g.id).map((m) => ({ id: m.id, name: m.name, price: m.price })) }));
  return { categories, taxGroups, items, modifierGroups };
}

export function searchItems(ctx: Ctx, q: string, limit = 30) {
  const tokens = q.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (!tokens || tokens.length === 0) return [];
  const match = tokens.slice(0, 6).map((t) => `"${t}"*`).join(' ');
  return camelAll(all(ctx.db,
    `SELECT i.id, i.category_id, i.name, i.short_name, i.sku, i.barcode, i.price, i.unit, i.is_veg, i.image_file
       FROM item_fts f JOIN item i ON i.id = f.item_id
      WHERE item_fts MATCH ? AND i.deleted_at IS NULL AND i.active = 1
      ORDER BY rank LIMIT ?`, match, Math.min(Math.max(limit, 1), 100)));
}

export function itemByBarcode(ctx: Ctx, code: string) {
  return camel(get(ctx.db, 'SELECT id, category_id, name, price, unit, barcode FROM item WHERE barcode = ? AND deleted_at IS NULL AND active = 1', code)) ?? null;
}

export function createCategory(ctx: Ctx, actor: Actor, requestId: string, input: { name: string; sortOrder?: number; prepStationId?: string | null }) {
  return runCommand(ctx, requestId, 'category.create', actor, () => {
    assertPerm(actor, 'catalog.write');
    const name = clean(input.name, 'Category name', 60)!.replace(/\s+/g, ' ');
    if (categoriesByKey(ctx).has(categoryKey(name))) throw new AppError('DUPLICATE', 'A category with this name already exists.', 409);
    const id = ctx.ids.next();
    run(ctx.db, 'INSERT INTO category(id, name, sort_order, prep_station_id, updated_at) VALUES (?,?,?,?,?)', id, name, input.sortOrder ?? 0, checkStationId(ctx, input.prepStationId), ctx.clock.now());
    audit(ctx, actor.userId, 'category.create', 'category', id);
    emit(ctx, 'category', id, 'upsert', { id, name });
    return { id };
  });
}

export function updateCategory(ctx: Ctx, actor: Actor, requestId: string, id: string, input: { name?: string; sortOrder?: number; prepStationId?: string | null }) {
  return runCommand(ctx, requestId, 'category.update', actor, () => {
    assertPerm(actor, 'catalog.write');
    const cur = get<{ name: string; sort_order: number; prep_station_id: string | null }>(ctx.db, 'SELECT name, sort_order, prep_station_id FROM category WHERE id = ? AND deleted_at IS NULL', id);
    if (!cur) throw new AppError('NOT_FOUND', 'Category not found.', 404);
    const name = input.name === undefined ? cur.name : clean(input.name, 'Category name', 60)!.replace(/\s+/g, ' ');
    const same = categoriesByKey(ctx).get(categoryKey(name));
    if (same && same.id !== id) throw new AppError('DUPLICATE', 'A category with this name already exists.', 409);
    const station = input.prepStationId === undefined ? cur.prep_station_id : checkStationId(ctx, input.prepStationId);
    run(ctx.db, 'UPDATE category SET name=?, sort_order=?, prep_station_id=?, version=version+1, updated_at=? WHERE id=?', name, input.sortOrder ?? cur.sort_order, station, ctx.clock.now(), id);
    audit(ctx, actor.userId, 'category.update', 'category', id);
    emit(ctx, 'category', id, 'upsert', { id, name });
    return { id };
  });
}

/** Soft delete. Refused while the category still has items, so nothing on the menu loses its category by accident. */
export function deleteCategory(ctx: Ctx, actor: Actor, requestId: string, id: string) {
  return runCommand(ctx, requestId, 'category.delete', actor, () => {
    assertPerm(actor, 'catalog.write');
    const cur = get<{ name: string }>(ctx.db, 'SELECT name FROM category WHERE id = ? AND deleted_at IS NULL', id);
    if (!cur) throw new AppError('NOT_FOUND', 'Category not found.', 404);
    const n = get<{ n: number }>(ctx.db, 'SELECT count(*) n FROM item WHERE category_id = ? AND deleted_at IS NULL', id)!.n;
    if (n > 0) throw new AppError('IN_USE', `${cur.name} still has ${n} item(s). Move or remove them first.`, 409, { items: n });
    run(ctx.db, 'UPDATE category SET deleted_at = ?, version = version + 1, updated_at = ? WHERE id = ?', ctx.clock.now(), ctx.clock.now(), id);
    audit(ctx, actor.userId, 'category.delete', 'category', id, { name: cur.name });
    emit(ctx, 'category', id, 'delete', { id });
    return { id };
  });
}

/** Sets the display order of all categories at once (the list must name every category exactly once). */
export function reorderCategories(ctx: Ctx, actor: Actor, requestId: string, ids: string[]) {
  return runCommand(ctx, requestId, 'category.reorder', actor, () => {
    assertPerm(actor, 'catalog.write');
    const existing = all<{ id: string }>(ctx.db, 'SELECT id FROM category WHERE deleted_at IS NULL').map((r) => r.id);
    if (!Array.isArray(ids) || ids.length !== existing.length || new Set(ids).size !== ids.length || !ids.every((x) => existing.includes(x))) {
      fail('The new order must list every category exactly once. Reload and try again.');
    }
    const now = ctx.clock.now();
    ids.forEach((cid, i) => run(ctx.db, 'UPDATE category SET sort_order = ?, version = version + 1, updated_at = ? WHERE id = ? AND sort_order <> ?', (i + 1) * 10, now, cid, (i + 1) * 10));
    audit(ctx, actor.userId, 'category.reorder', 'category', undefined, { ids });
    emit(ctx, 'category', 'all', 'reorder', { ids });
    return { ids };
  });
}

export function createTaxGroup(ctx: Ctx, actor: Actor, requestId: string, input: { name: string; rateBp: number; cessBp?: number; priceIncludesTax?: boolean }) {
  return runCommand(ctx, requestId, 'taxgroup.create', actor, () => {
    assertPerm(actor, 'catalog.write');
    const name = clean(input.name, 'Tax group name', 40)!;
    if (!Number.isInteger(input.rateBp) || input.rateBp < 0 || input.rateBp > 10000) fail('GST rate must be 0-100% (in basis points).');
    const cess = input.cessBp ?? 0;
    if (!Number.isInteger(cess) || cess < 0 || cess > 10000) fail('Cess must be 0-100% (in basis points).');
    const id = ctx.ids.next();
    run(ctx.db, 'INSERT INTO tax_group(id, name, rate_bp, cess_bp, price_includes_tax, updated_at) VALUES (?,?,?,?,?,?)', id, name, input.rateBp, cess, input.priceIncludesTax === false ? 0 : 1, ctx.clock.now());
    audit(ctx, actor.userId, 'taxgroup.create', 'tax_group', id, { rateBp: input.rateBp });
    emit(ctx, 'tax_group', id, 'upsert', { id, name, rateBp: input.rateBp });
    return { id };
  });
}

export interface ItemInput { name: string; categoryId?: string | null; shortName?: string | null; sku?: string | null; barcode?: string | null; hsnCode?: string | null; taxGroupId: string; price: number; unit?: string; isVeg?: boolean | null; imageFile?: string | null; description?: string | null }

function checkItem(ctx: Ctx, i: ItemInput, selfId: string | null) {
  const name = clean(i.name, 'Item name', 120)!;
  const same = get<{ id: string }>(ctx.db, 'SELECT id FROM item WHERE lower(name) = lower(?) AND deleted_at IS NULL', name);
  if (same && same.id !== selfId) throw new AppError('DUPLICATE', `An item called "${name}" is already on the menu.`, 409);
  if (!Number.isInteger(i.price) || i.price < 0 || i.price > MAX_PRICE) fail('Price must be a whole number of paise between 0 and 1,000,000,000.');
  if (!get(ctx.db, 'SELECT 1 FROM tax_group WHERE id = ? AND deleted_at IS NULL', i.taxGroupId)) fail('Unknown tax group.');
  if (i.categoryId && !get(ctx.db, 'SELECT 1 FROM category WHERE id = ? AND deleted_at IS NULL', i.categoryId)) fail('Unknown category.');
  const hsn = clean(i.hsnCode, 'HSN', 8, false);
  if (hsn && !/^\d{4,8}$/.test(hsn)) fail('HSN must be 4-8 digits.');
  const barcode = clean(i.barcode, 'Barcode', 40, false);
  if (barcode) {
    const dup = get<{ id: string }>(ctx.db, 'SELECT id FROM item WHERE barcode = ? AND deleted_at IS NULL', barcode);
    if (dup && dup.id !== selfId) throw new AppError('DUPLICATE_BARCODE', 'Another item already uses this barcode.', 409);
  }
  const unit = clean(i.unit ?? 'pcs', 'Unit', 10)!;
  const description = typeof i.description === 'string' && i.description.trim() ? i.description.trim().replace(/\s+/g, ' ') : null;
  if (description && description.length > 300) fail('Description can be at most 300 characters.');
  return { description, name, hsn, barcode, unit, shortName: clean(i.shortName, 'Short name', 40, false), sku: clean(i.sku, 'SKU', 40, false) };
}

export function createItem(ctx: Ctx, actor: Actor, requestId: string, input: ItemInput) {
  return runCommand(ctx, requestId, 'item.create', actor, () => {
    assertPerm(actor, 'catalog.write');
    const c = checkItem(ctx, input, null);
    const id = ctx.ids.next();
    run(ctx.db, `INSERT INTO item(id, category_id, name, short_name, sku, barcode, hsn_code, tax_group_id, price, unit, is_veg, image_file, description, updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, input.categoryId ?? null, c.name, c.shortName, c.sku, c.barcode, c.hsn, input.taxGroupId, input.price, c.unit,
      input.isVeg === undefined || input.isVeg === null ? null : input.isVeg ? 1 : 0, input.imageFile ?? null, c.description, ctx.clock.now());
    audit(ctx, actor.userId, 'item.create', 'item', id, { name: c.name, price: input.price });
    emit(ctx, 'item', id, 'upsert', { id, name: c.name, price: input.price });
    return { id };
  });
}

export function updateItem(ctx: Ctx, actor: Actor, requestId: string, id: string, input: Partial<ItemInput>) {
  return runCommand(ctx, requestId, 'item.update', actor, () => {
    assertPerm(actor, 'catalog.write');
    const cur = get<ItemRow>(ctx.db, 'SELECT * FROM item WHERE id = ? AND deleted_at IS NULL', id);
    if (!cur) throw new AppError('NOT_FOUND', 'Item not found.', 404);
    const merged: ItemInput = {
      name: input.name ?? cur.name, categoryId: input.categoryId === undefined ? cur.category_id : input.categoryId,
      shortName: input.shortName === undefined ? cur.short_name : input.shortName, sku: input.sku === undefined ? cur.sku : input.sku,
      barcode: input.barcode === undefined ? cur.barcode : input.barcode, hsnCode: input.hsnCode === undefined ? cur.hsn_code : input.hsnCode,
      taxGroupId: input.taxGroupId ?? cur.tax_group_id, price: input.price ?? cur.price, unit: input.unit ?? cur.unit,
      isVeg: input.isVeg === undefined ? (cur.is_veg === null ? null : cur.is_veg === 1) : input.isVeg,
      imageFile: input.imageFile === undefined ? cur.image_file : input.imageFile,
      description: input.description === undefined ? cur.description : input.description,
    };
    const c = checkItem(ctx, merged, id);
    run(ctx.db, `UPDATE item SET category_id=?, name=?, short_name=?, sku=?, barcode=?, hsn_code=?, tax_group_id=?, price=?, unit=?, is_veg=?, image_file=?, description=?, version=version+1, updated_at=? WHERE id=?`,
      merged.categoryId ?? null, c.name, c.shortName, c.sku, c.barcode, c.hsn, merged.taxGroupId, merged.price, c.unit,
      merged.isVeg === null || merged.isVeg === undefined ? null : merged.isVeg ? 1 : 0, merged.imageFile ?? null, c.description, ctx.clock.now(), id);
    audit(ctx, actor.userId, 'item.update', 'item', id, { price: merged.price });
    emit(ctx, 'item', id, 'upsert', { id, name: c.name, price: merged.price });
    return { id };
  });
}

/** Soft delete. Past invoices keep their own snapshot, so history is unaffected. */
export function deleteItem(ctx: Ctx, actor: Actor, requestId: string, id: string) {
  return runCommand(ctx, requestId, 'item.delete', actor, () => {
    assertPerm(actor, 'catalog.write');
    const r = run(ctx.db, 'UPDATE item SET deleted_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND deleted_at IS NULL', ctx.clock.now(), ctx.clock.now(), id);
    if (Number(r.changes) === 0) throw new AppError('NOT_FOUND', 'Item not found.', 404);
    audit(ctx, actor.userId, 'item.delete', 'item', id);
    emit(ctx, 'item', id, 'delete', { id });
    return { id };
  });
}

export function createModifierGroup(ctx: Ctx, actor: Actor, requestId: string, input: { name: string; minSelect?: number; maxSelect?: number; modifiers: Array<{ name: string; price: number }> }) {
  return runCommand(ctx, requestId, 'modgroup.create', actor, () => {
    assertPerm(actor, 'catalog.write');
    const name = clean(input.name, 'Group name', 60)!;
    const min = input.minSelect ?? 0, max = input.maxSelect ?? 1;
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < 1 || min > max) fail('Invalid min/max selection.');
    if (input.modifiers.length === 0) fail('A modifier group needs at least one option.');
    const id = ctx.ids.next();
    run(ctx.db, 'INSERT INTO modifier_group(id, name, min_select, max_select, updated_at) VALUES (?,?,?,?,?)', id, name, min, max, ctx.clock.now());
    for (const m of input.modifiers) {
      if (!Number.isInteger(m.price) || m.price < 0 || m.price > MAX_PRICE) fail('Modifier price must be a non-negative whole number of paise.');
      run(ctx.db, 'INSERT INTO modifier(id, group_id, name, price) VALUES (?,?,?,?)', ctx.ids.next(), id, clean(m.name, 'Modifier name', 60)!, m.price);
    }
    audit(ctx, actor.userId, 'modgroup.create', 'modifier_group', id);
    emit(ctx, 'modifier_group', id, 'upsert', { id, name });
    return { id };
  });
}

/**
 * Changes a modifier (add-on) group: name, how many to choose, and its options. Options sent with an id are updated,
 * new ones (no id) are added, and options left out are switched off, never deleted: bills and open carts keep their own
 * copy of the name and price, so past bills never change.
 */
export function updateModifierGroup(ctx: Ctx, actor: Actor, requestId: string, groupId: string, input: { name: string; minSelect: number; maxSelect: number; modifiers: Array<{ id?: string; name: string; price: number }> }) {
  return runCommand(ctx, requestId, 'modgroup.update', actor, () => {
    assertPerm(actor, 'catalog.write');
    if (!get(ctx.db, 'SELECT 1 FROM modifier_group WHERE id = ? AND deleted_at IS NULL', groupId)) throw new AppError('NOT_FOUND', 'Add-on group not found.', 404);
    const name = clean(input.name, 'Group name', 60)!;
    const min = input.minSelect, max = input.maxSelect;
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < 1 || min > max) fail('Choose how many: at least 0, at most 1 or more, and "at least" no more than "at most".');
    if (input.modifiers.length === 0) fail('An add-on group needs at least one option.');
    if (min > input.modifiers.length) fail('"At least" is more than the number of options.');
    const names = new Set<string>();
    for (const m of input.modifiers) {
      const n = clean(m.name, 'Option name', 60)!.toLowerCase();
      if (names.has(n)) fail(`The option "${m.name.trim()}" is listed twice.`);
      names.add(n);
      if (!Number.isInteger(m.price) || m.price < 0 || m.price > MAX_PRICE) fail('Option prices must be 0 or more.');
    }
    run(ctx.db, 'UPDATE modifier_group SET name = ?, min_select = ?, max_select = ?, version = version + 1, updated_at = ? WHERE id = ?', name, min, max, ctx.clock.now(), groupId);
    const keep = new Set<string>();
    for (const m of input.modifiers) {
      if (m.id) {
        if (!get(ctx.db, 'SELECT 1 FROM modifier WHERE id = ? AND group_id = ?', m.id, groupId)) fail('An option does not belong to this group. Reload and try again.');
        run(ctx.db, 'UPDATE modifier SET name = ?, price = ?, active = 1 WHERE id = ?', clean(m.name, 'Option name', 60)!, m.price, m.id);
        keep.add(m.id);
      } else {
        const id = ctx.ids.next();
        run(ctx.db, 'INSERT INTO modifier(id, group_id, name, price) VALUES (?,?,?,?)', id, groupId, clean(m.name, 'Option name', 60)!, m.price);
        keep.add(id);
      }
    }
    for (const r of all<{ id: string }>(ctx.db, 'SELECT id FROM modifier WHERE group_id = ? AND active = 1', groupId)) if (!keep.has(r.id)) run(ctx.db, 'UPDATE modifier SET active = 0 WHERE id = ?', r.id);
    audit(ctx, actor.userId, 'modgroup.update', 'modifier_group', groupId, { name, options: input.modifiers.length });
    emit(ctx, 'modifier_group', groupId, 'upsert', { id: groupId, name });
    return { id: groupId };
  });
}

/** Removes a group from the menu and from every item (kept in the database for old carts and bills). */
export function deleteModifierGroup(ctx: Ctx, actor: Actor, requestId: string, groupId: string) {
  return runCommand(ctx, requestId, 'modgroup.delete', actor, () => {
    assertPerm(actor, 'catalog.write');
    const r = run(ctx.db, 'UPDATE modifier_group SET deleted_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND deleted_at IS NULL', ctx.clock.now(), ctx.clock.now(), groupId);
    if (Number(r.changes) === 0) throw new AppError('NOT_FOUND', 'Add-on group not found.', 404);
    run(ctx.db, 'DELETE FROM item_modifier_group WHERE group_id = ?', groupId);
    audit(ctx, actor.userId, 'modgroup.delete', 'modifier_group', groupId);
    emit(ctx, 'modifier_group', groupId, 'delete', { id: groupId });
    return { ok: true };
  });
}

export function setItemModifierGroups(ctx: Ctx, actor: Actor, requestId: string, itemId: string, groupIds: string[]) {
  return runCommand(ctx, requestId, 'item.set_modifier_groups', actor, () => {
    assertPerm(actor, 'catalog.write');
    if (!get(ctx.db, 'SELECT 1 FROM item WHERE id = ? AND deleted_at IS NULL', itemId)) throw new AppError('NOT_FOUND', 'Item not found.', 404);
    run(ctx.db, 'DELETE FROM item_modifier_group WHERE item_id = ?', itemId);
    for (const g of new Set(groupIds)) {
      if (!get(ctx.db, 'SELECT 1 FROM modifier_group WHERE id = ? AND deleted_at IS NULL', g)) fail('Unknown modifier group.');
      run(ctx.db, 'INSERT INTO item_modifier_group(item_id, group_id) VALUES (?,?)', itemId, g);
    }
    audit(ctx, actor.userId, 'item.set_modifier_groups', 'item', itemId, { groupIds });
    return { itemId, groupIds };
  });
}

// ---------- CSV import ----------
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cur = '', q = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (q) {
      if (ch === '"') { if (src[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cur += ch;
  }
  row.push(cur);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

export interface CsvPreview {
  rows: number; errors: Array<{ row: number; message: string }>;
  /** category: the existing category's saved name, or the new one as first written; newCategory: it will be created. */
  items: Array<{ name: string; category: string; newCategory: boolean; price: number; taxPercent: number; hsn: string | null; barcode: string | null; unit: string; isVeg: boolean | null; description: string | null }>;
  /** Categories the import will create, in file order. */
  newCategories: string[];
}

/** Category names compare without capitals or extra spaces: "  hot   DRINKS " is "Hot Drinks". */
const categoryKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();
/** Existing categories by key. */
function categoriesByKey(ctx: Ctx): Map<string, { id: string; name: string }> {
  return new Map(all<{ id: string; name: string }>(ctx.db, 'SELECT id, name FROM category WHERE deleted_at IS NULL ORDER BY sort_order').map((c) => [categoryKey(c.name), c]));
}

const VEG = new Set(['veg', 'v', 'yes', 'y', '1', 'true', 'vegetarian']);
const NON_VEG = new Set(['non-veg', 'nonveg', 'non veg', 'nv', 'no', 'n', '0', 'false', 'non-vegetarian', 'egg']);
/** true = veg, false = non-veg, null = not set, undefined = not understood. */
export function parseVeg(raw: string): boolean | null | undefined {
  const t = raw.trim().toLowerCase();
  if (t === '') return null;
  if (VEG.has(t)) return true;
  if (NON_VEG.has(t)) return false;
  return undefined;
}

/** Columns: name, category, price (rupees), tax_percent, hsn, barcode, unit, veg. Validates every row without writing. */
export function previewItemsCsv(ctx: Ctx, csv: string): CsvPreview {
  const rows = parseCsv(csv);
  const errors: CsvPreview['errors'] = [];
  const items: CsvPreview['items'] = [];
  const newCategories: string[] = [];
  if (rows.length === 0) return { rows: 0, errors: [{ row: 0, message: 'The file is empty.' }], items, newCategories };
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  const col = (n: string) => header.indexOf(n);
  for (const need of ['name', 'price']) if (col(need) < 0) errors.push({ row: 1, message: `Missing required column "${need}".` });
  if (errors.length) return { rows: rows.length - 1, errors, items, newCategories };
  const existing = categoriesByKey(ctx);
  const fresh = new Map<string, string>(); // key -> name as first written in the file
  const seenBarcodes = new Set<string>();
  const seenNames = new Set<string>();
  rows.slice(1).forEach((r, idx) => {
    const n = idx + 2;
    const v = (name: string) => (col(name) >= 0 ? (r[col(name)] ?? '').trim() : '');
    try {
      const name = v('name');
      if (!name) throw new Error('name is empty');
      if (name.length > 120) throw new Error('name is too long');
      const key = name.toLowerCase();
      if (seenNames.has(key)) throw new Error(`"${name}" is repeated in the file`);
      seenNames.add(key);
      if (get(ctx.db, 'SELECT 1 FROM item WHERE lower(name) = ? AND deleted_at IS NULL', key)) throw new Error(`"${name}" is already on the menu (edit it there instead)`);
      const price = parsePaise(v('price'));
      if (price > MAX_PRICE) throw new Error('price is too large');
      const taxRaw = v('tax_percent') || '0';
      const tm = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(taxRaw);
      if (!tm) throw new Error(`tax_percent "${taxRaw}" is invalid (use a number like 5 or 2.5)`);
      const taxPercent = Number(tm[1]) * 100 + Number((tm[2] ?? '').padEnd(2, '0')); // basis points, no floating point
      if (taxPercent > 10000) throw new Error('tax_percent cannot exceed 100');
      const hsn = v('hsn') || null;
      if (hsn && !/^\d{4,8}$/.test(hsn)) throw new Error('hsn must be 4-8 digits');
      const barcode = v('barcode') || null;
      if (barcode) {
        if (seenBarcodes.has(barcode)) throw new Error(`barcode ${barcode} is repeated in the file`);
        seenBarcodes.add(barcode);
        if (get(ctx.db, 'SELECT 1 FROM item WHERE barcode = ? AND deleted_at IS NULL', barcode)) throw new Error(`barcode ${barcode} already exists`);
      }
      const isVeg = parseVeg(v('veg'));
      if (isVeg === undefined) throw new Error(`veg "${v('veg')}" is not understood (use veg, non-veg or leave empty)`);
      const written = v('category').replace(/\s+/g, ' ') || 'General';
      if (written.length > 60) throw new Error('category is too long');
      const ck = categoryKey(written);
      const found = existing.get(ck);
      if (!found && !fresh.has(ck)) { fresh.set(ck, written); newCategories.push(written); }
      const description = v('description').replace(/\s+/g, ' ') || null;
      if (description && description.length > 300) throw new Error('description is too long (300 characters at most)');
      items.push({ name, category: found ? found.name : fresh.get(ck)!, newCategory: !found, price, taxPercent, hsn, barcode, unit: v('unit') || 'pcs', isVeg, description });
    } catch (e) {
      errors.push({ row: n, message: (e as Error).message });
    }
  });
  return { rows: rows.length - 1, errors, items, newCategories };
}

/** All-or-nothing import. Nothing is written if any row has an error. */
export function importItemsCsv(ctx: Ctx, actor: Actor, requestId: string, csv: string) {
  return runCommand(ctx, requestId, 'item.import_csv', actor, () => {
    assertPerm(actor, 'catalog.write');
    const p = previewItemsCsv(ctx, csv);
    if (p.errors.length) throw new AppError('IMPORT_ERRORS', `${p.errors.length} row(s) have errors. Nothing was imported.`, 422, { errors: p.errors.slice(0, 50) });
    // reuse an existing category (any capitals or spacing); create each missing one once
    const cats = new Map([...categoriesByKey(ctx)].map(([k, c]) => [k, c.id]));
    const taxes = new Map<number, string>();
    let categoriesCreated = 0;
    const now = ctx.clock.now();
    for (const it of p.items) {
      const ck = categoryKey(it.category);
      if (!cats.has(ck)) {
        const id = ctx.ids.next();
        run(ctx.db, 'INSERT INTO category(id, name, sort_order, updated_at) VALUES (?,?,(SELECT coalesce(max(sort_order), 0) + 10 FROM category WHERE deleted_at IS NULL),?)', id, it.category, now);
        cats.set(ck, id); categoriesCreated++;
      }
      if (!taxes.has(it.taxPercent)) {
        const ex = get<{ id: string }>(ctx.db, 'SELECT id FROM tax_group WHERE rate_bp = ? AND cess_bp = 0 AND price_includes_tax = 1 AND deleted_at IS NULL', it.taxPercent);
        if (ex) taxes.set(it.taxPercent, ex.id);
        else { const id = ctx.ids.next(); run(ctx.db, 'INSERT INTO tax_group(id, name, rate_bp, updated_at) VALUES (?,?,?,?)', id, `GST ${it.taxPercent / 100}%`, it.taxPercent, now); taxes.set(it.taxPercent, id); }
      }
      const id = ctx.ids.next();
      run(ctx.db, 'INSERT INTO item(id, category_id, name, barcode, hsn_code, tax_group_id, price, unit, is_veg, description, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        id, cats.get(ck)!, it.name, it.barcode, it.hsn, taxes.get(it.taxPercent)!, it.price, it.unit, it.isVeg === null ? null : it.isVeg ? 1 : 0, it.description, now);
      emit(ctx, 'item', id, 'upsert', { id, name: it.name, price: it.price });
    }
    audit(ctx, actor.userId, 'item.import_csv', 'item', undefined, { count: p.items.length });
    return { imported: p.items.length, categoriesCreated };
  });
}
