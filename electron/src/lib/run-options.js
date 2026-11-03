/**
 * Pure run-mode mapping for the workspace processing selector.
 *
 * Adaptive sampling is the only supported analysis mode: the worker
 * captures one frame per vision request up to a caller-supplied
 * maximum. No IPC, no filesystem, no secrets here — the main process
 * validates and enforces these options before spawning.
 */

/**
 * Adaptive sampling bounds (M4.2-B). The UI default is deliberately
 * below the engine default (60): every sampled frame costs at most one
 * paid vision request. The engine still enforces its own hard cap
 * regardless of what the UI sends.
 */
export const ADAPTIVE_DEFAULT_MAX_FRAMES = 10;
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
 * Clamp a caller-supplied adaptive maximum to a positive integer within
 * the engine hard cap. Non-numeric or out-of-range input falls back to
 * the UI default so the input can never enlarge a run by accident.
 */
export function clampAdaptiveMaxFrames(value) {
  const parsed =
    typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isFinite(parsed)) {
    return ADAPTIVE_DEFAULT_MAX_FRAMES;
  }
  const floored = Math.floor(parsed);
  if (floored < 1) {
    return ADAPTIVE_DEFAULT_MAX_FRAMES;
  }
  return Math.min(floored, ADAPTIVE_HARD_MAX_FRAMES);
}

/**
 * Map the UI mode to worker options. Adaptive mode always carries the
 * validated maximum vision-request bound. Script, streaming, and TTS
 * generation are explicit paid opt-ins (all default off); audio
 * requires the script or streaming here and is re-checked in the main
 * process before spawning.
 */
export function buildProcessOptions(
  mode,
  { adaptiveMaxFrames, withScript = false, requestTts = false, streaming = false } = {},
) {
  const script = withScript === true;
  const stream = streaming === true;
  return {
    adaptive: true,
    adaptiveMaxFrames: clampAdaptiveMaxFrames(
      adaptiveMaxFrames ?? ADAPTIVE_DEFAULT_MAX_FRAMES,
    ),
    withScript: script,
    streaming: stream,
    requestTts: requestTts === true && (script || stream),
  };
}
