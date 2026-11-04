import { all, get, run, AppError } from '../store/db.ts';
import type { Actor, Ctx } from './ctx.ts';
import { runCommand } from './commands.ts';
import { audit } from './audit.ts';
import { assertPerm } from './permissions.ts';

/**
 * Prep stations (Menu > Prep stations): where in the kitchen an item is made (Tandoor, Chinese, Bar...). A category is
 * mapped to a station, and an item can have its own station, which wins over its category's. Kitchen tickets are split
 * by station (printing/kot.ts); printers list the stations they print (Settings > Printer setup).
 */

export interface StationView {
  id: string; name: string; sortOrder: number;
  categoryIds: string[]; itemIds: string[];
  /** Items made here: their own station, or their category's. */
  itemCount: number;
  printers: Array<{ id: string; name: string }>;
}

export function listStations(ctx: Ctx): StationView[] {
  const stations = all<{ id: string; name: string; sort_order: number }>(ctx.db, 'SELECT id, name, sort_order FROM prep_station WHERE deleted_at IS NULL ORDER BY sort_order, lower(name)');
  const cats = all<{ id: string; prep_station_id: string }>(ctx.db, 'SELECT id, prep_station_id FROM category WHERE deleted_at IS NULL AND prep_station_id IS NOT NULL');
  const items = all<{ id: string; prep_station_id: string }>(ctx.db, 'SELECT id, prep_station_id FROM item WHERE deleted_at IS NULL AND prep_station_id IS NOT NULL');
  const made = all<{ station: string; n: number }>(ctx.db, `SELECT coalesce(i.prep_station_id, c.prep_station_id) AS station, count(*) AS n FROM item i LEFT JOIN category c ON c.id = i.category_id
    WHERE i.deleted_at IS NULL AND i.active = 1 AND ifnull(i.sku, '') NOT LIKE 'SYS-%' GROUP BY station`);
  const printers = all<{ id: string; name: string; stations: string }>(ctx.db, 'SELECT id, name, stations FROM printer WHERE active = 1');
  return stations.map((s) => ({
    id: s.id, name: s.name, sortOrder: s.sort_order,
    categoryIds: cats.filter((c) => c.prep_station_id === s.id).map((c) => c.id),
    itemIds: items.filter((i) => i.prep_station_id === s.id).map((i) => i.id),
    itemCount: made.find((m) => m.station === s.id)?.n ?? 0,
    printers: printers.filter((p) => { const l = JSON.parse(p.stations) as string[]; return l.includes(s.id) || l.includes('*'); }).map((p) => ({ id: p.id, name: p.name })),
  }));
}

function cleanName(ctx: Ctx, name: unknown, exceptId: string | null): string {
  const n = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
  if (!n || n.length > 30) throw new AppError('VALIDATION', 'Give the prep station a name of up to 30 characters.');
  if (get(ctx.db, 'SELECT 1 FROM prep_station WHERE lower(name) = lower(?) AND deleted_at IS NULL AND id <> ?', n, exceptId ?? '')) throw new AppError('DUPLICATE', `There is already a prep station called "${n}".`, 409);
  return n;
}

export function createStation(ctx: Ctx, actor: Actor, requestId: string, input: { name: string }) {
  return runCommand(ctx, requestId, 'station.create', actor, () => {
    assertPerm(actor, 'catalog.write');
    const name = cleanName(ctx, input.name, null);
    const id = ctx.ids.next(), now = ctx.clock.now();
    const sort = (get<{ m: number | null }>(ctx.db, 'SELECT max(sort_order) m FROM prep_station WHERE deleted_at IS NULL')?.m ?? 0) + 1;
    run(ctx.db, 'INSERT INTO prep_station (id, name, sort_order, created_at, updated_at) VALUES (?,?,?,?,?)', id, name, sort, now, now);
    audit(ctx, actor.userId, 'station.create', 'prep_station', id, { name });
    return { id };
  });
}

/** Renames a station and sets what is made there: its categories, and items with their own station. */
export function updateStation(ctx: Ctx, actor: Actor, requestId: string, id: string, input: { name?: string; categoryIds?: string[]; itemIds?: string[] }) {
  return runCommand(ctx, requestId, 'station.update', actor, () => {
    assertPerm(actor, 'catalog.write');
    if (!get(ctx.db, 'SELECT 1 FROM prep_station WHERE id = ? AND deleted_at IS NULL', id)) throw new AppError('NOT_FOUND', 'Prep station not found.', 404);
    const now = ctx.clock.now();
    if (input.name !== undefined) run(ctx.db, 'UPDATE prep_station SET name = ?, updated_at = ? WHERE id = ?', cleanName(ctx, input.name, id), now, id);
    const check = (table: 'category' | 'item', ids: unknown) => {
      if (!Array.isArray(ids) || ids.length > 5000 || ids.some((x) => typeof x !== 'string')) throw new AppError('VALIDATION', `Invalid ${table} list.`);
      for (const x of ids as string[]) if (!get(ctx.db, `SELECT 1 FROM ${table} WHERE id = ? AND deleted_at IS NULL`, x)) throw new AppError('VALIDATION', `Unknown ${table === 'category' ? 'category' : 'item'} in the list.`);
      return [...new Set(ids as string[])];
    };
    if (input.categoryIds !== undefined) {
      const ids = check('category', input.categoryIds);
      run(ctx.db, 'UPDATE category SET prep_station_id = NULL, version = version + 1, updated_at = ? WHERE prep_station_id = ?', now, id);
      for (const c of ids) run(ctx.db, 'UPDATE category SET prep_station_id = ?, version = version + 1, updated_at = ? WHERE id = ?', id, now, c);
    }
    if (input.itemIds !== undefined) {
      const ids = check('item', input.itemIds);
      run(ctx.db, 'UPDATE item SET prep_station_id = NULL, version = version + 1, updated_at = ? WHERE prep_station_id = ?', now, id);
      for (const i of ids) run(ctx.db, 'UPDATE item SET prep_station_id = ?, version = version + 1, updated_at = ? WHERE id = ?', id, now, i);
    }
    audit(ctx, actor.userId, 'station.update', 'prep_station', id, { name: input.name, categories: input.categoryIds?.length, items: input.itemIds?.length });
    return { id };
  });
}

/** Removes a station: its categories and items have none afterwards, and printers stop listing it. */
export function deleteStation(ctx: Ctx, actor: Actor, requestId: string, id: string) {
  return runCommand(ctx, requestId, 'station.delete', actor, () => {
    assertPerm(actor, 'catalog.write');
    const s = get<{ name: string }>(ctx.db, 'SELECT name FROM prep_station WHERE id = ? AND deleted_at IS NULL', id);
    if (!s) throw new AppError('NOT_FOUND', 'Prep station not found.', 404);
    const now = ctx.clock.now();
    run(ctx.db, 'UPDATE category SET prep_station_id = NULL, version = version + 1, updated_at = ? WHERE prep_station_id = ?', now, id);
    run(ctx.db, 'UPDATE item SET prep_station_id = NULL, version = version + 1, updated_at = ? WHERE prep_station_id = ?', now, id);
    for (const p of all<{ id: string; stations: string }>(ctx.db, 'SELECT id, stations FROM printer')) {
      const l = JSON.parse(p.stations) as string[];
      if (l.includes(id)) run(ctx.db, 'UPDATE printer SET stations = ? WHERE id = ?', JSON.stringify(l.filter((x) => x !== id)), p.id);
    }
    run(ctx.db, 'UPDATE prep_station SET deleted_at = ?, updated_at = ? WHERE id = ?', now, now, id);
    audit(ctx, actor.userId, 'station.delete', 'prep_station', id, { name: s.name });
    return { id };
  });
}

/** A station id for a category or item (null clears it); refuses unknown ids. */
export function checkStationId(ctx: Ctx, id: unknown): string | null {
  if (id === null || id === undefined || id === '') return null;
  if (typeof id !== 'string' || !get(ctx.db, 'SELECT 1 FROM prep_station WHERE id = ? AND deleted_at IS NULL', id)) throw new AppError('VALIDATION', 'Choose a prep station from the list.');
  return id;
}
