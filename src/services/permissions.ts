import { AppError } from '../store/db.ts';
import type { Actor, Role } from './ctx.ts';

const CASHIER = ['catalog.read', 'catalog.availability', 'order.write', 'invoice.finalize', 'invoice.read', 'shift.use', 'shift.report', 'print.read', 'stock.read'] as const;
const MANAGER = [...CASHIER, 'discount.over_limit', 'invoice.cancel', 'creditnote.create', 'invoice.reprint', 'catalog.write',
  'report.read', 'printer.manage', 'shift.force_close', 'stock.write', 'drawer.open', 'payment.correct'] as const;
const OWNER = [...MANAGER, 'settings.write', 'user.manage', 'audit.read', 'backup.run', 'health.read'] as const;

const MATRIX: Record<Role, ReadonlySet<string>> = {
  cashier: new Set(CASHIER),
  manager: new Set(MANAGER),
  owner: new Set(OWNER),
};

export type Permission = (typeof OWNER)[number];

export function can(role: Role, perm: Permission): boolean {
  return MATRIX[role].has(perm);
}
export function assertPerm(actor: Actor, perm: Permission): void {
  if (!can(actor.role, perm)) throw new AppError('FORBIDDEN', `Your role (${actor.role}) is not allowed to do this (${perm}).`, 403, { permission: perm });
}
