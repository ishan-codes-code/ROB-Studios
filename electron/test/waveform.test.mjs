import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computePeaks,
  getSharedAudioContext,
  loadAudioBuffer,
  peekCachedBuffer,
  peaksToPath,
  releaseProjectAudio,
  releaseSharedAudioContext,
  WAVEFORM_PEAK_COUNT,
} from '../src/lib/waveform.js';

function sineChannel(length, cycles) {
  const channel = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    channel[i] = Math.sin((2 * Math.PI * cycles * i) / length);
  }
  return channel;
}

test('computePeaks reflects the signal, normalized to its own max', () => {
  const peaks = computePeaks([sineChannel(4800, 5)], 48);
  assert.equal(peaks.length, 48);
  assert.ok(peaks.every((peak) => peak >= 0 && peak <= 1));
  assert.ok(Math.max(...peaks) > 0.99);
  assert.ok(Math.min(...peaks) < 0.6);
});

test('computePeaks takes the max across channels and honors silence', () => {
  const loud = new Float32Array([0.1, 0.1, 0.9, 0.1]);
  const quiet = new Float32Array([0.2, 0.2, 0.2, 0.2]);
  const mixed = computePeaks([loud, quiet], 2);
  assert.equal(mixed.length, 2);
  assert.equal(mixed[1], 1);
  assert.ok(mixed[0] > 0.2 && mixed[0] < 0.3);
  const silent = new Float32Array(100);
  assert.deepEqual(computePeaks([silent], 8), [0, 0, 0, 0, 0, 0, 0, 0]);
});

test('computePeaks degrades gracefully on invalid input', () => {
  assert.equal(computePeaks([], 4).length, 4);
  assert.deepEqual(computePeaks(null, 4), [0, 0, 0, 0]);
  assert.deepEqual(computePeaks([new Float32Array(0)], 4), [0, 0, 0, 0]);
  assert.equal(computePeaks([sineChannel(100, 2)], 0).length, WAVEFORM_PEAK_COUNT);
  assert.equal(computePeaks([sineChannel(100, 2)], -3).length, WAVEFORM_PEAK_COUNT);
});

test('peaksToPath draws one bar per peak and nothing for empty input', () => {
  const path = peaksToPath([0, 0.5, 1]);
  assert.equal(path.split('M').length - 1, 3);
  assert.ok(path.startsWith('M'));
  assert.equal(peaksToPath([]), '');
  assert.equal(peaksToPath(null), '');
  // Non-finite peaks clamp instead of poisoning the path.
  const dirty = peaksToPath([Number.NaN, Infinity, -1]);
  assert.ok(!dirty.includes('NaN') && !dirty.includes('Infinity'));
});

test('shared AudioContext is a lazy singleton until released', async () => {
  await releaseSharedAudioContext();
  let created = 0;
  let closed = 0;
  const factory = () => {
    created += 1;
    return { close: async () => { closed += 1; } };
  };
  const first = getSharedAudioContext(factory);
  const second = getSharedAudioContext(factory);
  assert.equal(first, second);
  assert.equal(created, 1);
  await releaseSharedAudioContext();
  assert.equal(closed, 1);
  getSharedAudioContext(factory);
  assert.equal(created, 2);
  await releaseSharedAudioContext();
});

test('loadAudioBuffer decodes once and shares concurrent callers', async () => {
  releaseProjectAudio('proj-cache');
  let fetches = 0;
  let decodes = 0;
  const fakeBuffer = { duration: 2.5 };
  const args = {
    projectId: 'proj-cache',
    key: 'u-0001',
    url: 'project://proj-cache/audio/segments/u-0001.wav',
    audioContext: { decodeAudioData: async () => { decodes += 1; return fakeBuffer; } },
    fetchImpl: async () => {
      fetches += 1;
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
    },
  };
  const [first, second] = await Promise.all([loadAudioBuffer(args), loadAudioBuffer(args)]);
  assert.equal(first.buffer, fakeBuffer);
  assert.equal(first.duration, 2.5);
  assert.equal(second.buffer, fakeBuffer);
  assert.equal(fetches, 1);
  assert.equal(decodes, 1);
  assert.equal(peekCachedBuffer('proj-cache', 'u-0001'), fakeBuffer);
  releaseProjectAudio('proj-cache');
  assert.equal(peekCachedBuffer('proj-cache', 'u-0001'), null);
});

test('loadAudioBuffer failures evict and stay path-free', async () => {
  releaseProjectAudio('proj-fail');
  let fetches = 0;
  const args = {
    projectId: 'proj-fail',
    key: 'u-0002',
    url: 'project://proj-fail/audio/segments/u-0002.wav',
    audioContext: {
      decodeAudioData: async () => { throw new Error('bad bytes'); },
    },
    fetchImpl: async () => {
      fetches += 1;
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
    },
  };
  await assert.rejects(() => loadAudioBuffer(args), /Could not decode audio for u-0002\./);
  await assert.rejects(() => loadAudioBuffer(args), /Could not decode audio for u-0002\./);
  assert.equal(fetches, 2);
  assert.equal(peekCachedBuffer('proj-fail', 'u-0002'), null);

  const missing = {
    ...args,
    key: 'u-0003',
    fetchImpl: async () => ({ ok: false, status: 404 }),
  };
  await assert.rejects(() => loadAudioBuffer(missing), (err) => {
    assert.match(err.message, /Could not load audio for u-0003\./);
    assert.ok(!err.message.includes('project://'));
    return true;
  });
});

test('loadAudioBuffer honors aborts without caching', async () => {
  releaseProjectAudio('proj-abort');
  const controller = new AbortController();
  const args = {
    projectId: 'proj-abort',
    key: 'u-0009',
    url: 'project://proj-abort/audio/segments/u-0009.wav',
    audioContext: { decodeAudioData: async () => ({ duration: 1 }) },
    fetchImpl: async (_url, { signal } = {}) => {
      const error = new DOMException('Aborted', 'AbortError');
      signal?.throwIfAborted?.();
      throw error;
    },
    signal: controller.signal,
  };
  controller.abort();
  await assert.rejects(() => loadAudioBuffer(args), (err) => err?.name === 'AbortError');
  assert.equal(peekCachedBuffer('proj-abort', 'u-0009'), null);
});
