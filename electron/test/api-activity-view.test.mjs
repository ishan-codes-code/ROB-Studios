import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_API_ACTIVITY,
  activitySpanMs,
  applyApiActivityEvent,
  derivePipelineStages,
  formatActivityDuration,
  sanitizeActivityRecord,
  summarizeActivity,
} from '../src/lib/api-activity-view.js';
import { createInitialRunState } from '../src/lib/worker-view.js';

function startedMessage(overrides = {}) {
  return {
    type: 'api_activity',
    run_id: 'run-1',
    projectId: 'proj-1',
    activity: {
      id: 'req-1',
      event: 'started',
      provider: 'baseten',
      purpose: 'vision-batch',
      model: 'm',
      startedAt: 1000,
      frameCount: 3,
      metadata: {},
      ...overrides,
    },
  };
}

function terminalMessage(overrides = {}) {
  return {
    type: 'api_activity',
    run_id: 'run-1',
    projectId: 'proj-1',
    activity: {
      id: 'req-1',
      event: 'terminal',
      status: 'succeeded',
      completedAt: 6000,
      durationMs: 5000,
      httpStatus: 200,
      inputTokens: 10,
      outputTokens: 5,
      ...overrides,
    },
  };
}

function pairedRecord(overrides = {}) {
  return {
    id: 'req-1',
    projectId: 'proj-1',
    runId: 'run-1',
    provider: 'baseten',
    purpose: 'vision-batch',
    model: 'm',
    status: 'succeeded',
    startedAt: 1000,
    completedAt: 6000,
    durationMs: 5000,
    httpStatus: 200,
    inputTokens: 10,
    outputTokens: 5,
    errorCode: null,
    errorMessage: null,
    frameCount: 3,
    metadata: {},
    ...overrides,
  };
}

test('live pairing mirrors the main process: first start and terminal win', () => {
  let records = applyApiActivityEvent([], startedMessage());
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'started');
  assert.equal(records[0].frameCount, 3);
  records = applyApiActivityEvent(records, startedMessage());
  assert.equal(records.length, 1);
  records = applyApiActivityEvent(records, terminalMessage());
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'succeeded');
  assert.equal(records[0].durationMs, 5000);
  records = applyApiActivityEvent(
    records, terminalMessage({ status: 'failed', errorCode: 'late' }),
  );
  assert.equal(records[0].status, 'succeeded');
  assert.equal(records[0].errorCode, null);
});

test('orphan terminals and malformed lines are absorbed safely', () => {
  let records = applyApiActivityEvent([], terminalMessage({ id: 'req-orphan' }));
  assert.equal(records.length, 1);
  assert.equal(records[0].startedAt, null);
  const before = records;
  records = applyApiActivityEvent(records, null);
  records = applyApiActivityEvent(records, { type: 'api_activity' });
  records = applyApiActivityEvent(records, startedMessage({ id: '' }));
  records = applyApiActivityEvent(records, terminalMessage({ status: 'bogus' }));
  assert.equal(records, before);
  assert.equal(records.length, 1);
});

test('live buffer stays bounded', () => {
  let records = [];
  for (let i = 0; i < MAX_API_ACTIVITY + 10; i += 1) {
    records = applyApiActivityEvent(
      records, startedMessage({ id: `req-${i}`, startedAt: 1000 + i }),
    );
  }
  assert.equal(records.length, MAX_API_ACTIVITY);
  assert.equal(records[0].id, 'req-10');
});

test('sanitizeActivityRecord drops unusable hydration entries', () => {
  assert.equal(sanitizeActivityRecord(null), null);
  assert.equal(sanitizeActivityRecord({}), null);
  assert.equal(sanitizeActivityRecord({ id: 'a', status: 'bogus' }), null);
  const record = sanitizeActivityRecord(pairedRecord({ metadata: { api_key: 'x', voice: 'V' } }));
  assert.deepEqual(record.metadata, { voice: 'V' });
});

test('summarizeActivity aggregates one shared source', () => {
  const records = [
    pairedRecord({ id: 'a', purpose: 'vision-batch' }),
    pairedRecord({ id: 'b', purpose: 'tts', status: 'failed', errorCode: 'auth', inputTokens: null, outputTokens: null }),
    pairedRecord({ id: 'c', purpose: 'tts', status: 'started', startedAt: 9000, completedAt: null, durationMs: null }),
  ];
  const all = summarizeActivity(records);
  assert.equal(all.total, 3);
  assert.equal(all.succeeded, 1);
  assert.equal(all.failed, 1);
  assert.equal(all.started, 1);
  assert.equal(all.hasTokens, true);
  assert.equal(all.inputTokens, 20);
  const tts = summarizeActivity(records, ['tts']);
  assert.equal(tts.total, 2);
  assert.equal(tts.succeeded, 0);
  const none = summarizeActivity(records, ['commentary']);
  assert.equal(none.total, 0);
  assert.equal(none.hasTokens, false);
});

test('activitySpanMs measures the observed request window', () => {
  assert.equal(activitySpanMs([]), null);
  assert.equal(activitySpanMs([pairedRecord({ startedAt: null })]), null);
  assert.equal(
    activitySpanMs([
      pairedRecord({ id: 'a', startedAt: 1000, completedAt: 2000 }),
      pairedRecord({ id: 'b', startedAt: 1500, completedAt: 9000 }),
    ]),
    8000,
  );
});

test('formatActivityDuration renders honest magnitudes', () => {
  assert.equal(formatActivityDuration(null), null);
  assert.equal(formatActivityDuration(-5), null);
  assert.equal(formatActivityDuration(250), '250ms');
  assert.equal(formatActivityDuration(1500), '1.5s');
  assert.equal(formatActivityDuration(48000), '48s');
  assert.equal(formatActivityDuration(125000), '2m 05s');
});

function processingRun(overrides = {}) {
  return {
    ...createInitialRunState(),
    status: 'processing',
    settled: false,
    currentStage: 'adaptive_vision',
    ...overrides,
  };
}

test('pipeline derives vision summaries from the same records', () => {
  const run = processingRun({
    adaptive: { samples: [], observations: 16, requests: 20 },
  });
  const records = [
    pairedRecord({ id: 'a', purpose: 'vision-batch', frameCount: 3 }),
    pairedRecord({ id: 'b', purpose: 'vision-adaptive', frameCount: 1, startedAt: 7000, completedAt: 9000, durationMs: 2000 }),
  ];
  const views = derivePipelineStages({ run, apiActivity: records });
  assert.equal(views.length, 1);
  assert.equal(views[0].key, 'adaptive_vision');
  assert.equal(views[0].status, 'running');
  assert.equal(views[0].summary, '16 observations · 20 requests · 1 HIGH batch');
  assert.equal(views[0].detail.requests, 2);
  assert.equal(views[0].detail.batches, 1);
  assert.equal(views[0].detail.spanMs, 8000);
});

test('completed stages keep worker counts; failures attach honestly', () => {
  const run = processingRun({
    status: 'failed',
    currentStage: null,
    stages: {
      adaptive_vision: { status: 'done', detail: { observations: 4, requests: 4 } },
      state_rebuild: { status: 'done', detail: null },
    },
    error: { stage: 'event_detection', message: 'boom' },
  });
  const views = derivePipelineStages({ run, apiActivity: [] });
  // The worker named an unobserved stage: finished steps keep their
  // outcome while the last observed step reads terminal (the error
  // panel below keeps the true stage).
  assert.deepEqual(views.map((view) => [view.key, view.status]), [
    ['adaptive_vision', 'completed'],
    ['state_rebuild', 'failed'],
  ]);
});

test('tts infers skipped with the accept reason on completed runs', () => {
  const run = {
    ...createInitialRunState(),
    status: 'completed',
    stages: {
      adaptive_vision: { status: 'done', detail: { observations: 2, requests: 2 } },
      script: { status: 'done', detail: { status: 'success' } },
    },
  };
  const ttsRun = { enabled: false, reason: 'No TTS credential configured.' };
  const views = derivePipelineStages({ run, apiActivity: [], ttsRun });
  const tts = views.find((view) => view.key === 'tts');
  assert.ok(tts);
  assert.equal(tts.status, 'skipped');
  assert.equal(tts.inferred, true);
  assert.match(tts.summary, /No TTS credential configured/);
});

test('tts without script evidence stays hidden', () => {
  const run = processingRun({
    stages: { adaptive_vision: { status: 'done', detail: null } },
    currentStage: 'state_rebuild',
  });
  const views = derivePipelineStages({ run, apiActivity: [], ttsRun: { enabled: false, reason: 'off' } });
  assert.ok(!views.some((view) => view.key === 'tts'));
});

test('streaming tts overlap reads running while script is current', () => {
  const run = processingRun({
    currentStage: 'script',
    stages: { adaptive_vision: { status: 'done', detail: null } },
    script: {
      segments: [
        { utteranceId: 'u-0001', ttsStatus: 'started' },
        { utteranceId: 'u-0002', ttsStatus: 'success' },
      ],
    },
  });
  const views = derivePipelineStages({ run, apiActivity: [], ttsRun: { enabled: true, reason: null } });
  const byKey = Object.fromEntries(views.map((view) => [view.key, view]));
  assert.equal(byKey.script.status, 'running');
  assert.equal(byKey.tts.status, 'running');
  assert.equal(byKey.script.summary, '0 worded');
});

test('tts utterance counts come from activity records', () => {
  const run = processingRun({
    currentStage: 'tts',
    stages: { script: { status: 'done', detail: null } },
  });
  const records = [
    pairedRecord({ id: 'a', purpose: 'tts', frameCount: 0 }),
    pairedRecord({ id: 'b', purpose: 'tts', frameCount: 0, status: 'failed', errorCode: 'quota', errorMessage: 'slow down' }),
    pairedRecord({ id: 'c', purpose: 'tts', frameCount: 0, status: 'started', startedAt: 9500, completedAt: null, durationMs: null }),
  ];
  const views = derivePipelineStages({ run, apiActivity: records });
  const tts = views.find((view) => view.key === 'tts');
  assert.equal(tts.status, 'running');
  assert.equal(tts.summary, '1 utterance · 1 failed · 1 running');
  assert.deepEqual(tts.detail.failures, ['slow down']);
});

test('cancelled runs mark unfinished stages cancelled', () => {
  const run = {
    ...createInitialRunState(),
    status: 'cancelled',
    currentStage: 'state_rebuild',
    stages: { adaptive_vision: { status: 'done', detail: null } },
  };
  const views = derivePipelineStages({ run, apiActivity: [] });
  assert.deepEqual(views.map((view) => [view.key, view.status]), [
    ['adaptive_vision', 'completed'],
    ['state_rebuild', 'cancelled'],
  ]);
});

test('idle runs render no pipeline', () => {
  assert.deepEqual(derivePipelineStages({ run: createInitialRunState(), apiActivity: [] }), []);
});
