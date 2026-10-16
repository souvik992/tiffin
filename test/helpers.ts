import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCtx, silentLogger } from '../src/services/ctx.ts';
import type { Actor, Ctx } from '../src/services/ctx.ts';
import { seedDemo } from '../src/seed.ts';
import { all } from '../src/store/db.ts';
import { addLine, createOrder } from '../src/services/orders.ts';
import { finalizeInvoice } from '../src/services/invoices.ts';
import { openShift } from '../src/services/shifts.ts';

export class FakeClock {
  t: number;
  constructor(t = Date.UTC(2026, 9, 12, 4, 30, 0)) { this.t = t; } // 12 Oct 2026, 10:00 IST
  now(): number { return this.t; }
  advance(ms: number): void { this.t += ms; }
}

let counter = 0;
export const rid = (p = 't'): string => `${p}-${String(++counter).padStart(6, '0')}-${Math.random().toString(36).slice(2, 8)}`;

export interface Env {
  ctx: Ctx; clock: FakeClock; dir: string;
  owner: Actor; manager: Actor; cashier: Actor;
  items: Record<string, string>; mods: Record<string, string>; groupId: string;
  cleanup(): void;
}

export function actorsFor(ctx: Ctx) {
  const rows = all<{ id: string; name: string; role: 'owner' | 'manager' | 'cashier' }>(ctx.db, 'SELECT id, name, role FROM app_user');
  const by = (role: string): Actor => { const r = rows.find((x) => x.role === role)!; return { userId: r.id, role: r.role, name: r.name }; };
  return { owner: by('owner'), manager: by('manager'), cashier: by('cashier') };
}

export function makeEnv(o: { clock?: FakeClock; dir?: string; seed?: boolean } = {}): Env {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'pos-test-'));
  const clock = o.clock ?? new FakeClock();
  const ctx = createCtx({ dataDir: dir, clock, logger: silentLogger, scryptCost: 1024 });
  if (o.seed !== false) seedDemo(ctx);
  const items = Object.fromEntries(all<{ id: string; name: string }>(ctx.db, 'SELECT id, name FROM item').map((i) => [i.name, i.id]));
  const mods = Object.fromEntries(all<{ id: string; name: string }>(ctx.db, 'SELECT id, name FROM modifier').map((m) => [m.name, m.id]));
  const groupId = all<{ id: string }>(ctx.db, 'SELECT id FROM modifier_group')[0]?.id ?? '';
  return { ctx, clock, dir, ...actorsFor(ctx), items, mods, groupId, cleanup: () => { try { ctx.db.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); } };
}

export function startShift(env: Env, openingCash = 50000, actor: Actor = env.cashier) {
  return openShift(env.ctx, actor, rid(), { openingCash });
}

export function cartOf(env: Env, lines: Array<[string, number?]>, actor: Actor = env.cashier) {
  let cart = createOrder(env.ctx, actor, rid());
  for (const [name, qty] of lines) cart = addLine(env.ctx, actor, rid(), { orderId: cart.order.id, itemId: env.items[name]!, qtyMilli: qty ?? 1000 });
  return cart;
}

/** Builds a cart and pays it exactly in cash. */
export function quickBill(env: Env, lines: Array<[string, number?]>, mode = 'CASH', actor: Actor = env.cashier) {
  const cart = cartOf(env, lines, actor);
  const res = finalizeInvoice(env.ctx, actor, rid(), { orderId: cart.order.id, payments: [{ mode, amount: cart.totals.grandTotal }] });
  return { cart, ...res };
}
