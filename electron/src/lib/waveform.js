/**
 * Waveform peaks and audio-buffer loading for the commentary timeline.
 *
 * Each ready segment's WAV is fetched once through the existing
 * `project://` media mechanism, decoded once with the shared
 * AudioContext, and cached per project for the session: the decoded
 * buffer feeds both scheduling (duration) and the waveform (peaks),
 * and playback reuses the same buffer. Nothing here synthesizes,
 * transcodes, or edits audio.
 */

export const WAVEFORM_PEAK_COUNT = 96;
export const WAVEFORM_VIEWBOX_WIDTH = 96;
export const WAVEFORM_VIEWBOX_HEIGHT = 32;

function zeros(count) {
  return Array.from({ length: count }, () => 0);
}

function peakCountOr(count, fallback) {
  return Number.isInteger(count) && count > 0 && count <= 4096 ? count : fallback;
}

/**
 * Downsample channel data to `peakCount` normalized peaks (0..1): the
 * max absolute sample per bucket, scaled by the file's own max so
 * quiet speech stays visible. Pure and deterministic; empty or
 * invalid input yields silence (zeros), never invented shapes.
 */
export function computePeaks(channels, peakCount = WAVEFORM_PEAK_COUNT) {
  const count = peakCountOr(peakCount, WAVEFORM_PEAK_COUNT);
  const valid = (Array.isArray(channels) ? channels : []).filter(
    (channel) => channel && typeof channel.length === 'number' && channel.length > 0,
  );
  if (valid.length === 0) {
    return zeros(count);
  }
  const length = Math.max(...valid.map((channel) => channel.length));
  const peaks = zeros(count);
  let globalMax = 0;
  for (let bucket = 0; bucket < count; bucket += 1) {
    const start = Math.floor((bucket * length) / count);
    const end = Math.max(start + 1, Math.floor(((bucket + 1) * length) / count));
    let peak = 0;
    for (const channel of valid) {
      const stop = Math.min(end, channel.length);
      for (let i = start; i < stop; i += 1) {
        const value = Math.abs(channel[i]);
        if (value > peak) {
          peak = value;
        }
      }
    }
    peaks[bucket] = peak;
    if (peak > globalMax) {
      globalMax = peak;
    }
  }
  if (globalMax <= 0) {
    return peaks;
  }
  return peaks.map((peak) => peak / globalMax);
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

/**
 * Render peaks as one SVG path of centered bars in a
 * 96x32 viewBox (stretched horizontally by the caller with
 * `preserveAspectRatio="none"`). One element per segment keeps long
 * timelines light. Empty input renders nothing.
 */
export function peaksToPath(
  peaks,
  width = WAVEFORM_VIEWBOX_WIDTH,
  height = WAVEFORM_VIEWBOX_HEIGHT,
) {
  if (!Array.isArray(peaks) || peaks.length === 0) {
    return '';
  }
  const safeWidth = typeof width === 'number' && width > 0 ? width : WAVEFORM_VIEWBOX_WIDTH;
  const safeHeight = typeof height === 'number' && height > 0 ? height : WAVEFORM_VIEWBOX_HEIGHT;
  const slot = safeWidth / peaks.length;
  const barWidth = Math.max(1, slot * 0.7);
  const centerY = safeHeight / 2;
  const parts = [];
  peaks.forEach((peak, index) => {
    const clamped = typeof peak === 'number' && Number.isFinite(peak) ? Math.min(1, Math.max(0, peak)) : 0;
    const barHeight = Math.max(1, clamped * safeHeight);
    const x = round1(index * slot + (slot - barWidth) / 2);
    const y = round1(centerY - barHeight / 2);
    parts.push(`M${x} ${y}h${round1(barWidth)}v${round1(barHeight)}h${round1(-barWidth)}Z`);
  });
  return parts.join('');
}

let sharedContext = null;

function defaultCreateContext() {
  if (typeof AudioContext === 'undefined') {
    throw new Error('Web Audio is unavailable in this environment.');
  }
  return new AudioContext();
}

/**
 * The timeline's single AudioContext, created lazily so no context
 * exists before first use. The factory parameter exists for tests;
 * production always uses the real constructor.
 */
export function getSharedAudioContext(create = defaultCreateContext) {
  if (sharedContext === null) {
    sharedContext = create();
  }
  return sharedContext;
}

/** Close and forget the shared context (project change / teardown). */
export async function releaseSharedAudioContext() {
  const context = sharedContext;
  sharedContext = null;
  if (context && typeof context.close === 'function') {
    try {
      await context.close();
    } catch {
      // Closing is best-effort; the reference is already dropped.
    }
  }
}

// projectId -> key -> { buffer } | { promise }
const bufferCache = new Map();

function namespace(projectId) {
  let space = bufferCache.get(projectId);
  if (!space) {
    space = new Map();
    bufferCache.set(projectId, space);
  }
  return space;
}

/** Drop every cached buffer for one project; played sources are unaffected. */
export function releaseProjectAudio(projectId) {
  bufferCache.delete(projectId);
}

/** Cached buffer without fetching, or null when not decoded yet. */
export function peekCachedBuffer(projectId, key) {
  return bufferCache.get(projectId)?.get(key)?.buffer ?? null;
}

/**
 * Fetch + decode one segment WAV, cached per project and deduplicated
 * across concurrent callers. Resolves `{ buffer, duration }`.
 * Failures evict the entry (a retry fetches again) and carry the
 * segment key only — never the URL — so UI errors stay path-free.
 */
export async function loadAudioBuffer({
  projectId,
  key,
  url,
  audioContext,
  fetchImpl = fetch,
  signal,
}) {
  if (!projectId || !key || !url || !audioContext) {
    throw new Error(`Cannot load audio for ${key ?? 'unknown segment'}.`);
  }
  const space = namespace(projectId);
  const cached = space.get(key);
  if (cached?.buffer) {
    return { buffer: cached.buffer, duration: cached.buffer.duration };
  }
  if (cached?.promise) {
    return cached.promise;
  }
  const pending = (async () => {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    let response;
    try {
      response = await fetchImpl(url, signal ? { signal } : undefined);
    } catch (err) {
      if (err?.name === 'AbortError' || signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      throw new Error(`Could not load audio for ${key}.`);
    }
    if (!response || response.ok !== true) {
      throw new Error(`Could not load audio for ${key}.`);
    }
    let bytes;
    try {
      bytes = await response.arrayBuffer();
    } catch (err) {
      if (err?.name === 'AbortError' || signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      throw new Error(`Could not load audio for ${key}.`);
    }
    let buffer;
    try {
      buffer = await audioContext.decodeAudioData(bytes);
    } catch {
      throw new Error(`Could not decode audio for ${key}.`);
    }
    if (!buffer || typeof buffer.duration !== 'number') {
      throw new Error(`Could not decode audio for ${key}.`);
    }
    return { buffer, duration: buffer.duration };
  })();
  space.set(key, { promise: pending });
  try {
    const result = await pending;
    space.set(key, { buffer: result.buffer });
    return result;
  } catch (err) {
    if (space.get(key)?.promise === pending) {
      space.delete(key);
    }
    throw err;
  }
}
