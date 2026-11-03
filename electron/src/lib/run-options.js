/**
 * Pure run-mode mapping for the workspace processing selector.
 *
 * Adaptive sampling is the only supported analysis mode: the worker
 * captures one frame per vision request, sampling to video end unless
 * the caller supplies a maximum. No IPC, no filesystem, no secrets
 * here — the main process validates and enforces these options before
 * spawning.
 */

/**
 * Explicit adaptive bounds must stay within 1..ADAPTIVE_HARD_MAX_FRAMES.
 * There is no numeric default: `null` means unlimited (sample to video
 * end unless stopped), and the worker flag is omitted in that case.
 * Unlimited bounds the run by video end, stop, or failure — never by an
 * invented number — while the engine still enforces the hard cap on
 * explicit values regardless of what the UI sends.
 */
export const ADAPTIVE_HARD_MAX_FRAMES = 10000;

export const RUN_MODES = {
  ADAPTIVE: 'adaptive',
};

export function isAdaptiveMode(mode) {
  return mode === RUN_MODES.ADAPTIVE;
}

/** Adaptive sampling is always the default mode. */
export function defaultRunMode() {
  return RUN_MODES.ADAPTIVE;
}

/**
 * Normalize a caller-supplied adaptive maximum. `null`/`undefined`/an
 * empty input means unlimited (also `null`); a finite number at least 1
 * floors to a positive integer within the hard cap. Anything else is
 * invalid and normalizes to `null` (the default), so callers that need
 * to reject invalid input must check `isValidAdaptiveMaxFrames` first.
 */
export function clampAdaptiveMaxFrames(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed =
    typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(parsed)) {
    return null;
  }
  const floored = Math.floor(parsed);
  if (floored < 1) {
    return null;
  }
  return Math.min(floored, ADAPTIVE_HARD_MAX_FRAMES);
}

/**
 * True for inputs the UI may start a run with: unlimited
 * (`null`/`undefined`/empty) or a finite number at least 1 (floored
 * and hard-capped at spawn time). Zero, negatives, NaN, and
 * non-numeric text are invalid and must be rejected, never silently
 * reinterpreted.
 */
export function isValidAdaptiveMaxFrames(value) {
  if (value === null || value === undefined) {
    return true;
  }
  if (typeof value === 'string' && value.trim() === '') {
    return true;
  }
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(parsed) && parsed >= 1;
}

/**
 * Map the UI mode to worker options. Adaptive mode carries the
 * validated maximum vision-request bound (`null` = unlimited, the
 * default). Streaming is the standard experience (default on): script
 * generation always runs underneath it, so the UI offers no script or
 * mode toggle. Audio stays an explicit paid opt-in and is re-checked
 * in the main process before spawning. Pass `streaming: false`
 * explicitly for the internal sequential fallback (not user-facing).
 */
export function buildProcessOptions(
  mode,
  { adaptiveMaxFrames = null, withScript = false, requestTts = false, streaming = true } = {},
) {
  const script = withScript === true;
  const stream = streaming !== false;
  return {
    adaptive: true,
    adaptiveMaxFrames: clampAdaptiveMaxFrames(adaptiveMaxFrames),
    withScript: script,
    streaming: stream,
    requestTts: requestTts === true && (script || stream),
  };
}
