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
    if (!Number.isInteger(maxFrames) || maxFrames < 1) {
      throw new Error('adaptiveMaxFrames must be a positive integer.');
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
  resolvePythonExecutable,
  resolveWorkerScript,
};
