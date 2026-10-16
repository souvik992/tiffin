import { get, run, tx, AppError } from '../store/db.ts';
import type { Actor, Ctx } from './ctx.ts';

export interface Helpers { after(cb: () => void): void }

const REQUEST_ID = /^[A-Za-z0-9_.:-]{8,128}$/;

/**
 * Idempotent command wrapper. One SQLite transaction per command (BEGIN IMMEDIATE).
 * Repeating a requestId returns the original result and performs no work.
 * `after` callbacks run only once, after a successful commit (journal append, events).
 */
export interface CommandOptions<T> {
  /** Store a small reference instead of the full result (keeps command_log small for big carts). */
  compact?: (result: T) => unknown;
  /** Rebuild the result from the stored reference when a request is replayed. */
  expand?: (stored: unknown) => T;
}

export function runCommand<T>(ctx: Ctx, requestId: string, name: string, actor: Actor | null, fn: (h: Helpers) => T, opts: CommandOptions<T> = {}): T {
  if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) {
    throw new AppError('BAD_REQUEST_ID', 'requestId must be 8-128 characters: letters, digits, _ . : -', 400);
  }
  const afters: Array<() => void> = [];
  let replayed = false;
  let result: T;
  try {
    result = tx(ctx.db, () => {
      const prev = get<{ command: string; result_json: string }>(ctx.db, 'SELECT command, result_json FROM command_log WHERE request_id = ?', requestId);
      if (prev) {
        if (prev.command !== name) throw new AppError('REQUEST_ID_REUSED', `requestId was already used for "${prev.command}"`, 409);
        replayed = true;
        const stored = JSON.parse(prev.result_json) as unknown;
        return (opts.expand ? opts.expand(stored) : stored) as T;
      }
      const out = fn({ after: (cb) => afters.push(cb) });
      run(ctx.db, 'INSERT INTO command_log(request_id, command, actor_id, result_json, created_at) VALUES (?,?,?,?,?)',
        requestId, name, actor?.userId ?? null, JSON.stringify(opts.compact ? opts.compact(out) : out === undefined ? null : out), ctx.clock.now());
      return out;
    });
  } catch (e) {
    if (e instanceof AppError && e.afterRollback) {
      try { e.afterRollback(); } catch (err) { ctx.logger.error('afterRollback failed', String(err)); }
    }
    throw e;
  }
  if (!replayed) {
    for (const cb of afters) {
      try { cb(); } catch (err) { ctx.logger.error(`post-commit step failed for ${name}`, String(err)); }
    }
  }
  return result;
}

/** command_log rows older than the cutoff can be pruned (replay window). */
export function pruneCommandLog(ctx: Ctx, olderThanMs: number): number {
  const before = get<{ n: number }>(ctx.db, 'SELECT count(*) n FROM command_log')!.n;
  run(ctx.db, 'DELETE FROM command_log WHERE created_at < ?', olderThanMs);
  return before - get<{ n: number }>(ctx.db, 'SELECT count(*) n FROM command_log')!.n;
}
