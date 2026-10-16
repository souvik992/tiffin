// India has no DST, so IST is a fixed UTC+05:30 offset.
const IST_OFFSET_MS = 330 * 60 * 1000;

export function istParts(ms: number): { y: number; m: number; d: number } {
  const d = new Date(ms + IST_OFFSET_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

export function istDay(ms: number): string {
  const p = istParts(ms);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** Indian financial year (April to March) in IST, e.g. "26-27". */
export function financialYear(ms: number): string {
  const { y, m } = istParts(ms);
  const start = m >= 4 ? y : y - 1;
  return `${String(start % 100).padStart(2, '0')}-${String((start + 1) % 100).padStart(2, '0')}`;
}

export const MAX_DOC_NO_LENGTH = 16; // GST rule as understood; confirm with your CA.

/** Device prefix is 1-2 alphanumerics; credit notes add a "C" suffix so they still fit in 16 characters. */
export function validDevicePrefix(p: string): boolean {
  return /^[A-Z0-9]{1,2}$/.test(p);
}

export function formatDocNo(prefix: string, fy: string, seq: number): string {
  if (!/^[A-Z0-9]{1,3}$/.test(prefix)) throw new RangeError(`invalid series prefix "${prefix}"`);
  if (!Number.isSafeInteger(seq) || seq < 1 || seq > 999_999) throw new RangeError('sequence out of range (1..999999)');
  const no = `${prefix}/${fy}/${String(seq).padStart(6, '0')}`;
  if (no.length > MAX_DOC_NO_LENGTH) throw new RangeError(`document number "${no}" exceeds ${MAX_DOC_NO_LENGTH} characters`);
  return no;
}

/** IST YYYY-MM-DD HH:mm:ss, for receipts. */
export function istDateTime(ms: number): string {
  const d = new Date(ms + IST_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}
