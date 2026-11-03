/**
 * Pure scheduling logic for the synchronized commentary timeline.
 *
 * Timing contract (documented assumption, no contract change): a
 * segment's `timestamp_seconds` is SOURCE EVIDENCE time on the
 * source-video clock — streaming sets it to the newest cited claim's
 * scheduled capture time (`run_script_window`), and the sequential
 * path copies event/commentary evidence times through script-v1 into
 * tts-v1. That makes it suitable as the intended commentary START,
 * with known limits: wording may also cover earlier-cited claims,
 * adaptive stamps name scheduled (not frame-perfect) times, and
 * several segments may share one timestamp. Generation completion
 * time is never used. End time is start plus the decoded WAV
 * duration. Single commentary channel: overlapping followers are
 * skipped for the pass, never mixed.
 */

const WINDOW_EPSILON = 1e-3;

function asStart(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function asDuration(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function clampNow(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Build deterministic playback intervals from audio rows plus decoded
 * durations. Only `ready` rows with a known positive duration and a
 * servable file become intervals; every other state (waiting,
 * generating, failed, unavailable, skipped, no-audio) is excluded so
 * missing audio can never produce phantom playback. Sorted by
 * (start, key).
 */
export function buildIntervals(rows, durations) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const lookup =
    durations instanceof Map
      ? (key) => durations.get(key)
      : (key) => durations?.[key];
  const intervals = [];
  for (const row of safeRows) {
    if (!row || row.state !== 'ready') {
      continue;
    }
    const start = asStart(row.timestamp);
    const duration = asDuration(lookup(row.key));
    if (start === null || duration === null) {
      continue;
    }
    if (typeof row.scope !== 'string' || typeof row.name !== 'string') {
      continue;
    }
    intervals.push({
      key: row.key,
      title: typeof row.title === 'string' ? row.title : String(row.key),
      text: typeof row.text === 'string' ? row.text : '',
      start,
      end: start + duration,
      scope: row.scope,
      name: row.name,
    });
  }
  intervals.sort((a, b) => (a.start === b.start ? (a.key < b.key ? -1 : 1) : a.start - b.start));
  return intervals;
}

/**
 * Keys that arrived too late for the current pass: present in
 * `intervals` but absent from `prevIntervals` with a start already
 * behind `now`. A new key reusing a previously known start (the
 * mid-run utterance-to-segment rename) is continuity, not lateness,
 * and stays eligible. Callers add late keys to the pass's missed set
 * so late audio is never blurted mid-pass; a seek or replay
 * re-enables them.
 */
export function findLateKeys(prevIntervals, intervals, now) {
  const prev = Array.isArray(prevIntervals) ? prevIntervals : [];
  const knownKeys = new Set();
  const knownStarts = [];
  for (const item of prev) {
    if (!item) {
      continue;
    }
    knownKeys.add(item.key);
    if (typeof item.start === 'number') {
      knownStarts.push(item.start);
    }
  }
  const at = clampNow(now);
  const late = [];
  for (const interval of Array.isArray(intervals) ? intervals : []) {
    if (!interval || knownKeys.has(interval.key)) {
      continue;
    }
    if (typeof interval.start !== 'number' || interval.start >= at) {
      continue;
    }
    const renamed = knownStarts.some((start) => Math.abs(start - interval.start) < WINDOW_EPSILON);
    if (!renamed) {
      late.push(interval.key);
    }
  }
  return late;
}

function windowMatches(interval, activeWindow) {
  return samePlaybackWindow(interval, activeWindow);
}

/**
 * Full-pass outcome of the single-channel policy: earliest starter
 * wins, followers colliding with a kept interval are dropped, and
 * touching boundaries (start == kept end) are allowed — the same
 * rule `planPlayback` applies per instant. Shared by live playback
 * and offline export so both drop exactly the same segments.
 */
export function selectSingleChannel(intervals) {
  const safe = Array.isArray(intervals) ? intervals : [];
  const kept = [];
  const dropped = [];
  let end = Number.NEGATIVE_INFINITY;
  for (const interval of safe) {
    if (!interval || typeof interval.start !== 'number' || typeof interval.end !== 'number') {
      continue;
    }
    if (interval.start >= end) {
      kept.push(interval);
      end = interval.end;
    } else {
      dropped.push(interval);
    }
  }
  return { kept, dropped };
}

/**
 * Whether two `{ start, end }` windows describe the same sounding
 * audio (millisecond tolerance). Lets the scheduler adopt a renamed
 * key without restarting the source node.
 */
export function samePlaybackWindow(a, b) {
  if (!a || !b || typeof a.start !== 'number' || typeof a.end !== 'number') {
    return false;
  }
  if (typeof b.start !== 'number' || typeof b.end !== 'number') {
    return false;
  }
  return (
    Math.abs(a.start - b.start) < WINDOW_EPSILON && Math.abs(a.end - b.end) < WINDOW_EPSILON
  );
}

/**
 * Resolve one scheduling pass at video time `now`.
 *
 * - `missedKeys`: keys skipped for this pass (late arrivals, overlap
 *   losers); never audible until a seek/replay clears them.
 * - `activeWindow`: `{ start, end }` of the currently sounding audio,
 *   matched by time (not key) so mid-run renames keep playing.
 *
 * Returns `{ audible, stopActive, skipKeys }`: `audible` is the
 * interval to sound (`{ key, start, end, offset }`) or null during
 * gaps; `stopActive` ends stale audio; `skipKeys` joins the missed
 * set (fully-past intervals plus followers colliding with `audible`).
 */
export function planPlayback({ intervals = [], now = 0, missedKeys = [], activeWindow = null } = {}) {
  const safe = Array.isArray(intervals) ? intervals : [];
  const at = clampNow(now);
  const missed =
    missedKeys instanceof Set
      ? missedKeys
      : new Set(Array.isArray(missedKeys) ? missedKeys : []);
  const skipKeys = [];
  const hasActive =
    activeWindow !== null &&
    typeof activeWindow === 'object' &&
    typeof activeWindow.start === 'number' &&
    typeof activeWindow.end === 'number';

  let audible = null;
  for (const interval of safe) {
    if (!interval || missed.has(interval.key)) {
      continue;
    }
    if (interval.end <= at) {
      skipKeys.push(interval.key);
      continue;
    }
    if (interval.start <= at && at < interval.end) {
      if (audible === null) {
        audible = {
          key: interval.key,
          start: interval.start,
          end: interval.end,
          offset: Math.max(0, at - interval.start),
        };
      } else if (interval.start < audible.end) {
        skipKeys.push(interval.key);
      }
      continue;
    }
    if (audible !== null && interval.start < audible.end) {
      skipKeys.push(interval.key);
    }
  }

  if (hasActive) {
    // A sounding window survives only while a matching interval still
    // contains now (matched by time so renames keep playing). Any
    // other active window — ended, removed, or missed — tears down.
    const continued = safe.find(
      (interval) =>
        interval &&
        !missed.has(interval.key) &&
        interval.start <= at &&
        at < interval.end &&
        windowMatches(interval, activeWindow),
    );
    if (continued) {
      return {
        audible: {
          key: continued.key,
          start: continued.start,
          end: continued.end,
          offset: Math.max(0, at - continued.start),
        },
        stopActive: false,
        skipKeys: skipKeys.filter((key) => key !== continued.key),
      };
    }
    return { audible, stopActive: true, skipKeys };
  }
  return { audible, stopActive: false, skipKeys };
}
