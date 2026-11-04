// Worker protocol helpers shared by the Electron main process.
// Pure Node.js: no Electron imports, so plain `node --test` can cover it.

import fs from 'node:fs';
import path from 'node:path';
import { TTS_CONFIG_BOUNDS } from './tts-config.mjs';

const SUPPORTED_VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.avi',
  '.mov',
  '.mkv',
  '.webm',
]);

const MESSAGE_TYPES = new Set([
  'started',
  'progress',
  'stage_completed',
  'adaptive_sample',
  'script_segment',
  'tts_segment',
  'api_activity',
  'result',
  'stopped',
  'error',
]);

/**
 * Stdin control-channel contract (M4.2-A): one newline-delimited JSON
 * message per command, mirroring `CONTROL_PROTOCOL_VERSION` in
 * `python/ai_commentator/vision/control.py`. Version 1 carries a single
 * command, `stop`, which the worker routes to the adaptive StopToken.
 * Nothing else may travel this channel: no paths, no shell, no code.
 */
const WORKER_CONTROL_VERSION = 1;

/**
 * Engine hard cap for an explicit `--adaptive-max-frames` bound
 * (mirrors `ADAPTIVE_HARD_MAX_FRAMES` in `config.py`). `null` /
 * `undefined` means unlimited and omits the flag entirely, so the only
 * values rejected here are malformed or out-of-range explicit bounds.
 */
const ADAPTIVE_HARD_MAX_FRAMES = 10000;

const PYTHON_TOOL_SCRIPTS = Object.freeze({
  worker: 'worker.py',
  'provider-setup': 'provider_setup.py',
  'prompt-packs': 'prompt_packs.py',
  'tts-catalog': 'tts_catalog.py',
  'tts-say': 'tts_say.py',
});

const PYTHON_ENGINE_DIRECTORY = 'ROBEngine';
const PYTHON_ENGINE_EXECUTABLE = 'ROBEngine.exe';

function buildStopControlLine() {
  return JSON.stringify({ type: 'stop', version: WORKER_CONTROL_VERSION }) + '\n';
}

/**
 * Incremental newline-delimited JSON parser. Chunk boundaries from the
 * child process rarely align with message boundaries, so callers feed
 * raw stdout data and receive complete messages via onMessage.
 *
 * Malformed lines never throw: they are reported via onInvalid and the
 * parser keeps going with the rest of the stream.
 */
function createLineParser({ onMessage, onInvalid } = {}) {
  let buffer = '';
  let invalidLines = 0;

  function dispatch(line) {
    if (line.trim() === '') {
      return null;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      invalidLines += 1;
      if (typeof onInvalid === 'function') {
        onInvalid(line);
      }
      return null;
    }
    if (typeof onMessage === 'function') {
      onMessage(message, line);
    }
    return message;
  }

  return {
    feed(chunk) {
      const messages = [];
      buffer += String(chunk);
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const message = dispatch(line.replace(/\r$/, ''));
        if (message !== null) {
          messages.push(message);
        }
      }
      return messages;
    },
    flush() {
      // A clean worker ends its stream with a trailing newline, so any
      // remainder here means the process died mid-message.
      if (buffer.trim() === '') {
        buffer = '';
        return [];
      }
      const rest = buffer;
      buffer = '';
      const message = dispatch(rest);
      return message === null ? [] : [message];
    },
    invalidLines() {
      return invalidLines;
    },
  };
}

/** Non-empty string with a supported video extension, or an error string. */
function validateVideoInput(videoPath) {
  if (typeof videoPath !== 'string' || videoPath.trim() === '') {
    return 'videoPath must be a non-empty string.';
  }
  const extension = path.extname(videoPath).toLowerCase();
  if (!SUPPORTED_VIDEO_EXTENSIONS.has(extension)) {
    return (
      `Unsupported video extension ${extension || '(none)'} ` +
      `(supported: ${[...SUPPORTED_VIDEO_EXTENSIONS].join(', ')}).`
    );
  }
  return null;
}

/**
 * Adaptive progress contract (M4.2-B): one `adaptive_sample` message per
 * validated, persisted iteration, emitted by `python/worker.py` from the
 * engine's `on_iteration` hook. `ADAPTIVE_MAX_REASON_CHARS` mirrors the
 * engine config; keep the two in sync.
 */
const ADAPTIVE_SPEEDS = new Set(['HIGH', 'NORMAL', 'LOW']);
const ADAPTIVE_MAX_REASON_CHARS = 280;

function isFiniteTimestamp(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInt(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Strict shape check for `adaptive_sample` data. Anything outside the
 * contract is rejected so the renderer can never render unvalidated
 * model text as run progress.
 */
function isValidAdaptiveSample(message) {
  if (!message || message.type !== 'adaptive_sample') {
    return false;
  }
  const data = message.data;
  if (!data || typeof data !== 'object') {
    return false;
  }
  if (!isFiniteTimestamp(data.timestamp)) {
    return false;
  }
  if (!ADAPTIVE_SPEEDS.has(data.speed)) {
    return false;
  }
  if (
    typeof data.reason !== 'string' ||
    data.reason.length > ADAPTIVE_MAX_REASON_CHARS
  ) {
    return false;
  }
  if (data.next_timestamp !== null && !isFiniteTimestamp(data.next_timestamp)) {
    return false;
  }
  if (!isNonNegativeInt(data.observations) || !isNonNegativeInt(data.requests)) {
    return false;
  }
  return true;
}

const SCRIPT_SEGMENT_STATUSES = new Set(['worded', 'superseded']);
const TTS_SEGMENT_STATUSES = new Set(['success', 'error', 'skipped', 'started']);
const SEGMENT_PRIORITIES = new Set([0, 1, 2]);
const MAX_SEGMENT_TEXT_CHARS = 600;
const MAX_SEGMENT_CLAIM_IDS = 16;

/**
 * Strict shape check for `script_segment` data (streaming runs only).
 * Text is model output that Python already validated deterministically;
 * the shape is re-checked here so the renderer never renders a
 * malformed message as a segment.
 */
function isValidScriptSegment(message) {
  if (!message || message.type !== 'script_segment') {
    return false;
  }
  const data = message.data;
  if (!data || typeof data !== 'object') {
    return false;
  }
  if (typeof data.utterance_id !== 'string' || data.utterance_id.trim() === '') {
    return false;
  }
  if (!isFiniteTimestamp(data.timestamp_seconds)) {
    return false;
  }
  if (
    typeof data.text !== 'string' ||
    data.text.trim() === '' ||
    data.text.length > MAX_SEGMENT_TEXT_CHARS
  ) {
    return false;
  }
  if (
    !Array.isArray(data.source_claim_ids) ||
    data.source_claim_ids.length === 0 ||
    data.source_claim_ids.length > MAX_SEGMENT_CLAIM_IDS ||
    data.source_claim_ids.some((id) => typeof id !== 'string' || id.trim() === '')
  ) {
    return false;
  }
  if (!SEGMENT_PRIORITIES.has(data.priority)) {
    return false;
  }
  if (!SCRIPT_SEGMENT_STATUSES.has(data.status)) {
    return false;
  }
  return true;
}

const API_ACTIVITY_EVENTS = new Set(['started', 'terminal']);
const API_ACTIVITY_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);
const MAX_ACTIVITY_ID_CHARS = 120;
const MAX_ACTIVITY_TEXT_CHARS = 400;
const MAX_ACTIVITY_METADATA_KEYS = 12;

/**
 * Strict shape check for `api_activity` events. Started events carry
 * the request identity (provider, purpose, model, start time);
 * terminal events carry exactly one outcome. Only bounded,
 * secret-free fields are accepted — image payloads and credentials
 * have no place in this schema at all.
 */
function isValidApiActivity(message) {
  if (!message || message.type !== 'api_activity') {
    return false;
  }
  if (typeof message.run_id !== 'string' || message.run_id.trim() === ''
      || message.run_id.length > MAX_ACTIVITY_ID_CHARS) {
    return false;
  }
  const activity = message.activity;
  if (!activity || typeof activity !== 'object') {
    return false;
  }
  if (typeof activity.id !== 'string' || activity.id.trim() === ''
      || activity.id.length > MAX_ACTIVITY_ID_CHARS) {
    return false;
  }
  if (!API_ACTIVITY_EVENTS.has(activity.event)) {
    return false;
  }
  if (activity.event === 'started') {
    if (typeof activity.provider !== 'string' || activity.provider.trim() === ''
        || activity.provider.length > 80) {
      return false;
    }
    if (typeof activity.purpose !== 'string' || activity.purpose.trim() === ''
        || activity.purpose.length > 80) {
      return false;
    }
    if (activity.model !== null && activity.model !== undefined
        && (typeof activity.model !== 'string' || activity.model.length > 160)) {
      return false;
    }
    if (typeof activity.startedAt !== 'number' || !Number.isFinite(activity.startedAt)) {
      return false;
    }
    if (!isNonNegativeInt(activity.frameCount)) {
      return false;
    }
    if (activity.metadata !== undefined && activity.metadata !== null) {
      if (typeof activity.metadata !== 'object' || Array.isArray(activity.metadata)) {
        return false;
      }
      const keys = Object.keys(activity.metadata);
      if (keys.length > MAX_ACTIVITY_METADATA_KEYS) {
        return false;
      }
      for (const key of keys) {
        if (typeof activity.metadata[key] !== 'string'
            || activity.metadata[key].length > 200) {
          return false;
        }
      }
    }
    return true;
  }
  if (!API_ACTIVITY_STATUSES.has(activity.status)) {
    return false;
  }
  if (activity.completedAt !== null && activity.completedAt !== undefined
      && (typeof activity.completedAt !== 'number' || !Number.isFinite(activity.completedAt))) {
    return false;
  }
  if (activity.durationMs !== null && activity.durationMs !== undefined
      && !isNonNegativeInt(activity.durationMs)) {
    return false;
  }
  for (const field of ['httpStatus', 'inputTokens', 'outputTokens']) {
    if (activity[field] !== null && activity[field] !== undefined
        && !isNonNegativeInt(activity[field])) {
      return false;
    }
  }
  for (const field of ['errorCode', 'errorMessage']) {
    if (activity[field] !== null && activity[field] !== undefined
        && (typeof activity[field] !== 'string'
            || activity[field].length > MAX_ACTIVITY_TEXT_CHARS)) {
      return false;
    }
  }
  return true;
}

/** Strict shape check for `tts_segment` data (streaming runs only). */
function isValidTtsSegment(message) {
  if (!message || message.type !== 'tts_segment') {
    return false;
  }
  const data = message.data;
  if (!data || typeof data !== 'object') {
    return false;
  }
  if (typeof data.utterance_id !== 'string' || data.utterance_id.trim() === '') {
    return false;
  }
  if (!isFiniteTimestamp(data.timestamp_seconds)) {
    return false;
  }
  if (!TTS_SEGMENT_STATUSES.has(data.status)) {
    return false;
  }
  if (data.error !== null && data.error !== undefined && typeof data.error !== 'string') {
    return false;
  }
  return true;
}

/**
 * Classify why a worker message is unusable, for honest diagnostics.
 * Returns null when the message is valid, `{ kind: 'unknown-type' }`
 * when the type itself is not in the protocol, or `{ kind:
 * 'invalid-payload', type }` when a known type carries a malformed
 * payload. Never echoes payload data: only the (capped) type travels
 * into error reports, so untrusted content and secrets stay out.
 */
function describeWorkerMessageIssue(message) {
  if (message === null || typeof message !== 'object') {
    return { kind: 'unknown-type', type: null };
  }
  if (!MESSAGE_TYPES.has(message.type)) {
    return {
      kind: 'unknown-type',
      type: typeof message.type === 'string' ? message.type.slice(0, 120) : null,
    };
  }
  if (message.type === 'adaptive_sample' && !isValidAdaptiveSample(message)) {
    return { kind: 'invalid-payload', type: message.type };
  }
  if (message.type === 'script_segment' && !isValidScriptSegment(message)) {
    return { kind: 'invalid-payload', type: message.type };
  }
  if (message.type === 'tts_segment' && !isValidTtsSegment(message)) {
    return { kind: 'invalid-payload', type: message.type };
  }
  if (message.type === 'api_activity' && !isValidApiActivity(message)) {
    return { kind: 'invalid-payload', type: message.type };
  }
  return null;
}

function isValidWorkerMessage(message) {
  return describeWorkerMessageIssue(message) === null;
}

/** Resolve the project-root .venv interpreter (Windows and POSIX). */
function resolvePythonExecutable(repoRoot) {
  const executable =
    process.platform === 'win32'
      ? path.join(repoRoot, '.venv', 'Scripts', 'python.exe')
      : path.join(repoRoot, '.venv', 'bin', 'python');
  if (fs.existsSync(executable)) {
    return { executable, source: 'venv' };
  }
  return { executable: null, source: 'venv', missing: executable };
}

/** Resolve a Python-backed operation for development or a packaged Windows app. */
function resolvePythonTool({
  tool,
  repoRoot,
  isPackaged = false,
  resourcesPath,
  platform = process.platform,
  existsSync = fs.existsSync,
  cwd,
} = {}) {
  const scriptName = PYTHON_TOOL_SCRIPTS[tool];
  if (!scriptName) {
    throw new TypeError(`Unsupported Python tool: ${String(tool)}.`);
  }
  const pathApi = platform === 'win32' ? path.win32 : path;

  if (isPackaged) {
    const executable = pathApi.join(resourcesPath ?? '', PYTHON_ENGINE_DIRECTORY, PYTHON_ENGINE_EXECUTABLE);
    if (platform !== 'win32') {
      return {
        executable: null,
        argsPrefix: [],
        cwd: cwd ?? resourcesPath ?? null,
        source: 'bundled',
        missing: executable,
        reason: 'unsupported-platform',
      };
    }
    try {
      if (existsSync(executable)) {
        return {
          executable,
          argsPrefix: [tool],
          cwd: cwd ?? resourcesPath ?? null,
          source: 'bundled',
          missing: null,
          reason: null,
        };
      }
    } catch {
      // Fall through to the same actionable missing-resource result.
    }
    return {
      executable: null,
      argsPrefix: [],
      cwd: cwd ?? resourcesPath ?? null,
      source: 'bundled',
      missing: executable,
      reason: 'missing-resource',
    };
  }

  const interpreter = platform === 'win32'
    ? pathApi.join(repoRoot ?? '', '.venv', 'Scripts', 'python.exe')
    : pathApi.join(repoRoot ?? '', '.venv', 'bin', 'python');
  const script = pathApi.join(repoRoot ?? '', 'python', scriptName);
  try {
    if (!existsSync(interpreter)) {
      return { executable: null, argsPrefix: [], cwd: cwd ?? repoRoot ?? null, source: 'venv', missing: interpreter, reason: 'missing-interpreter' };
    }
    if (!existsSync(script)) {
      return { executable: null, argsPrefix: [], cwd: cwd ?? repoRoot ?? null, source: 'venv', missing: script, reason: 'missing-script' };
    }
  } catch {
    return { executable: null, argsPrefix: [], cwd: cwd ?? repoRoot ?? null, source: 'venv', missing: interpreter, reason: 'missing-interpreter' };
  }
  return {
    executable: interpreter,
    argsPrefix: [script],
    cwd: cwd ?? repoRoot ?? null,
    source: 'venv',
    missing: null,
    reason: null,
  };
}

/** True when a vision API key is present in the given environment. */
function isVisionConfigured(env = process.env) {
  const key =
    env && typeof env.BASETEN_API_KEY === 'string'
      ? env.BASETEN_API_KEY.trim()
      : '';
  return key !== '';
}

/**
 * TTS argv options are bounded non-empty strings (the worker re-validates
 * them against the authoritative Python gate before any synthesis).
 */
function assertTtsOption(value, name, maxLength) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength) {
    throw new Error(`${name} must be a non-empty string under ${maxLength + 1} characters.`);
  }
}

/**
 * Build the worker argv from validated main-process inputs. Throws on
 * an invalid limit so the IPC handler can reject before spawning.
 * Only known flags are ever emitted; renderer input cannot inject
 * arbitrary arguments.
 */
function buildWorkerArgv(script, videoPath, opts = {}) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const argv = [script, videoPath];
  if (options.outputDir) {
    argv.push('--output-dir', String(options.outputDir));
  }
  if (options.withScript) {
    argv.push('--with-script');
  }
  if (options.streaming) {
    argv.push('--streaming');
  }
  if (options.generateTts) {
    if (!options.withScript && !options.streaming) {
      throw new Error('--generate-tts requires --with-script.');
    }
    argv.push('--generate-tts');
  }
  if (options.ttsModel !== undefined && options.ttsModel !== null) {
    assertTtsOption(options.ttsModel, 'ttsModel', TTS_CONFIG_BOUNDS.modelMaxLength);
    argv.push('--tts-model', options.ttsModel);
  }
  if (options.ttsVoice !== undefined && options.ttsVoice !== null) {
    assertTtsOption(options.ttsVoice, 'ttsVoice', TTS_CONFIG_BOUNDS.voiceMaxLength);
    argv.push('--tts-voice', options.ttsVoice);
  }
  if (options.ttsVoiceDirection !== undefined && options.ttsVoiceDirection !== null) {
    assertTtsOption(
      options.ttsVoiceDirection, 'ttsVoiceDirection', TTS_CONFIG_BOUNDS.voiceDirectionMaxLength,
    );
    argv.push('--tts-voice-direction', options.ttsVoiceDirection);
  }
  if (options.adaptive) {
    argv.push('--adaptive');
  }
  if (options.adaptiveMaxFrames !== undefined && options.adaptiveMaxFrames !== null) {
    const maxFrames =
      typeof options.adaptiveMaxFrames === 'number'
        ? options.adaptiveMaxFrames
        : Number(String(options.adaptiveMaxFrames).trim());
    if (!Number.isInteger(maxFrames) || maxFrames < 1 || maxFrames > ADAPTIVE_HARD_MAX_FRAMES) {
      throw new Error(
        `adaptiveMaxFrames must be a positive integer up to ${ADAPTIVE_HARD_MAX_FRAMES}.`,
      );
    }
    argv.push('--adaptive-max-frames', String(maxFrames));
  }
  return argv;
}

function resolveWorkerScript(repoRoot) {
  const script = path.join(repoRoot, 'python', 'worker.py');
  if (fs.existsSync(script)) {
    return { script, missing: null };
  }
  return { script: null, missing: script };
}

export {
  SUPPORTED_VIDEO_EXTENSIONS,
  MESSAGE_TYPES,
  WORKER_CONTROL_VERSION,
  buildStopControlLine,
  buildWorkerArgv,
  createLineParser,
  isVisionConfigured,
  validateVideoInput,
  isValidWorkerMessage,
  describeWorkerMessageIssue,
  isValidAdaptiveSample,
  isValidScriptSegment,
  isValidTtsSegment,
  isValidApiActivity,
  resolvePythonExecutable,
  resolvePythonTool,
  resolveWorkerScript,
};
