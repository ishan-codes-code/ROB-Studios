import assert from 'node:assert/strict';
import test from 'node:test';

import { formatClockTime, formatMediaTime } from '../src/lib/format.js';

test('formatClockTime renders wall clocks and honest fallbacks', () => {
  assert.match(formatClockTime(1700000000000), /^\d{2}:\d{2}:\d{2}$/);
  assert.equal(formatClockTime(null), '—');
  assert.equal(formatClockTime(Number.NaN), '—');
  assert.equal(formatClockTime(-1), '—');
  assert.equal(formatClockTime('noon'), '—');
});

test('formatMediaTime renders media clocks and honest fallbacks', () => {
  assert.equal(formatMediaTime(0), '00:00');
  assert.equal(formatMediaTime(5.7), '00:05');
  assert.equal(formatMediaTime(75), '01:15');
  assert.equal(formatMediaTime(3723), '01:02:03');
  assert.equal(formatMediaTime(null), '--:--');
  assert.equal(formatMediaTime(Number.NaN), '--:--');
  assert.equal(formatMediaTime(-1), '--:--');
});
