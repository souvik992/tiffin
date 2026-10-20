import type { Ctx } from './ctx.ts';

/**
 * Add-ons that take payments (for example the payment machines add-on) can say that a bill's payment must not have
 * its mode changed by hand after billing (Orders > Change): the machine decided how it was paid. Each guard returns
 * a plain-language reason, or null when it has nothing against the change.
 */
export type PaymentGuard = (invoiceId: string) => string | null;
const guards = new WeakMap<Ctx, PaymentGuard[]>();

export function addPaymentGuard(ctx: Ctx, g: PaymentGuard): () => void {
  const list = guards.get(ctx) ?? [];
  list.push(g);
  guards.set(ctx, list);
  return () => { const l = guards.get(ctx) ?? []; guards.set(ctx, l.filter((x) => x !== g)); };
}

/** The first reason an add-on gives against changing this bill's payment mode, or null. A failing guard says no. */
export function paymentGuardProblem(ctx: Ctx, invoiceId: string): string | null {
  for (const g of guards.get(ctx) ?? []) {
    try { const r = g(invoiceId); if (r) return r; } catch { return 'An add-on could not check this payment. Try again.'; }
  }
  return null;
}
