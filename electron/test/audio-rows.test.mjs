import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAudioRows, manifestAudioFileName } from '../src/lib/audio-rows.js';

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
