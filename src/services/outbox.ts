import { run } from '../store/db.ts';
import type { Ctx } from './ctx.ts';

/** Sync outbox. Written in the same transaction as the change. Nothing reads it until cloud sync is enabled. */
export function emit(ctx: Ctx, entity: string, entityId: string, op: string, payload: unknown): void {
  run(ctx.db, 'INSERT INTO outbox(event_id, entity, entity_id, op, payload, created_at) VALUES (?,?,?,?,?,?)',
    ctx.ids.next(), entity, entityId, op, JSON.stringify(payload), ctx.clock.now());
}
