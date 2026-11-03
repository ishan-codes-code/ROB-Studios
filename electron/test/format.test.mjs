import assert from 'node:assert/strict';
import test from 'node:test';

import { formatMediaTime } from '../src/lib/format.js';

test('formatMediaTime renders media clocks and honest fallbacks', () => {
  assert.equal(formatMediaTime(0), '00:00');
  assert.equal(formatMediaTime(5.7), '00:05');
  assert.equal(formatMediaTime(75), '01:15');
  assert.equal(formatMediaTime(3723), '01:02:03');
  assert.equal(formatMediaTime(null), '--:--');
  assert.equal(formatMediaTime(Number.NaN), '--:--');
  assert.equal(formatMediaTime(-1), '--:--');
});
