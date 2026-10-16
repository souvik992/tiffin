import { all, get, run } from '../store/db.ts';
import type { Ctx } from './ctx.ts';

const DEFAULTS: Record<string, string> = {
  round_to_rupee: '1',
  cashier_discount_limit_bp: '1000', // 10%: above this a cashier needs manager approval
  require_shift: '1',
  idle_lock_seconds: '300',
  max_lines: '1000',
  receipt_footer: 'Thank you! Visit again.',
  upi_id: '',
  min_free_disk_mb: '100',
};

export interface Settings {
  roundToRupee: boolean;
  cashierDiscountLimitBp: number;
  requireShift: boolean;
  idleLockSeconds: number;
  maxLines: number;
  receiptFooter: string;
  upiId: string;
  minFreeDiskMb: number;
}

export function getSetting(ctx: Ctx, key: string): string {
  return get<{ value: string }>(ctx.db, 'SELECT value FROM settings WHERE key = ?', key)?.value ?? DEFAULTS[key] ?? '';
}
export function setSetting(ctx: Ctx, key: string, value: string): void {
  run(ctx.db, 'INSERT INTO settings(key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', key, value, ctx.clock.now());
}
export function loadSettings(ctx: Ctx): Settings {
  const v = (k: string) => getSetting(ctx, k);
  return {
    roundToRupee: v('round_to_rupee') === '1',
    cashierDiscountLimitBp: Number(v('cashier_discount_limit_bp')),
    requireShift: v('require_shift') === '1',
    idleLockSeconds: Number(v('idle_lock_seconds')),
    maxLines: Number(v('max_lines')),
    receiptFooter: v('receipt_footer'),
    upiId: v('upi_id'),
    minFreeDiskMb: Number(v('min_free_disk_mb')),
  };
}
export function allSettings(ctx: Ctx): Record<string, string> {
  const out = { ...DEFAULTS };
  // the receipt design has its own endpoints; settings named "..._key" (order hub device key, Google Maps key) are
  // secrets and never leave the backend
  for (const r of all<{ key: string; value: string }>(ctx.db, "SELECT key, value FROM settings WHERE key NOT LIKE 'receipt_template%' AND key NOT LIKE '%!_key' ESCAPE '!'")) out[r.key] = r.value;
  return out;
}
export const SETTING_KEYS = Object.keys(DEFAULTS);
