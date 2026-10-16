// Display and input parsing only. The UI never calculates money (RULES.md rule 2):
// totals, tax, discounts, round-off and change all come from the backend.

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const inrWhole = new Intl.NumberFormat('en-IN');

function assertPaise(p: number): void {
  if (!Number.isSafeInteger(p)) throw new RangeError('paise must be a whole number');
}

/** 23200 -> "₹232.00". */
export function formatPaise(p: number): string {
  assertPaise(p);
  return inr.format(p / 100);
}

/** Menu tiles: whole rupees without decimals ("₹129"), otherwise two decimals. */
export function formatPrice(p: number): string {
  assertPaise(p);
  if (p % 100 === 0) return `${p < 0 ? '-' : ''}₹${inrWhole.format(Math.abs(p) / 100)}`;
  return formatPaise(p);
}

/**
 * Parses what a cashier types as rupees into integer paise using string digits only (no floats).
 * Accepts "129", "129.5", "129.50", "1,299.00". Returns null for anything else.
 */
export function parseRupees(input: string): number | null {
  const t = input.trim().replace(/,/g, '');
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

/** Paise to the text a cashier would type: 12900 -> "129", 4950 -> "49.50". Inverse of parseRupees. */
export function paiseToInput(p: number): string {
  assertPaise(p);
  const r = String(Math.trunc(p / 100)), ps = p % 100;
  return ps === 0 ? r : `${r}.${String(ps).padStart(2, '0')}`;
}

/** "10" -> 1000 basis points, "12.5" -> 1250. Range 0-100%. Returns null otherwise. */
export function parsePercentBp(input: string): number | null {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!m) return null;
  const bp = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return bp <= 10000 ? bp : null;
}

/** 500 -> "5%", 250 -> "2.5%". */
export function formatRateBp(bp: number): string {
  const whole = Math.trunc(bp / 100), frac = bp % 100;
  return frac === 0 ? `${whole}%` : `${whole}.${String(frac).padStart(2, '0').replace(/0$/, '')}%`;
}

/** Typed quantity ("1.5", "250", "0.125") -> integer thousandths, using string digits only. Null if invalid. */
export function parseQty(input: string): number | null {
  const m = /^(\d{1,9})(?:\.(\d{1,3}))?$/.exec(input.trim());
  if (!m) return null;
  return Number(m[1]) * 1000 + Number((m[2] ?? '').padEnd(3, '0'));
}

const UNIT_LABEL: Record<string, string> = { kg: 'kg', g: 'g', l: 'L', ml: 'ml', pcs: 'pcs' };
export const unitLabel = (u: string): string => UNIT_LABEL[u] ?? u;
/** 4600 kg -> "4.6 kg"; negative balances keep their sign. */
export function formatStockQty(milli: number, unit: string): string {
  return `${milli < 0 ? '-' : ''}${formatQty(Math.abs(milli))} ${unitLabel(unit)}`;
}

/** Quantity in thousandths -> "2" or "1.5". */
export function formatQty(milli: number): string {
  const whole = Math.trunc(milli / 1000), frac = milli % 1000;
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(3, '0').replace(/0+$/, '')}`;
}
