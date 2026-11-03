/**
 * Pure media helpers for MVP video export: FFmpeg path resolution,
 * WAV duration parsing, probe/progress parsing, and filter-graph
 * construction. No spawning here (see `export-runner.mjs`); no
 * shell strings anywhere — argv arrays only.
 */

import fs from 'node:fs';
import path from 'node:path';

// Conservative MVP mix: gameplay beds under full-level commentary,
// with a ceiling so summed peaks cannot clip avoidably.
export const EXPORT_MIX = {
  gameGain: 0.8,
  commentaryGain: 1.0,
  limiterCeiling: 0.95,
  sampleRate: 48000,
  audioBitrate: '128k',
};

/** Platform binary name for the bundled ffmpeg-static build. */
export function ffmpegBinaryName(platform = process.platform) {
  return platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
}

/**
 * Resolve the ffmpeg binary without require() (the vite main bundle
 * has no node_modules to resolve from). `FFMPEG_BIN` wins when set
 * (explicit escape hatch, used verbatim); packaged builds use the
 * extra resource beside the asar; development uses the installed
 * package. Convention paths must exist; otherwise null so callers
 * fail honestly. `existsSync` is injectable for tests.
 */
export function resolveFfmpegPath({
  env = process.env,
  appPath,
  resourcesPath,
  isPackaged = false,
  platform = process.platform,
  existsSync = fs.existsSync,
} = {}) {
  const override = typeof env?.FFMPEG_BIN === 'string' && env.FFMPEG_BIN !== '' ? env.FFMPEG_BIN : null;
  if (override) {
    return override;
  }
  const name = ffmpegBinaryName(platform);
  const candidate = isPackaged
    ? (typeof resourcesPath === 'string' ? path.join(resourcesPath, name) : '')
    : (typeof appPath === 'string' ? path.join(appPath, 'node_modules', 'ffmpeg-static', name) : '');
  if (candidate === '') {
    return null;
  }
  try {
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function readAscii(view, offset, length) {
  let text = '';
  for (let i = 0; i < length; i += 1) {
    text += String.fromCharCode(view.getUint8(offset + i));
  }
  return text;
}

/**
 * Parse a WAV duration in seconds from its RIFF header: data bytes
 * over byte rate, so any PCM rate/channel layout works without
 * decoding. Walks chunks (extra chunks skipped with word alignment);
 * anything malformed throws a path-free Error.
 */
export function parseWavDuration(bytes) {
  const view = bytes instanceof DataView
    ? bytes
    : new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.byteLength < 44) {
    throw new Error('Not a WAV file: file is too short.');
  }
  if (readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') {
    throw new Error('Not a WAV file: missing RIFF/WAVE header.');
  }
  let byteRate = null;
  let dataSize = null;
  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const id = readAscii(view, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const dataOffset = offset + 8;
    if (id === 'fmt ') {
      if (size < 16 || dataOffset + 16 > view.byteLength) {
        throw new Error('Not a WAV file: corrupt fmt chunk.');
      }
      byteRate = view.getUint32(dataOffset + 8, true);
    } else if (id === 'data') {
      dataSize = size;
    }
    offset = dataOffset + size + (size % 2);
  }
  if (byteRate === null) {
    throw new Error('Not a WAV file: missing fmt chunk.');
  }
  if (dataSize === null) {
    throw new Error('Not a WAV file: missing data chunk.');
  }
  if (!(byteRate > 0) || !(dataSize > 0)) {
    throw new Error('Not a WAV file: invalid audio parameters.');
  }
  return dataSize / byteRate;
}

function parseClockToSeconds(text) {
  const match = /^(\d+):(\d{2}):([\d.]+)$/.exec(text);
  if (!match) {
    return null;
  }
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/**
 * Parse a bare `ffmpeg -i` stderr header: source duration plus
 * stream inventory. Duration missing means the probe failed (caller
 * aborts, since output cannot be bounded or measured).
 */
export function parseProbeOutput(stderrText) {
  const text = typeof stderrText === 'string' ? stderrText : '';
  let duration = null;
  let hasVideo = false;
  let hasAudio = false;
  let videoCodec = null;
  for (const line of text.split('\n')) {
    const durationMatch = /Duration:\s*(\d+:\d{2}:[\d.]+)/.exec(line);
    if (durationMatch && duration === null) {
      duration = parseClockToSeconds(durationMatch[1]);
    }
    const streamMatch = /Stream #\d+:\d+.*?:\s*(Video|Audio):\s*([\w-]+)/.exec(line);
    if (streamMatch) {
      if (streamMatch[1] === 'Video') {
        hasVideo = true;
        if (videoCodec === null) {
          videoCodec = streamMatch[2];
        }
      } else {
        hasAudio = true;
      }
    }
  }
  return { duration, hasVideo, hasAudio, videoCodec };
}

/**
 * Extract the latest progress point from `-progress pipe:1` text.
 * `out_time_us` wins; `out_time_ms` is microseconds despite its name
 * (verified against ffmpeg 7.0); `out_time` clocks parse as a
 * fallback. `{ timeUs: null, ended: false }` when nothing parsed.
 */
export function extractProgress(text) {
  const lines = typeof text === 'string' ? text.split('\n') : [];
  let timeUs = null;
  let ended = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === 'progress=end') {
      ended = true;
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const key = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1);
    if (key === 'out_time_us' || key === 'out_time_ms') {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) {
        timeUs = parsed;
      }
    } else if (key === 'out_time' && timeUs === null) {
      const seconds = parseClockToSeconds(value);
      if (seconds !== null) {
        timeUs = Math.round(seconds * 1000000);
      }
    }
  }
  return { timeUs, ended };
}

/** Evidence timestamp (video seconds) to an absolute adelay offset. */
export function toStartMs(timestampSeconds) {
  if (typeof timestampSeconds !== 'number' || !Number.isFinite(timestampSeconds) || timestampSeconds < 0) {
    throw new Error('Commentary timestamp must be a non-negative number.');
  }
  return Math.round(timestampSeconds * 1000);
}

/** Filesystem-safe export basename from a project name. */
export function sanitizeExportBasename(name) {
  const cleaned = typeof name === 'string'
    ? name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/[\s.]+$/g, '').trim()
    : '';
  if (cleaned === '') {
    return 'commentary-export';
  }
  return cleaned.slice(0, 100);
}

/** Enforce the MVP's single output container. */
export function withMp4Extension(outputPath) {
  if (typeof outputPath !== 'string' || outputPath === '') {
    throw new Error('Export path must be a non-empty string.');
  }
  if (/\.mp4$/i.test(outputPath)) {
    return outputPath;
  }
  return outputPath.replace(/\.[A-Za-z0-9]{1,5}$/, '') + '.mp4';
}

function normalizeChain() {
  return `aformat=sample_rates=${EXPORT_MIX.sampleRate}:sample_fmts=fltp:channel_layouts=stereo`;
}

/**
 * Build the mix graph for kept segments (export order = input order
 * after the source). Game audio beds at 0.8, commentary sits at 1.0,
 * a limiter ceilings the sum. With game audio the mix runs to the
 * game's length; without it the mix runs longest and `-t` caps the
 * output. Throws when there is nothing to mix.
 */
export function buildFilterGraph({ segments, hasGameAudio }) {
  const kept = Array.isArray(segments) ? segments : [];
  if (kept.length === 0) {
    throw new Error('Export needs at least one commentary segment.');
  }
  const chains = [];
  const mixLabels = [];
  if (hasGameAudio) {
    chains.push(`[0:a]${normalizeChain()},volume=${EXPORT_MIX.gameGain}[game]`);
    mixLabels.push('[game]');
  }
  kept.forEach((segment, index) => {
    const label = `[c${index}]`;
    chains.push(
      `[${index + 1}:a]${normalizeChain()},adelay=${segment.startMs}:all=1,volume=${EXPORT_MIX.commentaryGain}${label}`,
    );
    mixLabels.push(label);
  });
  if (mixLabels.length === 1) {
    chains.push(`${mixLabels[0]}alimiter=limit=${EXPORT_MIX.limiterCeiling}[out]`);
  } else {
    const duration = hasGameAudio ? 'first' : 'longest';
    chains.push(
      `${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=${duration}:dropout_transition=0:normalize=0,alimiter=limit=${EXPORT_MIX.limiterCeiling}[out]`,
    );
  }
  return { filterComplex: chains.join(';'), audioMapLabel: '[out]' };
}

/**
 * Full export argv (array form, never a shell string): source plus one
 * input per kept WAV, timestamp-placed mix, copied video, AAC audio,
 * hard-capped at the source duration with faststart for playback.
 */
export function buildExportArgv({ sourcePath, wavPaths, segments, hasGameAudio, durationSeconds, outputPath }) {
  if (typeof sourcePath !== 'string' || sourcePath === '') {
    throw new Error('Export needs a source video path.');
  }
  if (!Array.isArray(wavPaths) || wavPaths.length === 0) {
    throw new Error('Export needs at least one commentary WAV.');
  }
  if (!(durationSeconds > 0)) {
    throw new Error('Export needs a positive source duration.');
  }
  if (typeof outputPath !== 'string' || outputPath === '') {
    throw new Error('Export needs an output path.');
  }
  const { filterComplex, audioMapLabel } = buildFilterGraph({ segments, hasGameAudio });
  const argv = ['-hide_banner', '-nostats', '-v', 'error', '-i', sourcePath];
  for (const wavPath of wavPaths) {
    argv.push('-i', wavPath);
  }
  argv.push(
    '-filter_complex', filterComplex,
    '-map', '0:v:0',
    '-map', audioMapLabel,
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', EXPORT_MIX.audioBitrate,
    '-t', String(durationSeconds),
    '-movflags', '+faststart',
    '-progress', 'pipe:1',
    '-y', outputPath,
  );
  return argv;
}
