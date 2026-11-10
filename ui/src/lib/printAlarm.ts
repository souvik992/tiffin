// Which failed print jobs sound the print alarm, and what the alarm says. No browser parts: tested alone.
import type { PrintJob } from './api.ts';

/** Only recent failures ring: a ticket that failed hours ago (before a restart) is in the bell list, not the alarm. */
export const ALARM_WINDOW_MS = 30 * 60_000;

/** Failed jobs that should sound the alarm now: recent, and not dismissed by staff. Oldest first. */
export function alarmJobs(failed: PrintJob[], now: number, dismissed: ReadonlySet<string>): PrintJob[] {
  return failed
    .filter((j) => j.status === 'FAILED' && now - j.createdAt <= ALARM_WINDOW_MS && !dismissed.has(j.id))
    .sort((a, b) => a.createdAt - b.createdAt);
}

const WHAT: Record<string, string> = { KOT: 'Kitchen ticket', RECEIPT: 'Bill', TEST: 'Test page' };

/** "Kitchen ticket (token 3, bill A1/26-27/000004) did not print on Kitchen" */
export function describeJob(j: PrintJob): string {
  const what = WHAT[j.kind] ?? 'Report';
  const refs = [j.tokenNo ? `token ${j.tokenNo}` : null, j.invoiceNo ? `bill ${j.invoiceNo}` : null].filter(Boolean).join(', ');
  return `${what}${refs ? ` (${refs})` : ''} did not print on ${j.printerName}`;
}

/** Ids no longer failed (printed after a retry, or gone) are forgotten, so the same job failing again rings again. */
export function pruneDismissed(dismissed: Set<string>, failed: PrintJob[]): void {
  const ids = new Set(failed.map((j) => j.id));
  for (const id of [...dismissed]) if (!ids.has(id)) dismissed.delete(id);
}
