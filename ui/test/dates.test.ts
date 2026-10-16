import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDay, istToday, presetRange } from '../src/lib/dates.ts';

test('report date presets use the Indian calendar day', () => {
  // 2026-03-01 00:30 IST is still 2026-02-28 in UTC
  const now = Date.parse('2026-02-28T19:00:00Z');
  assert.equal(istToday(now), '2026-03-01');
  assert.deepEqual(presetRange('today', now), { from: '2026-03-01', to: '2026-03-01' });
  assert.deepEqual(presetRange('yesterday', now), { from: '2026-02-28', to: '2026-02-28' });
  assert.deepEqual(presetRange('last7', now), { from: '2026-02-23', to: '2026-03-01' });
  assert.deepEqual(presetRange('thisMonth', now), { from: '2026-03-01', to: '2026-03-01' });
  assert.deepEqual(presetRange('lastMonth', now), { from: '2026-02-01', to: '2026-02-28' });
  // January: last month is December of the year before
  assert.deepEqual(presetRange('lastMonth', Date.parse('2026-01-15T06:00:00Z')), { from: '2025-12-01', to: '2025-12-31' });
  assert.equal(formatDay('2026-10-12'), '12 Oct 2026');
});
