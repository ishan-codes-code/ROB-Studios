// Persistent renderer/process diagnostics (Electron main process only).
//
// Console output vanishes when the app closes, which is exactly when
// crash evidence is needed. This module appends structured JSONL
// events to a bounded log under Electron's userData directory so a
// renderer crash, GPU termination, or load failure can be diagnosed
// after the fact — without the renderer, without the network, and
// without ever touching the Python worker's stdout.
//
// Safety contract: recording never throws, never blocks on I/O
// retries, never stores secrets (allowlist-shaped events plus a
// secret-key scrubber), and rotation keeps total disk use bounded.

import fs from 'node:fs';
import path from 'node:path';

export const DIAGNOSTICS_FILE_NAME = 'diagnostics.log';
export const DIAGNOSTICS_BACKUP_SUFFIX = '.1';
export const DIAGNOSTICS_MAX_BYTES = 256 * 1024;
export const DIAGNOSTICS_MAX_STRING_CHARS = 2000;

const SECRET_KEY_PATTERN = /key|secret|token|password|credential|authorization|passwd|private_key/i;

export function diagnosticsLogPath(userDataPath) {
  return path.join(userDataPath, DIAGNOSTICS_FILE_NAME);
}

function truncateString(value) {
  if (typeof value !== 'string') {
    return value;
  }
  return value.length > DIAGNOSTICS_MAX_STRING_CHARS
    ? `${value.slice(0, DIAGNOSTICS_MAX_STRING_CHARS)}…(truncated)`
    : value;
}

function sanitizeValue(value, depth = 0) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    return truncateString(value);
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (depth >= 4 || typeof value !== 'object') {
    return null;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 32).map((entry) => sanitizeValue(entry, depth + 1));
  }
  const clean = {};
  for (const [key, entry] of Object.entries(value).slice(0, 64)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      clean[key] = '[REDACTED]';
    } else {
      clean[key] = sanitizeValue(entry, depth + 1);
    }
  }
  return clean;
}

/**
 * Build the environment snapshot recorded with lifecycle milestones:
 * versions, platform, packaging, GPU feature status where available,
 * and the local crash-dump directory when resolvable. Every field is
 * caller-supplied so tests never need a running Electron app.
 */
export function diagnosticsEnvironment({
  appVersion = null,
  electronVersion = null,
  chromiumVersion = null,
  nodeVersion = null,
  platform = null,
  arch = null,
  cpuModel = null,
  cpuFlags = null,
  packaged = null,
  gpuFeatureStatus = null,
  crashDumpsPath = null,
} = {}) {
  return sanitizeValue({
    appVersion,
    electronVersion,
    chromiumVersion,
    nodeVersion,
    platform,
    arch,
    cpuModel,
    cpuFlags,
    packaged,
    gpuFeatureStatus,
    crashDumpsPath,
  });
}

function rotateIfNeeded(logPath, pendingBytes, maxBytes) {
  let size = 0;
  try {
    size = fs.statSync(logPath).size;
  } catch {
    return;
  }
  if (size + pendingBytes <= maxBytes) {
    return;
  }
  const backup = `${logPath}${DIAGNOSTICS_BACKUP_SUFFIX}`;
  try {
    fs.rmSync(backup, { force: true });
  } catch {
    return;
  }
  try {
    fs.renameSync(logPath, backup);
  } catch {
    // Rotation failed: the append below still tries, keeping the
    // newest event even if the file temporarily exceeds budget.
  }
}

/**
 * Append one JSONL diagnostics event. Never throws: every filesystem
 * failure is swallowed so diagnostics can never crash the app.
 * Returns true when the event was persisted.
 */
export function recordDiagnosticsEvent(userDataPath, event, { now = null, maxBytes = DIAGNOSTICS_MAX_BYTES } = {}) {
  try {
    if (typeof userDataPath !== 'string' || userDataPath === '') {
      return false;
    }
    if (!event || typeof event !== 'object') {
      return false;
    }
    const line = `${JSON.stringify({
      ts: typeof now === 'string' && now !== '' ? now : new Date().toISOString(),
      ...sanitizeValue(event),
    })}\n`;
    fs.mkdirSync(userDataPath, { recursive: true });
    const logPath = diagnosticsLogPath(userDataPath);
    rotateIfNeeded(logPath, Buffer.byteLength(line), maxBytes);
    fs.appendFileSync(logPath, line);
    return true;
  } catch {
    return false;
  }
}
