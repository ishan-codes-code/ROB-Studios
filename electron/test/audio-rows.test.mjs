import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAudioRows, manifestAudioFileName, selectFreshTtsEntries } from '../src/lib/audio-rows.js';

function liveSegment(overrides = {}) {
  return {
    utteranceId: 'u-0001',
    timestamp: 3,
    text: 'The zone starts closing in.',
    priority: 1,
    scriptStatus: 'worded',
    ttsStatus: null,
    ttsError: null,
    ...overrides,
  };
}

test('manifestAudioFileName only passes servable basenames', () => {
  assert.equal(manifestAudioFileName('segments/segment-001.wav'), 'segment-001.wav');
  assert.equal(manifestAudioFileName('segment-001.wav'), 'segment-001.wav');
  assert.equal(manifestAudioFileName(null), '');
  assert.equal(manifestAudioFileName('../tts.json'), '');
  assert.equal(manifestAudioFileName('segments/.hidden.wav'), '');
  assert.equal(manifestAudioFileName(`segments/${'x'.repeat(65)}.wav`), '');
});

test('live rows resolve waiting, generating, ready, failed, and skipped', () => {
  const built = buildAudioRows({
    live: true,
    segments: [
      liveSegment({ utteranceId: 'u-0001' }),
      liveSegment({ utteranceId: 'u-0002', ttsStatus: 'started' }),
      liveSegment({ utteranceId: 'u-0003', ttsStatus: 'success' }),
      liveSegment({ utteranceId: 'u-0004', ttsStatus: 'error', ttsError: 'Synth failed.' }),
      liveSegment({ utteranceId: 'u-0005', scriptStatus: 'superseded' }),
      liveSegment({ utteranceId: 'u-0006', ttsStatus: 'success' }),
    ],
    files: [{ name: 'u-0003.wav', scope: 'audio/segments', sizeBytes: 64 }],
  });
  assert.deepEqual(
    built.rows.map((row) => row.state),
    ['waiting', 'generating', 'ready', 'failed', 'skipped', 'unavailable'],
  );
  assert.equal(built.ready, 1);
  assert.equal(built.total, 6);
  assert.equal(built.rows[2].name, 'u-0003.wav');
  assert.equal(built.rows[2].scope, 'audio/segments');
  assert.equal(built.rows[3].error, 'Synth failed.');
  // Success without a listed file is unavailable, never ready.
  assert.equal(built.rows[5].name, null);
});

test('live rows report no-audio once the run settles without synthesis', () => {
  const built = buildAudioRows({
    live: false,
    segments: [liveSegment({ utteranceId: 'u-0001' })],
    files: [],
  });
  assert.equal(built.rows[0].state, 'no-audio');
});

test('manifest entries are authoritative and join segment files', () => {
  const built = buildAudioRows({
    entries: [
      {
        segment_id: 'segment-001',
        timestamp_seconds: 3,
        text: 'The zone starts closing in.',
        audio_file: 'segments/segment-001.wav',
        status: 'success',
        error: null,
      },
      {
        segment_id: 'segment-002',
        timestamp_seconds: 6,
        text: 'A rotation begins.',
        audio_file: null,
        status: 'error',
        error: 'Voice quota exceeded.',
      },
      {
        segment_id: 'segment-003',
        timestamp_seconds: 9,
        text: 'Holding position.',
        audio_file: null,
        status: 'skipped',
        error: null,
      },
      {
        segment_id: 'segment-004',
        timestamp_seconds: 12,
        text: 'Orphaned line.',
        audio_file: 'segments/segment-004.wav',
        status: 'success',
        error: null,
      },
    ],
    files: [{ name: 'segment-001.wav', scope: 'audio/segments', sizeBytes: 128 }],
  });
  assert.deepEqual(
    built.rows.map((row) => row.state),
    ['ready', 'failed', 'skipped', 'unavailable'],
  );
  assert.equal(built.ready, 1);
  assert.equal(built.total, 4);
  assert.equal(built.failed, 2);
  assert.equal(built.rows[0].timestamp, 3);
});

test('unknown statuses stay visible instead of crashing the join', () => {
  const built = buildAudioRows({
    entries: [{ segment_id: 'segment-9', audio_file: 'x.wav', status: 'queued' }],
    files: [],
  });
  assert.equal(built.rows[0].state, 'unknown');
  assert.equal(built.rows[0].rawStatus, 'queued');
  assert.equal(built.ready, 0);
});

test('manifest entries win over live segments without duplicating rows', () => {
  const entries = [
    {
      segment_id: 'segment-001',
      timestamp_seconds: 3,
      text: 'Final wording.',
      audio_file: 'segments/segment-001.wav',
      status: 'success',
      error: null,
    },
  ];
  const built = buildAudioRows({
    entries,
    segments: [liveSegment({ utteranceId: 'u-0001', ttsStatus: 'success' })],
    files: [
      { name: 'segment-001.wav', scope: 'audio/segments', sizeBytes: 128 },
      { name: 'u-0001.wav', scope: 'audio/segments', sizeBytes: 64 },
    ],
  });
  assert.equal(built.total, 1);
  assert.equal(built.rows[0].key, 'segment-001');
  assert.equal(built.rows[0].state, 'ready');
});

test('selectFreshTtsEntries gates stale manifests by generation', () => {
  const entries = [{ segment_id: 'segment-001', status: 'success' }];
  const doc = { generation_id: 'gen-run-2', entries };
  // No run started this session: hydration accepts what is persisted.
  assert.equal(selectFreshTtsEntries(doc, null), entries);
  assert.equal(selectFreshTtsEntries(doc, undefined), entries);
  // Current run's manifest: fresh.
  assert.equal(selectFreshTtsEntries(doc, 'gen-run-2'), entries);
  // Previous run's manifest: stale, live view instead.
  assert.equal(selectFreshTtsEntries(doc, 'gen-run-3'), null);
  assert.equal(selectFreshTtsEntries({ entries }, 'gen-run-3'), null);
  // Malformed manifests never render.
  assert.equal(selectFreshTtsEntries(null, null), null);
  assert.equal(selectFreshTtsEntries({}, null), null);
  assert.equal(selectFreshTtsEntries({ entries: 'nope' }, null), null);
});

test('selectFreshTtsEntries rejects stale manifests once a run started', () => {
  const entries = [{ segment_id: 'segment-001', status: 'success' }];
  const fresh = { generation_id: 'gen-run-2', entries };
  const stale = { generation_id: 'gen-run-1', entries };
  // A new streaming run with no generation reported yet: every
  // manifest is stale, so the live view renders instead.
  assert.equal(selectFreshTtsEntries(fresh, null, true), null);
  assert.equal(selectFreshTtsEntries(fresh, undefined, true), null);
  // Previous run's manifest once the new run reported: stale.
  assert.equal(selectFreshTtsEntries(stale, 'gen-run-2', true), null);
  // Missing or empty manifest generations never match a live run.
  assert.equal(selectFreshTtsEntries({ entries }, 'gen-run-2', true), null);
  assert.equal(selectFreshTtsEntries({ generation_id: '', entries }, 'gen-run-2', true), null);
  // The current run's manifest: fresh.
  assert.equal(selectFreshTtsEntries(fresh, 'gen-run-2', true), entries);
  // Hydration and pre-run views still accept what is persisted.
  assert.equal(selectFreshTtsEntries(fresh, null, false), entries);
  assert.equal(selectFreshTtsEntries(fresh, null), entries);
  // Malformed manifests never render, run or not.
  assert.equal(selectFreshTtsEntries(null, 'gen-run-2', true), null);
  assert.equal(selectFreshTtsEntries({}, null, true), null);
  assert.equal(selectFreshTtsEntries({ entries: 'nope' }, 'gen-run-2', true), null);
});
