import { all, get, AppError } from '../store/db.ts';
import type { DatabaseSync } from 'node:sqlite';

/**
 * "All data": every table of the POS database, read only. Table and column names come from the database's own list
 * (never from the request), so they are the only identifiers ever put into SQL text (RULES.md 6).
 * Secrets never leave: PIN hashes, sign-in tokens, keys and passwords show as "hidden".
 */

export const HIDDEN = '(hidden)';
const SECRET_COLUMN = /pin_hash|token|secret|password|private|api_key|_key$/i;
const SECRET_SETTING = /token|secret|password|private|_key$|pairing/i;

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

export interface TableInfo { name: string; kind: 'table' | 'view'; rows: number }

export function listTables(db: DatabaseSync): TableInfo[] {
  return all<{ name: string; type: 'table' | 'view' }>(db, "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite!_%' ESCAPE '!' ORDER BY name")
    .map((t) => ({ name: t.name, kind: t.type, rows: get<{ n: number }>(db, `SELECT count(*) n FROM ${q(t.name)}`)?.n ?? 0 }));
}

function tableOf(db: DatabaseSync, name: string): TableInfo & { columns: string[] } {
  const t = listTables(db).find((x) => x.name === name);
  if (!t) throw new AppError('NOT_FOUND', 'No such table.', 404);
  const columns = all<{ name: string }>(db, `SELECT name FROM pragma_table_info(?)`, name).map((c) => c.name);
  return { ...t, columns };
}

type Cell = string | number | null;

function present(table: string, columns: string[], row: Record<string, unknown>): Cell[] {
  const settingKey = table === 'settings' ? String(row.key ?? '') : '';
  return columns.map((c) => {
    const v = row[c];
    if (v === null || v === undefined) return null;
    if (SECRET_COLUMN.test(c) && !(table === 'settings' && c === 'key')) return HIDDEN;
    if (settingKey && c === 'value' && SECRET_SETTING.test(settingKey)) return HIDDEN;
    if (v instanceof Uint8Array) return `[${v.length} bytes]`;
    if (typeof v === 'bigint') return v.toString();
    return v as Cell;
  });
}

function select(db: DatabaseSync, t: TableInfo & { columns: string[] }, search: string, limit: number, offset: number) {
  const where = search ? `WHERE ${t.columns.map((c) => `CAST(${q(c)} AS TEXT) LIKE ?`).join(' OR ')}` : '';
  const args = search ? t.columns.map(() => `%${search}%`) : [];
  const count = search ? get<{ n: number }>(db, `SELECT count(*) n FROM ${q(t.name)} ${where}`, ...args)?.n ?? 0 : t.rows;
  // newest first where the table has row ids (views and WITHOUT ROWID tables keep their own order)
  let rows: Record<string, unknown>[];
  try { rows = all(db, `SELECT * FROM ${q(t.name)} ${where} ORDER BY rowid DESC LIMIT ? OFFSET ?`, ...args, limit, offset); }
  catch { rows = all(db, `SELECT * FROM ${q(t.name)} ${where} LIMIT ? OFFSET ?`, ...args, limit, offset); }
  return { count, rows };
}

export function readTable(db: DatabaseSync, name: string, o: { search?: string; limit?: number; offset?: number } = {}) {
  const t = tableOf(db, name);
  const limit = Math.min(Math.max(o.limit ?? 50, 1), 500), offset = Math.max(o.offset ?? 0, 0);
  const search = (o.search ?? '').trim().slice(0, 100);
  const { count, rows } = select(db, t, search, limit, offset);
  return { name: t.name, kind: t.kind, columns: t.columns, total: count, offset, limit, rows: rows.map((r) => present(t.name, t.columns, r)) };
}

const csvCell = (v: Cell): string => {
  if (v === null) return '';
  if (typeof v === 'number') return String(v);
  const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v; // no spreadsheet formulas from data
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const CSV_MAX_ROWS = 200_000;

/** The table (or the rows matching a search) as CSV for Excel: UTF-8 with BOM. Raw stored values (paise, epoch ms). */
export function tableCsv(db: DatabaseSync, name: string, search = ''): { filename: string; csv: string } {
  const t = tableOf(db, name);
  const { rows } = select(db, t, search.trim().slice(0, 100), CSV_MAX_ROWS, 0);
  const lines = [t.columns.map((c) => csvCell(c)).join(',')];
  for (const r of rows) lines.push(present(t.name, t.columns, r).map(csvCell).join(','));
  return { filename: `${t.name}.csv`, csv: '﻿' + lines.join('\r\n') + '\r\n' };
}
