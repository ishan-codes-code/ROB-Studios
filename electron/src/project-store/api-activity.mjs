import fs from 'node:fs';
import path from 'node:path';
import { getProjectsRoot, resolveProjectDir } from './metadata.mjs';

// Structured API activity history, owned by the main process. The
// Python worker streams `api_activity` started/terminal event pairs
// (see docs/contracts/worker-protocol.md); settings-level operations
// (credential checks, voice previews) record completed entries
// directly. Records pair by request id and persist per project (plus
// one settings-level file), bounded by retention limits.

export const API_ACTIVITY_FILENAME = 'api-activity.json';
export const MAX_PROJECT_ACTIVITY_RECORDS = 200;
export const MAX_SETTINGS_ACTIVITY_RECORDS = 100;

// Disk writes are throttled during a run; worker exit, app quit, and
// explicit flushes always write dirty scopes immediately.
const FLUSH_THROTTLE_MS = 5000;

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);
const MAX_METADATA_KEYS = 12;
const MAX_METADATA_VALUE_CHARS = 200;

function isRecordId(value) {
  return typeof value === 'string' && value !== '' && value.length <= 120;
}

function cleanString(value, limit) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed.length > limit ? trimmed.slice(0, limit) : trimmed;
}

function cleanNonNegativeInt(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function cleanMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const safe = {};
  for (const key of Object.keys(value).slice(0, MAX_METADATA_KEYS)) {
    if (typeof key !== 'string' || key === '') continue;
    const lowered = key.toLowerCase();
    // Defense in depth: the engine already sanitizes, but persisted
    // history must never become a secret or payload store.
    if (/(key|secret|token|auth|credential|image|base64|data_?url|body|payload|prompt|message)/.test(lowered)) {
      continue;
    }
    const text = typeof value[key] === 'string' ? value[key] : String(value[key] ?? '');
    if (text === '') continue;
    safe[key.slice(0, 80)] = text.length > MAX_METADATA_VALUE_CHARS
      ? text.slice(0, MAX_METADATA_VALUE_CHARS)
      : text;
  }
  return safe;
}

function scopeFile(userDataPath, projectId) {
  if (projectId === null || projectId === undefined) {
    return path.join(userDataPath, API_ACTIVITY_FILENAME);
  }
  const root = getProjectsRoot(userDataPath);
  return path.join(resolveProjectDir(root, projectId), API_ACTIVITY_FILENAME);
}

function scopeLimit(projectId) {
  return projectId === null || projectId === undefined
    ? MAX_SETTINGS_ACTIVITY_RECORDS
    : MAX_PROJECT_ACTIVITY_RECORDS;
}

function writeAtomic(filePath, text) {
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, text);
  fs.renameSync(tmpPath, filePath);
}

function sortKey(record) {
  if (typeof record.startedAt === 'number') return record.startedAt;
  if (typeof record.completedAt === 'number') return record.completedAt;
  return 0;
}

// In-memory scopes: file contents load once, events merge here, and
// dirty scopes flush to disk (throttled mid-run, immediate on
// exit/quit). Keyed by userData + project so tests stay isolated.
const scopes = new Map();

function scopeKey(userDataPath, projectId) {
  return `${userDataPath}::${projectId ?? '\0settings'}`;
}

function normalizeLoadedRecord(entry, projectId, runId) {
  if (!entry || typeof entry !== 'object' || !isRecordId(entry.id)) return null;
  if (!TERMINAL_STATUSES.has(entry.status) && entry.status !== 'started' && entry.status !== 'interrupted') {
    return null;
  }
  const record = {
    id: entry.id,
    projectId: projectId ?? null,
    runId: typeof entry.runId === 'string' ? entry.runId : (runId ?? null),
    provider: cleanString(entry.provider, 80) ?? 'unknown',
    purpose: cleanString(entry.purpose, 80) ?? 'unknown',
    model: cleanString(entry.model, 160),
    status: entry.status,
    startedAt: typeof entry.startedAt === 'number' ? entry.startedAt : null,
    completedAt: typeof entry.completedAt === 'number' ? entry.completedAt : null,
    durationMs: cleanNonNegativeInt(entry.durationMs),
    httpStatus: cleanNonNegativeInt(entry.httpStatus),
    inputTokens: cleanNonNegativeInt(entry.inputTokens),
    outputTokens: cleanNonNegativeInt(entry.outputTokens),
    errorCode: cleanString(entry.errorCode, 80),
    errorMessage: cleanString(entry.errorMessage, 400),
    frameCount: cleanNonNegativeInt(entry.frameCount) ?? 0,
    metadata: cleanMetadata(entry.metadata),
  };
  return record;
}

function ensureScope(userDataPath, projectId) {
  const key = scopeKey(userDataPath, projectId);
  let scope = scopes.get(key);
  if (scope) return scope;
  scope = {
    file: scopeFile(userDataPath, projectId),
    limit: scopeLimit(projectId),
    records: new Map(),
    dirty: false,
    lastFlush: 0,
  };
  try {
    const raw = fs.readFileSync(scope.file, 'utf8');
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed?.records) ? parsed.records : [];
    for (const entry of entries.slice(-scope.limit)) {
      const record = normalizeLoadedRecord(entry, projectId, null);
      if (!record) continue;
      if (record.status === 'started') {
        // A previous process died with this request in flight; it can
        // never complete now. Live in-memory starts are never
        // reconciled — only disk state from a dead process.
        record.status = 'interrupted';
        scope.dirty = true;
      }
      scope.records.set(record.id, record);
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      // Corrupt history never breaks the app: start empty and let the
      // next flush overwrite it.
      scope.dirty = false;
    }
  }
  scopes.set(key, scope);
  return scope;
}

function trimScope(scope) {
  if (scope.records.size <= scope.limit) return;
  const sorted = [...scope.records.values()].sort((a, b) => sortKey(a) - sortKey(b));
  for (const record of sorted.slice(0, sorted.length - scope.limit)) {
    scope.records.delete(record.id);
  }
}

function flushScope(scope, force) {
  if (!scope.dirty) return false;
  const now = Date.now();
  if (!force && now - scope.lastFlush < FLUSH_THROTTLE_MS) return false;
  trimScope(scope);
  const payload = JSON.stringify({
    schema_version: 'api-activity-v1',
    records: [...scope.records.values()].sort((a, b) => sortKey(a) - sortKey(b)),
  });
  try {
    fs.mkdirSync(path.dirname(scope.file), { recursive: true });
    writeAtomic(scope.file, payload);
  } catch {
    // Persistence is best-effort: keep the records in memory and
    // retry on the next flush trigger.
    return false;
  }
  scope.dirty = false;
  scope.lastFlush = now;
  return true;
}

/**
 * Merge one worker `activity` event into its scope. Started events
 * create the record; the matching terminal event completes it. Returns
 * the paired record, or null when the event is malformed (dropped, so
 * diagnostics can never break a run).
 */
export function recordApiActivityEvent(userDataPath, projectId, runId, activity) {
  if (!activity || typeof activity !== 'object' || !isRecordId(activity.id)) {
    return null;
  }
  let scope;
  try {
    scope = ensureScope(userDataPath, projectId ?? null);
  } catch {
    return null;
  }
  const cleanRunId = typeof runId === 'string' && runId !== '' ? runId.slice(0, 120) : null;
  if (activity.event === 'started') {
    const provider = cleanString(activity.provider, 80);
    const purpose = cleanString(activity.purpose, 80);
    if (!provider || !purpose) return null;
    if (typeof activity.startedAt !== 'number' || !Number.isFinite(activity.startedAt)) {
      return null;
    }
    let record = scope.records.get(activity.id);
    if (!record) {
      record = {
        id: activity.id,
        projectId: projectId ?? null,
        runId: cleanRunId,
        provider,
        purpose,
        model: cleanString(activity.model, 160),
        status: 'started',
        startedAt: activity.startedAt,
        completedAt: null,
        durationMs: null,
        httpStatus: null,
        inputTokens: null,
        outputTokens: null,
        errorCode: null,
        errorMessage: null,
        frameCount: cleanNonNegativeInt(activity.frameCount) ?? 0,
        metadata: cleanMetadata(activity.metadata),
      };
      scope.records.set(record.id, record);
    } else if (record.status === 'started') {
      // Duplicate start (worker retry of the report line): keep the
      // first observation, ignore the repeat.
    } else {
      // A late start for an already-terminal record: leave the terminal
      // outcome untouched.
      return record;
    }
    scope.dirty = true;
    trimScope(scope);
    flushScope(scope, false);
    return { ...record };
  }
  if (activity.event === 'terminal') {
    if (!TERMINAL_STATUSES.has(activity.status)) return null;
    let record = scope.records.get(activity.id);
    if (!record) {
      // Terminal without a start (main restarted mid-request, or the
      // start line was lost): keep an honest orphan record rather than
      // dropping a real outcome.
      record = {
        id: activity.id,
        projectId: projectId ?? null,
        runId: cleanRunId,
        provider: cleanString(activity.provider, 80) ?? 'unknown',
        purpose: cleanString(activity.purpose, 80) ?? 'unknown',
        model: cleanString(activity.model, 160),
        status: activity.status,
        startedAt: null,
        completedAt: null,
        durationMs: null,
        httpStatus: null,
        inputTokens: null,
        outputTokens: null,
        errorCode: null,
        errorMessage: null,
        frameCount: 0,
        metadata: {},
      };
      scope.records.set(record.id, record);
    } else if (record.status !== 'started') {
      // Duplicate terminal: the first outcome wins.
      return { ...record };
    } else {
      record.status = activity.status;
    }
    if (typeof activity.completedAt === 'number' && Number.isFinite(activity.completedAt)) {
      record.completedAt = activity.completedAt;
    }
    const duration = cleanNonNegativeInt(activity.durationMs);
    if (duration !== null) {
      record.durationMs = duration;
    } else if (typeof record.startedAt === 'number' && typeof record.completedAt === 'number') {
      record.durationMs = Math.max(0, record.completedAt - record.startedAt);
    }
    const httpStatus = cleanNonNegativeInt(activity.httpStatus);
    if (httpStatus !== null) record.httpStatus = httpStatus;
    const inputTokens = cleanNonNegativeInt(activity.inputTokens);
    if (inputTokens !== null) record.inputTokens = inputTokens;
    const outputTokens = cleanNonNegativeInt(activity.outputTokens);
    if (outputTokens !== null) record.outputTokens = outputTokens;
    const errorCode = cleanString(activity.errorCode, 80);
    if (errorCode !== null) record.errorCode = errorCode;
    const errorMessage = cleanString(activity.errorMessage, 400);
    if (errorMessage !== null) record.errorMessage = errorMessage;
    scope.dirty = true;
    trimScope(scope);
    flushScope(scope, false);
    return { ...record };
  }
  return null;
}

/**
 * Record one finished settings-level operation (credential check,
 * voice preview) that main runs without the worker. No secrets or
 * payloads may travel in `fields.metadata`.
 */
export function recordCompletedActivity(userDataPath, projectId, fields = {}) {
  if (!fields || typeof fields !== 'object') return null;
  const provider = cleanString(fields.provider, 80);
  const purpose = cleanString(fields.purpose, 80);
  if (!provider || !purpose) return null;
  if (!TERMINAL_STATUSES.has(fields.status)) return null;
  let scope;
  try {
    scope = ensureScope(userDataPath, projectId ?? null);
  } catch {
    return null;
  }
  const completedAt = typeof fields.completedAt === 'number' && Number.isFinite(fields.completedAt)
    ? fields.completedAt
    : Date.now();
  const startedAt = typeof fields.startedAt === 'number' && Number.isFinite(fields.startedAt)
    ? fields.startedAt
    : completedAt;
  const record = {
    id: isRecordId(fields.id) ? fields.id : `local-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(16)}`,
    projectId: projectId ?? null,
    runId: null,
    provider,
    purpose,
    model: cleanString(fields.model, 160),
    status: fields.status,
    startedAt,
    completedAt,
    durationMs: cleanNonNegativeInt(fields.durationMs) ?? Math.max(0, completedAt - startedAt),
    httpStatus: cleanNonNegativeInt(fields.httpStatus),
    inputTokens: cleanNonNegativeInt(fields.inputTokens),
    outputTokens: cleanNonNegativeInt(fields.outputTokens),
    errorCode: cleanString(fields.errorCode, 80),
    errorMessage: cleanString(fields.errorMessage, 400),
    frameCount: cleanNonNegativeInt(fields.frameCount) ?? 0,
    metadata: cleanMetadata(fields.metadata),
  };
  scope.records.set(record.id, record);
  scope.dirty = true;
  trimScope(scope);
  flushScope(scope, false);
  return { ...record };
}

/** Chronological (oldest first) activity records for one scope. */
export function getApiActivity(userDataPath, projectId) {
  const scope = ensureScope(userDataPath, projectId ?? null);
  return [...scope.records.values()]
    .sort((a, b) => sortKey(a) - sortKey(b))
    .map((record) => ({ ...record, metadata: { ...record.metadata } }));
}

/** Flush dirty scopes; throttled unless `force` is true. */
export function flushApiActivity(userDataPath, { force = false } = {}) {
  let flushed = 0;
  for (const [key, scope] of scopes) {
    if (!key.startsWith(`${userDataPath}::`)) continue;
    if (flushScope(scope, force)) flushed += 1;
  }
  return flushed;
}

/** Drop one cached scope (project deletion cleans its own file). */
export function dropApiActivityScope(userDataPath, projectId) {
  scopes.delete(scopeKey(userDataPath, projectId ?? null));
}

/** Test-only: clear every cached scope. */
export function _resetApiActivityCache() {
  scopes.clear();
}
