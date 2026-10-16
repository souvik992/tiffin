// Report date ranges as IST calendar days (YYYY-MM-DD), the same days the backend groups bills by.

const IST = 330 * 60_000;
const DAY = 86_400_000;

export type Preset = 'today' | 'yesterday' | 'last7' | 'thisMonth' | 'lastMonth';
export const PRESETS: Array<{ key: Preset; label: string }> = [
  { key: 'today', label: 'Today' }, { key: 'yesterday', label: 'Yesterday' }, { key: 'last7', label: 'Last 7 days' },
  { key: 'thisMonth', label: 'This month' }, { key: 'lastMonth', label: 'Last month' },
];

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Today in India as YYYY-MM-DD. */
export const istToday = (now = Date.now()): string => iso(now + IST);

export function presetRange(p: Preset, now = Date.now()): { from: string; to: string } {
  const today = istToday(now);
  const t = Date.parse(`${today}T00:00:00Z`);
  const [y, m] = today.split('-').map(Number) as [number, number];
  switch (p) {
    case 'today': return { from: today, to: today };
    case 'yesterday': return { from: iso(t - DAY), to: iso(t - DAY) };
    case 'last7': return { from: iso(t - 6 * DAY), to: today };
    case 'thisMonth': return { from: iso(Date.UTC(y, m - 1, 1)), to: today };
    case 'lastMonth': return { from: iso(Date.UTC(y, m - 2, 1)), to: iso(Date.UTC(y, m - 1, 0)) };
  }
}

/** "2026-10-12" -> "12 Oct 2026". */
export function formatDay(d: string): string {
  return new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' });
}

/** A moment as IST date and time: "12 Oct 2026, 10:05 am". */
export function formatIstDateTime(ms: number): string {
  return new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
