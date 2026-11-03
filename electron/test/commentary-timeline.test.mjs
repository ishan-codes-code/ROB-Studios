import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildIntervals,
  findLateKeys,
  planPlayback,
  samePlaybackWindow,
} from '../src/lib/commentary-timeline.js';

function readyRow(overrides = {}) {
  return {
    key: 'u-0001',
    title: 'u-0001',
    timestamp: 3,
    text: 'The zone starts closing in.',
    state: 'ready',
    error: null,
    scope: 'audio/segments',
    name: 'u-0001.wav',
    ...overrides,
  };
}

test('buildIntervals keeps ready rows with durations, sorted by start then key', () => {
  const intervals = buildIntervals(
    [
      readyRow({ key: 'b', timestamp: 6 }),
      readyRow({ key: 'a', timestamp: 3 }),
      readyRow({ key: 'c', timestamp: 3 }),
    ],
    new Map([
      ['a', 2],
      ['b', 2],
      ['c', 2],
    ]),
  );
  assert.deepEqual(
    intervals.map((item) => item.key),
    ['a', 'c', 'b'],
  );
  assert.equal(intervals[0].start, 3);
  assert.equal(intervals[0].end, 5);
  assert.equal(intervals[0].scope, 'audio/segments');
});

test('buildIntervals excludes anything that cannot sound', () => {
  const intervals = buildIntervals(
    [
      readyRow({ key: 'ok', timestamp: 3 }),
      readyRow({ key: 'failed', state: 'failed' }),
      readyRow({ key: 'skipped', state: 'skipped' }),
      readyRow({ key: 'waiting', state: 'waiting' }),
      readyRow({ key: 'generating', state: 'generating' }),
      readyRow({ key: 'no-duration', timestamp: 9 }),
      readyRow({ key: 'bad-duration', timestamp: 12 }),
      readyRow({ key: 'no-file', timestamp: 15, scope: null }),
      readyRow({ key: 'no-time', timestamp: null }),
    ],
    { ok: 2, 'bad-duration': 0 },
  );
  assert.deepEqual(
    intervals.map((item) => item.key),
    ['ok'],
  );
});

test('planPlayback sounds the containing interval with offset, gaps stay silent', () => {
  const intervals = buildIntervals(
    [readyRow({ key: 'a', timestamp: 3 }), readyRow({ key: 'b', timestamp: 10 })],
    { a: 2, b: 2 },
  );
  const hit = planPlayback({ intervals, now: 4 });
  assert.deepEqual(hit.audible, { key: 'a', start: 3, end: 5, offset: 1 });
  assert.equal(hit.stopActive, false);
  const gap = planPlayback({ intervals, now: 7 });
  assert.equal(gap.audible, null);
  assert.equal(gap.stopActive, false);
  // Fully-past intervals join the missed set; future ones never do.
  assert.deepEqual(gap.skipKeys, ['a']);
});

test('planPlayback resolves overlaps deterministically: earliest wins', () => {
  const intervals = buildIntervals(
    [readyRow({ key: 'a', timestamp: 3 }), readyRow({ key: 'b', timestamp: 4 })],
    { a: 4, b: 4 },
  );
  const plan = planPlayback({ intervals, now: 4.5 });
  assert.equal(plan.audible.key, 'a');
  assert.deepEqual(plan.skipKeys, ['b']);
});

test('planPlayback honors missed keys and stale active windows', () => {
  const intervals = buildIntervals([readyRow({ key: 'a', timestamp: 3 })], { a: 2 });
  const missed = planPlayback({ intervals, now: 4, missedKeys: ['a'] });
  assert.equal(missed.audible, null);
  const stale = planPlayback({
    intervals,
    now: 9,
    activeWindow: { start: 3, end: 5 },
  });
  assert.equal(stale.audible, null);
  assert.equal(stale.stopActive, true);
  assert.deepEqual(stale.skipKeys, ['a']);
});

test('planPlayback keeps sounding audio across renames by time, not key', () => {
  const intervals = buildIntervals(
    [readyRow({ key: 'segment-001', title: 'segment-001', timestamp: 3 })],
    { 'segment-001': 2 },
  );
  const plan = planPlayback({
    intervals,
    now: 4,
    activeWindow: { start: 3, end: 5 },
  });
  assert.equal(plan.stopActive, false);
  assert.equal(plan.audible.key, 'segment-001');
  assert.equal(plan.audible.offset, 1);
  assert.deepEqual(plan.skipKeys, []);
});

test('planPlayback accepts missed keys as a Set or an array', () => {
  const intervals = buildIntervals([readyRow({ key: 'a', timestamp: 3 })], { a: 2 });
  assert.equal(planPlayback({ intervals, now: 4, missedKeys: new Set(['a']) }).audible, null);
  assert.equal(planPlayback({ intervals, now: 4, missedKeys: ['a'] }).audible, null);
  assert.equal(planPlayback({ intervals, now: 4, missedKeys: new Set() }).audible.key, 'a');
});

test('planPlayback clamps unusable video times to zero', () => {
  const intervals = buildIntervals([readyRow({ key: 'a', timestamp: 0 })], { a: 2 });
  for (const now of [Number.NaN, -3, null, undefined]) {
    const plan = planPlayback({ intervals, now });
    assert.equal(plan.audible.key, 'a', `now=${String(now)}`);
  }
});

test('samePlaybackWindow matches renames within a millisecond', () => {
  assert.equal(samePlaybackWindow({ start: 3, end: 5 }, { start: 3, end: 5 }), true);
  assert.equal(samePlaybackWindow({ start: 3, end: 5 }, { start: 3.0005, end: 5 }), true);
  assert.equal(samePlaybackWindow({ start: 3, end: 5 }, { start: 3.5, end: 5 }), false);
  assert.equal(samePlaybackWindow({ start: 3, end: 5 }, null), false);
  assert.equal(samePlaybackWindow(null, { start: 3, end: 5 }), false);
});

test('findLateKeys reports only newly arrived starts behind now', () => {
  const intervals = buildIntervals(
    [
      readyRow({ key: 'a', timestamp: 3 }),
      readyRow({ key: 'b', timestamp: 10 }),
      readyRow({ key: 'c', timestamp: 12 }),
    ],
    { a: 2, b: 2, c: 2 },
  );
  const prevAB = intervals.filter((item) => item.key !== 'c');
  assert.deepEqual(findLateKeys(prevAB, intervals, 13), ['c']);
  assert.deepEqual(findLateKeys([], intervals, 10), ['a']);
  // Start exactly at now is still eligible, never late.
  assert.deepEqual(findLateKeys([], intervals, 3), []);
  assert.deepEqual(findLateKeys(intervals, intervals, 99), []);
});

test('findLateKeys treats renames as continuity, not lateness', () => {
  const before = buildIntervals([readyRow({ key: 'u-0001', timestamp: 3 })], { 'u-0001': 2 });
  const after = buildIntervals(
    [readyRow({ key: 'segment-001', title: 'segment-001', timestamp: 3 })],
    { 'segment-001': 2 },
  );
  assert.deepEqual(findLateKeys(before, after, 4), []);
});
