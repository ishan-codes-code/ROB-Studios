/**
 * Renderer view-model over structured API activity records.
 *
 * The main process persists paired per-request records
 * (`project-store/api-activity.mjs`) and the worker streams the raw
 * started/terminal events live. Both the Diagnostics dialog and the
 * Processing pipeline read through this module, so summaries can
 * never drift from the detailed history: one pairing rule, one
 * aggregation, one stage derivation.
 */

import { STAGE_ORDER, skipReasonLabel, stageDetailText, stageLabel } from './worker-view.js';

/** Live buffer cap per session; mirrors the main-process retention. */
export const MAX_API_ACTIVITY = 200;

const RECORD_STATUSES = new Set([
  'started',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
]);

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

const VISION_PURPOSES = new Set(['vision', 'vision-adaptive', 'vision-batch']);

function cleanText(value, limit) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed.length > limit ? trimmed.slice(0, limit) : trimmed;
}

function cleanInt(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function cleanMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const safe = {};
  for (const key of Object.keys(value).slice(0, 12)) {
    if (typeof key !== 'string' || key === '') continue;
    const lowered = key.toLowerCase();
    if (/(key|secret|token|auth|credential|image|base64|data_?url|body|payload|prompt|message)/.test(lowered)) {
      continue;
    }
    const text = typeof value[key] === 'string' ? value[key] : String(value[key] ?? '');
    if (text === '') continue;
    safe[key.slice(0, 80)] = text.length > 200 ? text.slice(0, 200) : text;
  }
  return safe;
}

/**
 * Sanitize one persisted record (hydration/IPC payload). Returns null
 * when the entry is unusable; never throws on malformed input.
 */
export function sanitizeActivityRecord(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.id !== 'string' || entry.id === '') return null;
  if (!RECORD_STATUSES.has(entry.status)) return null;
  return {
    id: entry.id,
    projectId: typeof entry.projectId === 'string' ? entry.projectId : null,
    runId: typeof entry.runId === 'string' ? entry.runId : null,
    provider: cleanText(entry.provider, 80) ?? 'unknown',
    purpose: cleanText(entry.purpose, 80) ?? 'unknown',
    model: cleanText(entry.model, 160),
    status: entry.status,
    startedAt: typeof entry.startedAt === 'number' && Number.isFinite(entry.startedAt) ? entry.startedAt : null,
    completedAt: typeof entry.completedAt === 'number' && Number.isFinite(entry.completedAt) ? entry.completedAt : null,
    durationMs: cleanInt(entry.durationMs),
    httpStatus: cleanInt(entry.httpStatus),
    inputTokens: cleanInt(entry.inputTokens),
    outputTokens: cleanInt(entry.outputTokens),
    errorCode: cleanText(entry.errorCode, 80),
    errorMessage: cleanText(entry.errorMessage, 400),
    frameCount: cleanInt(entry.frameCount) ?? 0,
    metadata: cleanMetadata(entry.metadata),
  };
}

/**
 * Fold one live `api_activity` worker message into the session's
 * records. Pairing mirrors the main process: the first start creates
 * the record, the first terminal outcome completes it, repeats and
 * out-of-order lines are absorbed without corrupting state.
 */
export function applyApiActivityEvent(records, message) {
  const list = Array.isArray(records) ? records : [];
  const activity = message?.activity;
  if (!activity || typeof activity !== 'object') return list;
  if (typeof activity.id !== 'string' || activity.id === '') return list;

  if (activity.event === 'started') {
    if (list.some((record) => record.id === activity.id)) return list;
    if (typeof activity.provider !== 'string' || activity.provider.trim() === '') return list;
    if (typeof activity.purpose !== 'string' || activity.purpose.trim() === '') return list;
    if (typeof activity.startedAt !== 'number' || !Number.isFinite(activity.startedAt)) return list;
    const record = {
      id: activity.id,
      projectId: typeof message.projectId === 'string' ? message.projectId : null,
      runId: typeof message.run_id === 'string' ? message.run_id : null,
      provider: activity.provider.trim().slice(0, 80),
      purpose: activity.purpose.trim().slice(0, 80),
      model: cleanText(activity.model, 160),
      status: 'started',
      startedAt: activity.startedAt,
      completedAt: null,
      durationMs: null,
      httpStatus: null,
      inputTokens: null,
      outputTokens: null,
      errorCode: null,
      errorMessage: null,
      frameCount: cleanInt(activity.frameCount) ?? 0,
      metadata: cleanMetadata(activity.metadata),
    };
    return [...list, record].slice(-MAX_API_ACTIVITY);
  }

  if (activity.event === 'terminal') {
    if (!TERMINAL_STATUSES.has(activity.status)) return list;
    const index = list.findIndex((record) => record.id === activity.id);
    const completedAt = typeof activity.completedAt === 'number' && Number.isFinite(activity.completedAt)
      ? activity.completedAt
      : null;
    const durationMs = cleanInt(activity.durationMs);
    if (index === -1) {
      // Terminal without a start (session attached mid-request): keep
      // an honest orphan rather than dropping a real outcome.
      const orphan = {
        id: activity.id,
        projectId: typeof message.projectId === 'string' ? message.projectId : null,
        runId: typeof message.run_id === 'string' ? message.run_id : null,
        provider: cleanText(activity.provider, 80) ?? 'unknown',
        purpose: cleanText(activity.purpose, 80) ?? 'unknown',
        model: cleanText(activity.model, 160),
        status: activity.status,
        startedAt: null,
        completedAt,
        durationMs,
        httpStatus: cleanInt(activity.httpStatus),
        inputTokens: cleanInt(activity.inputTokens),
        outputTokens: cleanInt(activity.outputTokens),
        errorCode: cleanText(activity.errorCode, 80),
        errorMessage: cleanText(activity.errorMessage, 400),
        frameCount: 0,
        metadata: {},
      };
      return [...list, orphan].slice(-MAX_API_ACTIVITY);
    }
    const current = list[index];
    if (current.status !== 'started') return list;
    const merged = { ...current, status: activity.status };
    if (completedAt !== null) merged.completedAt = completedAt;
    if (durationMs !== null) {
      merged.durationMs = durationMs;
    } else if (typeof merged.startedAt === 'number' && typeof merged.completedAt === 'number') {
      merged.durationMs = Math.max(0, merged.completedAt - merged.startedAt);
    }
    const httpStatus = cleanInt(activity.httpStatus);
    if (httpStatus !== null) merged.httpStatus = httpStatus;
    const inputTokens = cleanInt(activity.inputTokens);
    if (inputTokens !== null) merged.inputTokens = inputTokens;
    const outputTokens = cleanInt(activity.outputTokens);
    if (outputTokens !== null) merged.outputTokens = outputTokens;
    const errorCode = cleanText(activity.errorCode, 80);
    if (errorCode !== null) merged.errorCode = errorCode;
    const errorMessage = cleanText(activity.errorMessage, 400);
    if (errorMessage !== null) merged.errorMessage = errorMessage;
    return [...list.slice(0, index), merged, ...list.slice(index + 1)];
  }

  return list;
}

/**
 * Aggregate records into header counts. Token totals only sum
 * provider-reported values; `hasTokens` is false when no record
 * reported usage, so the UI never shows a misleading zero.
 */
export function summarizeActivity(records, purposes = null) {
  const list = Array.isArray(records) ? records : [];
  const wanted = purposes === null ? null : new Set(purposes);
  const summary = {
    total: 0,
    started: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    interrupted: 0,
    totalDurationMs: 0,
    timedRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    hasTokens: false,
  };
  for (const record of list) {
    if (!record || typeof record !== 'object') continue;
    if (wanted && !wanted.has(record.purpose)) continue;
    summary.total += 1;
    if (record.status === 'started') summary.started += 1;
    else if (record.status === 'succeeded') summary.succeeded += 1;
    else if (record.status === 'failed') summary.failed += 1;
    else if (record.status === 'cancelled') summary.cancelled += 1;
    else if (record.status === 'interrupted') summary.interrupted += 1;
    if (typeof record.durationMs === 'number') {
      summary.totalDurationMs += record.durationMs;
      summary.timedRequests += 1;
    }
    if (typeof record.inputTokens === 'number' || typeof record.outputTokens === 'number') {
      summary.hasTokens = true;
      summary.inputTokens += record.inputTokens ?? 0;
      summary.outputTokens += record.outputTokens ?? 0;
    }
  }
  return summary;
}

/** Observed request span (first start to last completion), or null. */
export function activitySpanMs(records) {
  let first = null;
  let last = null;
  for (const record of Array.isArray(records) ? records : []) {
    if (typeof record?.startedAt === 'number') {
      first = first === null ? record.startedAt : Math.min(first, record.startedAt);
    }
    if (typeof record?.completedAt === 'number') {
      last = last === null ? record.completedAt : Math.max(last, record.completedAt);
    }
  }
  if (first === null || last === null || last < first) return null;
  return last - first;
}

export function formatActivityDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${String(rest).padStart(2, '0')}s`;
}

export const PIPELINE_STATUS_LABELS = {
  waiting: 'Waiting',
  running: 'Running',
  completed: 'Done',
  failed: 'Failed',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
};

function recordsFor(records, purposes) {
  const wanted = new Set(purposes);
  return records.filter((record) => wanted.has(record.purpose));
}

/** Bounded failed-error excerpts for expandable stage details. */
function failureExcerpts(stageRecords) {
  const messages = [];
  for (const record of stageRecords) {
    if (record.status !== 'failed' || !record.errorMessage) continue;
    if (!messages.includes(record.errorMessage)) messages.push(record.errorMessage);
    if (messages.length >= 3) break;
  }
  return messages;
}

/**
 * Derive the live pipeline from real run state plus the same activity
 * records Diagnostics shows. Stages are never invented: every row
 * comes from an observed worker stage, the reported current stage, or
 * the TTS inference below (script evidence without a TTS report).
 * Summaries use only observed counts.
 */
export function derivePipelineStages({ run, apiActivity = [], ttsRun = null } = {}) {
  const records = Array.isArray(apiActivity) ? apiActivity : [];
  const stages = run?.stages ?? {};
  const seen = Object.keys(stages);
  const ordered = [
    ...STAGE_ORDER.filter((stage) => seen.includes(stage)),
    ...seen.filter((stage) => !STAGE_ORDER.includes(stage)),
  ];
  if (run?.currentStage && !ordered.includes(run.currentStage)) {
    const at = STAGE_ORDER.indexOf(run.currentStage);
    if (at === -1) {
      ordered.push(run.currentStage);
    } else {
      let inserted = false;
      for (let i = 0; i < ordered.length; i += 1) {
        if (STAGE_ORDER.indexOf(ordered[i]) > at) {
          ordered.splice(i, 0, run.currentStage);
          inserted = true;
          break;
        }
      }
      if (!inserted) ordered.push(run.currentStage);
    }
  }

  // TTS inference: the worker reports the tts stage only when it runs,
  // so script evidence without a report means skipped (settled),
  // queued (accepted mid-run), or undecided (hidden until evidence).
  const ttsRecords = recordsFor(records, ['tts']);
  const scriptSegments = Array.isArray(run?.script?.segments) ? run.script.segments : [];
  const scriptEvidence = stages.script?.status === 'done' || scriptSegments.length > 0;
  const ttsSegmentEvidence = scriptSegments.some((segment) => segment?.ttsStatus);
  const ttsAttempted = ttsRecords.length > 0 || ttsSegmentEvidence;
  if (!ordered.includes('tts') && (ttsAttempted || (scriptEvidence && run?.status !== 'idle' && run?.status !== 'processing'))) {
    ordered.push('tts');
  } else if (!ordered.includes('tts') && scriptEvidence && run?.status === 'processing' && ttsRun && ttsRun.enabled === false) {
    ordered.push('tts');
  }

  const runStatus = run?.status ?? 'idle';
  const errorStage = run?.error?.stage ?? null;

  const views = ordered.map((key) => {
    const info = stages[key] ?? null;
    let status;
    let reason = null;
    if (info?.status === 'done') {
      status = 'completed';
    } else if (info?.status === 'skipped') {
      status = 'skipped';
      reason = skipReasonLabel(info?.detail?.reason) || null;
    } else if (key === 'tts' && info === null) {
      if (runStatus === 'cancelled') {
        status = 'cancelled';
      } else if (runStatus === 'stopped') {
        status = ttsAttempted ? 'interrupted' : 'skipped';
        reason = ttsAttempted ? null : 'Skipped with the stopped run';
      } else if (runStatus === 'failed') {
        status = ttsAttempted ? 'interrupted' : 'skipped';
        reason = ttsAttempted ? null : (typeof ttsRun?.reason === 'string' && ttsRun.reason !== '' ? ttsRun.reason : 'Never started');
      } else if (runStatus === 'completed') {
        status = 'skipped';
        reason = typeof ttsRun?.reason === 'string' && ttsRun.reason !== ''
          ? ttsRun.reason
          : 'No spoken audio was generated';
      } else if (ttsRecords.length > 0
        || scriptSegments.some((segment) => segment?.ttsStatus === 'started')) {
        // Streaming overlap: synthesis is in flight while the worker
        // still reports the script stage.
        status = 'running';
      } else if (ttsRun && ttsRun.enabled === false) {
        status = 'skipped';
        reason = typeof ttsRun.reason === 'string' && ttsRun.reason !== '' ? ttsRun.reason : 'Spoken audio is off for this run';
      } else {
        status = 'waiting';
      }
    } else if (runStatus === 'cancelled') {
      status = 'cancelled';
    } else if (runStatus === 'stopped' || runStatus === 'failed') {
      status = key === errorStage ? 'failed' : 'interrupted';
    } else if (runStatus === 'processing' && key === run.currentStage) {
      status = 'running';
    } else {
      status = 'waiting';
    }

    const view = {
      key,
      label: stageLabel(key),
      status,
      statusLabel: PIPELINE_STATUS_LABELS[status] ?? status,
      reason,
      summary: '',
      detail: null,
      inferred: key === 'tts' && info === null,
    };

    if (key === 'adaptive_vision') {
      const visionRecords = recordsFor(records, [...VISION_PURPOSES]);
      const batches = visionRecords.filter((record) => record.purpose === 'vision-batch').length;
      const observations = run?.adaptive?.observations ?? 0;
      const requests = run?.adaptive?.requests ?? visionRecords.filter((record) => record.status !== 'started').length;
      const parts = [`${observations} observations`, `${requests} requests`];
      if (batches > 0) parts.push(`${batches} HIGH ${batches === 1 ? 'batch' : 'batches'}`);
      view.summary = status === 'waiting' ? '' : parts.join(' · ');
      view.detail = {
        requests: visionRecords.length,
        succeeded: visionRecords.filter((record) => record.status === 'succeeded').length,
        failed: visionRecords.filter((record) => record.status === 'failed').length,
        batches,
        spanMs: activitySpanMs(visionRecords),
        failures: failureExcerpts(visionRecords),
      };
    } else if (key === 'script') {
      const worded = scriptSegments.filter((segment) => segment?.scriptStatus === 'worded').length;
      const superseded = scriptSegments.filter((segment) => segment?.scriptStatus === 'superseded').length;
      const scriptRecords = recordsFor(records, ['script']);
      const parts = [];
      if (scriptSegments.length > 0) {
        parts.push(`${worded} worded`);
        if (superseded > 0) parts.push(`${superseded} superseded`);
      } else {
        const text = stageDetailText(info?.detail);
        if (text) parts.push(text);
      }
      if (scriptRecords.length > 0) {
        parts.push(`${scriptRecords.length} ${scriptRecords.length === 1 ? 'request' : 'requests'}`);
      }
      view.summary = parts.join(' · ');
      view.detail = {
        requests: scriptRecords.length,
        succeeded: scriptRecords.filter((record) => record.status === 'succeeded').length,
        failed: scriptRecords.filter((record) => record.status === 'failed').length,
        spanMs: activitySpanMs(scriptRecords),
        failures: failureExcerpts(scriptRecords),
      };
    } else if (key === 'tts') {
      const done = ttsRecords.filter((record) => record.status === 'succeeded').length;
      const failed = ttsRecords.filter((record) => record.status === 'failed').length;
      const active = ttsRecords.filter((record) => record.status === 'started').length;
      const parts = [];
      if (ttsRecords.length > 0) {
        if (done > 0) parts.push(`${done} ${done === 1 ? 'utterance' : 'utterances'}`);
        if (failed > 0) parts.push(`${failed} failed`);
        if (active > 0) parts.push(`${active} running`);
        if (parts.length === 0) parts.push(`${ttsRecords.length} ${ttsRecords.length === 1 ? 'request' : 'requests'}`);
      } else {
        const text = stageDetailText(info?.detail);
        if (text) parts.push(text);
      }
      if (reason && status === 'skipped') parts.push(reason);
      view.summary = parts.join(' · ');
      view.detail = {
        requests: ttsRecords.length,
        succeeded: done,
        failed,
        spanMs: activitySpanMs(ttsRecords),
        failures: failureExcerpts(ttsRecords),
      };
    } else if (key === 'commentary') {
      const commentaryRecords = recordsFor(records, ['commentary']);
      const parts = [];
      const text = stageDetailText(info?.detail);
      if (text) parts.push(text);
      if (commentaryRecords.length > 0) {
        const failed = commentaryRecords.filter((record) => record.status === 'failed').length;
        parts.push(failed > 0
          ? `${commentaryRecords.length} ${commentaryRecords.length === 1 ? 'request' : 'requests'} · ${failed} failed`
          : `${commentaryRecords.length} ${commentaryRecords.length === 1 ? 'request' : 'requests'}`);
      }
      view.summary = parts.join(' · ');
      view.detail = {
        requests: commentaryRecords.length,
        succeeded: commentaryRecords.filter((record) => record.status === 'succeeded').length,
        failed: commentaryRecords.filter((record) => record.status === 'failed').length,
        spanMs: activitySpanMs(commentaryRecords),
        failures: failureExcerpts(commentaryRecords),
      };
    } else {
      view.summary = stageDetailText(info?.detail);
    }
    return view;
  });

  if (runStatus === 'failed' && views.length > 0
    && !views.some((view) => view.status === 'failed' || view.status === 'running')) {
    // The worker died without staging the error (spawn/worker/exit
    // failures): mark the last observed step so the list reads terminal
    // instead of idle. The error panel below names the true stage.
    views[views.length - 1] = { ...views[views.length - 1], status: 'failed', statusLabel: 'Failed' };
  }
  return views;
}
