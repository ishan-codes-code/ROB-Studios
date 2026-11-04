/**
 * Join script/TTS state with discovered audio files into playable rows.
 *
 * Two modes, matching the pipeline: while no finalized `tts.json` exists
 * the live script segments (utterance ids) join against mid-run
 * `u-*.wav` files; once the manifest exists it is authoritative and its
 * entries join against `segment-*.wav` files. A row is `ready` only when
 * a listed file backs it — event success alone never implies playability.
 */

const MEDIA_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** Basename of a manifest `audio_file`, or '' when it is not servable. */
export function manifestAudioFileName(audioFile) {
  if (typeof audioFile !== 'string') {
    return '';
  }
  const parts = audioFile.split('/');
  if (parts.some((part) => part === '..')) {
    return '';
  }
  const base = parts.pop() ?? '';
  if (!MEDIA_NAME_RE.test(base) || base.startsWith('.')) {
    return '';
  }
  return base;
}

/** Expected mid-run filename for one utterance id, or '' when unsafe. */
function liveFileName(utteranceId) {
  if (typeof utteranceId !== 'string' || utteranceId === '') {
    return '';
  }
  const name = `${utteranceId}.wav`;
  if (!MEDIA_NAME_RE.test(name) || name.startsWith('.')) {
    return '';
  }
  return name;
}

function asTimestamp(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asText(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * Select the manifest entries to render, or null for the live view.
 * A manifest is fresh when this session started no TTS run yet
 * (`sessionGeneration` nullish — hydration and pre-run views accept
 * whatever is persisted) or when its `generation_id` matches the
 * generation the worker reported for the current run. A stale
 * manifest (previous run, worker restart) yields null so live
 * segments render instead of last run's rows.
 */
export function selectFreshTtsEntries(manifestDoc, sessionGeneration) {
  const entries = manifestDoc?.entries;
  if (!Array.isArray(entries)) {
    return null;
  }
  if (sessionGeneration === null || sessionGeneration === undefined) {
    return entries;
  }
  if (
    typeof sessionGeneration === 'string' &&
    typeof manifestDoc.generation_id === 'string' &&
    manifestDoc.generation_id !== '' &&
    manifestDoc.generation_id === sessionGeneration
  ) {
    return entries;
  }
  return null;
}

/**
 * Build one row per segment/entry: `{ key, title, timestamp, text,
 * state, error, scope, name }`. States: `ready` (listed file, playable),
 * `generating`, `waiting`, `failed`, `skipped`, `unavailable` (success
 * reported but no file), `no-audio` (settled without synthesis), and
 * `unknown` (forward-compatible fallback carrying `rawStatus`).
 */
export function buildAudioRows({ segments = [], files = [], entries = null, live = false } = {}) {
  const safeFiles = Array.isArray(files) ? files : [];
  const byPath = new Map();
  for (const file of safeFiles) {
    if (file && typeof file.scope === 'string' && typeof file.name === 'string') {
      byPath.set(`${file.scope}/${file.name}`, file);
    }
  }
  const findSegmentFile = (name) =>
    name === '' ? null : (byPath.get(`audio/segments/${name}`) ?? null);

  const rows = [];
  if (Array.isArray(entries)) {
    entries.forEach((entry, index) => {
      const name = manifestAudioFileName(entry?.audio_file);
      const file = findSegmentFile(name);
      const status = entry?.status;
      let state = 'unknown';
      if (status === 'success') {
        state = file === null ? 'unavailable' : 'ready';
      } else if (status === 'error') {
        state = 'failed';
      } else if (status === 'skipped') {
        state = 'skipped';
      }
      rows.push({
        key: typeof entry?.segment_id === 'string' ? entry.segment_id : `entry-${index}`,
        title: typeof entry?.segment_id === 'string' ? entry.segment_id : `entry-${index}`,
        timestamp: asTimestamp(entry?.timestamp_seconds),
        text: asText(entry?.text),
        state,
        rawStatus: typeof status === 'string' ? status : null,
        error:
          status === 'error' && typeof entry?.error === 'string' ? entry.error : null,
        scope: file?.scope ?? null,
        name: file?.name ?? null,
      });
    });
  } else {
    const safeSegments = Array.isArray(segments) ? segments : [];
    safeSegments.forEach((segment, index) => {
      const utteranceId = segment?.utteranceId;
      const ttsStatus = segment?.ttsStatus;
      let state = 'unknown';
      if (segment?.scriptStatus === 'superseded') {
        state = 'skipped';
      } else if (ttsStatus === 'error') {
        state = 'failed';
      } else if (ttsStatus === 'skipped') {
        state = 'skipped';
      } else if (ttsStatus === 'success') {
        state = findSegmentFile(liveFileName(utteranceId)) === null ? 'unavailable' : 'ready';
      } else if (ttsStatus === 'started') {
        state = 'generating';
      } else if (ttsStatus === null || ttsStatus === undefined) {
        state = live ? 'waiting' : 'no-audio';
      }
      const file = state === 'ready' ? findSegmentFile(liveFileName(utteranceId)) : null;
      rows.push({
        key: typeof utteranceId === 'string' ? utteranceId : `segment-${index}`,
        title: typeof utteranceId === 'string' ? utteranceId : `segment-${index}`,
        timestamp: asTimestamp(segment?.timestamp),
        text: asText(segment?.text),
        state,
        rawStatus: typeof ttsStatus === 'string' ? ttsStatus : null,
        error:
          ttsStatus === 'error' && typeof segment?.ttsError === 'string'
            ? segment.ttsError
            : null,
        scope: file?.scope ?? null,
        name: file?.name ?? null,
      });
    });
  }
  return {
    rows,
    ready: rows.filter((row) => row.state === 'ready').length,
    total: rows.length,
    failed: rows.filter((row) => row.state === 'failed' || row.state === 'unavailable').length,
    skipped: rows.filter((row) => row.state === 'skipped').length,
  };
}
