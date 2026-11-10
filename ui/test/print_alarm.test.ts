import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALARM_WINDOW_MS, alarmJobs, describeJob, pruneDismissed } from '../src/lib/printAlarm.ts';
import type { PrintJob } from '../src/lib/api.ts';

const job = (id: string, createdAt: number, o: Partial<PrintJob> = {}): PrintJob => ({
  id, kind: 'KOT', refId: 'inv', printerId: 'p1', printerName: 'Kitchen', invoiceNo: 'A1/26-27/000004', tokenNo: 3, status: 'FAILED',
  attempts: 4, lastError: 'connect ECONNREFUSED', createdAt, ...o,
});

test('print alarm: recent failed jobs ring, oldest first; old, dismissed or not-failed ones do not', () => {
  const now = 10 * ALARM_WINDOW_MS;
  const jobs = [
    job('b', now - 1000),
    job('a', now - 60_000),
    job('old', now - ALARM_WINDOW_MS - 1), // failed before the window (e.g. before a restart): bell list only
    job('gone', now - 500, { status: 'PENDING' }), // being retried
    job('d', now - 2000),
  ];
  assert.deepEqual(alarmJobs(jobs, now, new Set(['d'])).map((j) => j.id), ['a', 'b']);
  assert.deepEqual(alarmJobs([], now, new Set()), []);
});

test('print alarm: says what did not print, where, with the token and bill number', () => {
  assert.equal(describeJob(job('1', 0)), 'Kitchen ticket (token 3, bill A1/26-27/000004) did not print on Kitchen');
  assert.equal(describeJob(job('2', 0, { kind: 'RECEIPT', tokenNo: null, printerName: 'Counter' })), 'Bill (bill A1/26-27/000004) did not print on Counter');
  assert.equal(describeJob(job('3', 0, { kind: 'REPORT', tokenNo: null, invoiceNo: null })), 'Report did not print on Kitchen');
});

test('print alarm: a dismissed job that printed after a retry is forgotten, so failing again rings again', () => {
  const dismissed = new Set(['x', 'y']);
  pruneDismissed(dismissed, [job('y', 0)]);
  assert.deepEqual([...dismissed], ['y']);
});
