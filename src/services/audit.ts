import type { DatabaseSync } from 'node:sqlite';
import { all, get, run, sha256 } from '../store/db.ts';
import type { Ctx } from './ctx.ts';

const GENESIS = '0'.repeat(64);

function digest(prev: string, ts: number, userId: string | null, action: string, entity: string | null, entityId: string | null, detail: string | null): string {
  return sha256(`${prev}|${ts}|${userId ?? ''}|${action}|${entity ?? ''}|${entityId ?? ''}|${detail ?? ''}`);
}

/** Append-only, hash-chained audit entry. Call inside the same transaction as the change it describes. */
export function audit(ctx: Ctx, userId: string | null, action: string, entity?: string, entityId?: string, detail?: unknown): void {
  const last = get<{ hash: string }>(ctx.db, 'SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1');
  const prev = last?.hash ?? GENESIS;
  const ts = ctx.clock.now();
  const d = detail === undefined ? null : JSON.stringify(detail);
  run(ctx.db, 'INSERT INTO audit_log(ts, user_id, action, entity, entity_id, detail, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?)',
    ts, userId, action, entity ?? null, entityId ?? null, d, prev, digest(prev, ts, userId, action, entity ?? null, entityId ?? null, d));
}

export function verifyAuditChain(db: DatabaseSync): { ok: boolean; checked: number; brokenAtSeq?: number } {
  const rows = all<{ seq: number; ts: number; user_id: string | null; action: string; entity: string | null; entity_id: string | null; detail: string | null; prev_hash: string; hash: string }>(
    db, 'SELECT * FROM audit_log ORDER BY seq');
  let prev = GENESIS;
  for (const r of rows) {
    if (r.prev_hash !== prev || r.hash !== digest(prev, r.ts, r.user_id, r.action, r.entity, r.entity_id, r.detail)) {
      return { ok: false, checked: rows.length, brokenAtSeq: r.seq };
    }
    prev = r.hash;
  }
  return { ok: true, checked: rows.length };
}

export function listAudit(ctx: Ctx, limit = 100, offset = 0) {
  return all(ctx.db, 'SELECT seq, ts, user_id AS userId, action, entity, entity_id AS entityId, detail FROM audit_log ORDER BY seq DESC LIMIT ? OFFSET ?', limit, offset);
}
