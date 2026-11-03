/**
 * Supervises one FFmpeg export job at a time: probe the source, resolve
 * the caller's segment plan, spawn the encode, stream progress, and
 * cancel safely. Pure Node.js (injectable spawn), mirroring the
 * python-worker manager's lifecycle: SIGTERM first, SIGKILL after a
 * grace period on POSIX, plain kill on Windows. A failed or
 * cancelled export never reports its partial output as success.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { buildExportArgv, extractProgress, parseProbeOutput } from './export-media.mjs';

const PROBE_STDERR_LIMIT = 65536;
const PROGRESS_TAIL_LIMIT = 4096;
const ERROR_TAIL_LIMIT = 2000;

function tail(text, limit) {
  return text.length > limit ? text.slice(text.length - limit) : text;
}

function outputIsUsable(outputPath) {
  try {
    return fs.statSync(outputPath).isFile() && fs.statSync(outputPath).size > 0;
  } catch {
    return false;
  }
}

function removeQuietly(outputPath) {
  try {
    fs.rmSync(outputPath, { force: true });
  } catch {
    // Best effort: the error report below still stands.
  }
}

function killChild(child, signal) {
  try {
    child.kill(signal);
  } catch {
    // Already gone; close settles the record.
  }
}

export function createExportManager({ spawnFn = spawn } = {}) {
  let active = null;

  function clearIfCurrent(record) {
    if (active === record) {
      active = null;
    }
  }

  function runProbe(executable, sourcePath) {
    return new Promise((resolve) => {
      let stderrText = '';
      let child;
      try {
        child = spawnFn(executable, ['-hide_banner', '-i', sourcePath], {
          stdio: ['ignore', 'ignore', 'pipe'],
        });
      } catch (err) {
        resolve({ ok: false, spawnError: err });
        return;
      }
      const record = active;
      if (record) {
        record.child = child;
      }
      if (child.stderr && typeof child.stderr.on === 'function') {
        child.stderr.on('data', (chunk) => {
          stderrText = tail(stderrText + String(chunk), PROBE_STDERR_LIMIT);
        });
      }
      child.on('error', (err) => {
        resolve({ ok: false, spawnError: err });
      });
      child.on('close', () => {
        // A bare `-i` always exits nonzero (no output file); the
        // header on stderr is the actual result.
        resolve({ ok: true, probe: parseProbeOutput(stderrText) });
      });
    });
  }

  return {
    isBusy() {
      return active !== null;
    },

    /**
     * Run one export. `resolvePlan({ duration, hasVideo, hasAudio })`
     * returns `{ wavPaths, segments, hasGameAudio }` (or throws a
     * user-safe Error); `onEvent` receives `{ phase: 'progress' |
     * 'done' | 'error' | 'cancelled', ... }`. Resolves once the
     * encode is spawned (progress follows through events).
     */
    async start({ executable, sourcePath, outputPath, resolvePlan, onEvent } = {}) {
      if (active !== null) {
        return { started: false, reason: 'busy' };
      }
      if (typeof executable !== 'string' || executable === '') {
        throw new TypeError('executable must be a non-empty string.');
      }
      if (typeof resolvePlan !== 'function') {
        throw new TypeError('resolvePlan must be a function.');
      }
      const record = { cancelled: false, killTimer: null, child: null };
      active = record;
      const emit = (event) => {
        if (typeof onEvent === 'function') {
          onEvent(event);
        }
      };

      const probed = await runProbe(executable, sourcePath);
      if (record.cancelled) {
        clearIfCurrent(record);
        emit({ phase: 'cancelled' });
        return { started: false, reason: 'cancelled' };
      }
      if (!probed.ok) {
        clearIfCurrent(record);
        const message = 'Could not start FFmpeg for this export.';
        emit({ phase: 'error', error: message });
        return { started: false, reason: 'spawn-failed', error: message };
      }
      const { duration, hasVideo, hasAudio } = probed.probe;
      if (!(duration > 0) || !hasVideo) {
        clearIfCurrent(record);
        const message = hasVideo
          ? 'Could not read the source video duration.'
          : 'The source file has no video track to export.';
        emit({ phase: 'error', error: message });
        return { started: false, reason: 'probe-failed', error: message };
      }
      let plan;
      try {
        plan = await resolvePlan({ duration, hasVideo, hasAudio });
      } catch (err) {
        clearIfCurrent(record);
        const message = err?.message ?? 'Could not plan this export.';
        emit({ phase: 'error', error: message });
        return { started: false, reason: 'plan-failed', error: message };
      }
      let argv;
      try {
        argv = buildExportArgv({
          sourcePath,
          wavPaths: plan.wavPaths,
          segments: plan.segments,
          hasGameAudio: plan.hasGameAudio,
          durationSeconds: duration,
          outputPath,
        });
      } catch (err) {
        clearIfCurrent(record);
        const message = err?.message ?? 'Could not plan this export.';
        emit({ phase: 'error', error: message });
        return { started: false, reason: 'plan-failed', error: message };
      }

      let child;
      try {
        child = spawnFn(executable, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        clearIfCurrent(record);
        const message = 'Could not start FFmpeg for this export.';
        emit({ phase: 'error', error: message });
        return { started: false, reason: 'spawn-failed', error: message, spawnError: err };
      }
      record.child = child;
      const totalUs = Math.round(duration * 1000000);
      let progressText = '';
      let errorText = '';

      child.stdout.on('data', (chunk) => {
        progressText = tail(progressText + String(chunk), PROGRESS_TAIL_LIMIT);
        const { timeUs } = extractProgress(progressText);
        if (timeUs !== null) {
          emit({ phase: 'progress', completedUs: Math.min(timeUs, totalUs), totalUs });
        }
      });
      if (child.stderr && typeof child.stderr.on === 'function') {
        child.stderr.on('data', (chunk) => {
          errorText = tail(errorText + String(chunk), ERROR_TAIL_LIMIT);
        });
      }
      const finish = () => {
        if (record.killTimer) {
          clearTimeout(record.killTimer);
          record.killTimer = null;
        }
        clearIfCurrent(record);
      };
      child.on('error', (err) => {
        if (record.cancelled) {
          return;
        }
        record.spawnError = err;
      });
      child.on('close', (code) => {
        finish();
        if (record.cancelled) {
          removeQuietly(outputPath);
          emit({ phase: 'cancelled' });
          return;
        }
        if (code === 0 && !record.spawnError && outputIsUsable(outputPath)) {
          emit({ phase: 'done', outputPath });
          return;
        }
        removeQuietly(outputPath);
        const detail = errorText.trim().split('\n').pop() ?? '';
        const message = detail !== ''
          ? `Export failed: ${detail.slice(0, 300)}`
          : 'Export failed: FFmpeg reported an error.';
        emit({ phase: 'error', error: message });
      });
      return { started: true, pid: child.pid ?? null };
    },

    /**
     * Terminate the active export and remove its partial output.
     * Resolves true once the process has exited (or when idle).
     */
    cancel({ killGraceMs = 3000 } = {}) {
      const record = active;
      if (!record || !record.child) {
        return Promise.resolve(false);
      }
      record.cancelled = true;
      return new Promise((resolve) => {
        const done = () => resolve(true);
        try {
          record.child.once('close', done);
        } catch {
          resolve(true);
          return;
        }
        killChild(record.child, 'SIGTERM');
        if (process.platform !== 'win32') {
          record.killTimer = setTimeout(() => {
            if (record.child) {
              killChild(record.child, 'SIGKILL');
            }
          }, killGraceMs);
          if (typeof record.killTimer.unref === 'function') {
            record.killTimer.unref();
          }
        }
      });
    },
  };
}
