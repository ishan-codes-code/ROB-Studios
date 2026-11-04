import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  MAX_PROJECT_ACTIVITY_RECORDS,
  MAX_SETTINGS_ACTIVITY_RECORDS,
  _resetApiActivityCache,
  dropApiActivityScope,
  flushApiActivity,
  getApiActivity,
  recordApiActivityEvent,
  recordCompletedActivity,
} from '../src/project-store/api-activity.mjs';

let rootCounter = 0;

function makeUserData() {
  rootCounter += 1;
  const base = fs.mkdtempSync(
    path.join(os.tmpdir(), `ai-activity-${process.pid}-${rootCounter}-`),
  );
  return { base, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

function startedEvent(overrides = {}) {
  return {
    id: 'req-1',
    event: 'started',
    provider: 'baseten',
    purpose: 'vision-batch',
    model: 'meta-models/muse-spark-open',
    startedAt: 1700000000000,
    frameCount: 3,
    metadata: {},
    ...overrides,
  };
}

function terminalEvent(overrides = {}) {
  return {
    id: 'req-1',
    event: 'terminal',
    status: 'succeeded',
    completedAt: 1700000005000,
    durationMs: 5000,
    httpStatus: 200,
    inputTokens: 100,
    outputTokens: 50,
    ...overrides,
  };
}

test('started then terminal pair into one record', () => {
  const { base, cleanup } = makeUserData();
  try {
    _resetApiActivityCache();
    const started = recordApiActivityEvent(base, 'proj-1', 'run-1', startedEvent());
    assert.equal(started.status, 'started');
    assert.equal(started.provider, 'baseten');
    assert.equal(started.frameCount, 3);
    const done = recordApiActivityEvent(base, 'proj-1', 'run-1', terminalEvent());
    assert.equal(done.status, 'succeeded');
    assert.equal(done.durationMs, 5000);
    assert.equal(done.httpStatus, 200);
    assert.equal(done.inputTokens, 100);
    const records = getApiActivity(base, 'proj-1');
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'succeeded');
    assert.equal(records[0].runId, 'run-1');
    assert.equal(records[0].projectId, 'proj-1');
  } finally {
    cleanup();
  }
});

test('duplicate terminals and starts keep the first outcome', () => {
  const { base, cleanup } = makeUserData();
  try {
    _resetApiActivityCache();
    recordApiActivityEvent(base, 'proj-1', 'run-1', startedEvent());
    recordApiActivityEvent(base, 'proj-1', 'run-1', startedEvent());
    recordApiActivityEvent(base, 'proj-1', 'run-1', terminalEvent());
    const again = recordApiActivityEvent(
      base, 'proj-1', 'run-1', terminalEvent({ status: 'failed', errorCode: 'x' }),
    );
    assert.equal(again.status, 'succeeded');
    assert.equal(getApiActivity(base, 'proj-1').length, 1);
  } finally {
    cleanup();
  }
});

test('orphan terminal keeps an honest record instead of dropping', () => {
  const { base, cleanup } = makeUserData();
  try {
    _resetApiActivityCache();
    const record = recordApiActivityEvent(base, 'proj-1', 'run-9', terminalEvent({ id: 'req-orphan' }));
    assert.equal(record.status, 'succeeded');
    assert.equal(record.startedAt, null);
    assert.equal(getApiActivity(base, 'proj-1').length, 1);
  } finally {
    cleanup();
  }
});

test('malformed events are dropped without throwing', () => {
  const { base, cleanup } = makeUserData();
  try {
    _resetApiActivityCache();
    assert.equal(recordApiActivityEvent(base, 'proj-1', 'run-1', null), null);
    assert.equal(recordApiActivityEvent(base, 'proj-1', 'run-1', { id: '', event: 'started' }), null);
    assert.equal(recordApiActivityEvent(base, 'proj-1', 'run-1', startedEvent({ provider: '' })), null);
    assert.equal(recordApiActivityEvent(base, 'proj-1', 'run-1', terminalEvent({ status: 'bogus' })), null);
    assert.deepEqual(getApiActivity(base, 'proj-1'), []);
  } finally {
    cleanup();
  }
});

test('secret-bearing metadata never persists', () => {
  const { base, cleanup } = makeUserData();
  try {
    _resetApiActivityCache();
    const record = recordApiActivityEvent(base, 'proj-1', 'run-1', startedEvent({
      metadata: {
        voice: 'Aoede',
        api_key: 'sk-secret',
        image_data_url: 'data:image/png;base64,AAA',
        prompt: 'describe this',
      },
    }));
    assert.deepEqual(record.metadata, { voice: 'Aoede' });
  } finally {
    cleanup();
  }
});

test('project scopes stay isolated from each other and settings', () => {
  const { base, cleanup } = makeUserData();
  try {
    _resetApiActivityCache();
    recordApiActivityEvent(base, 'proj-1', 'run-1', startedEvent({ id: 'req-a' }));
    recordApiActivityEvent(base, 'proj-2', 'run-2', startedEvent({ id: 'req-b' }));
    recordCompletedActivity(base, null, {
      provider: 'baseten', purpose: 'verify-vision', status: 'succeeded',
    });
    assert.deepEqual(getApiActivity(base, 'proj-1').map((record) => record.id), ['req-a']);
    assert.deepEqual(getApiActivity(base, 'proj-2').map((record) => record.id), ['req-b']);
    const settings = getApiActivity(base, null);
    assert.equal(settings.length, 1);
    assert.equal(settings[0].purpose, 'verify-vision');
    assert.equal(settings[0].projectId, null);
  } finally {
    cleanup();
  }
});

test('retention trims oldest records first', () => {
  const { base, cleanup } = makeUserData();
  try {
    _resetApiActivityCache();
    for (let i = 0; i < MAX_PROJECT_ACTIVITY_RECORDS + 10; i += 1) {
      const id = `req-${String(i).padStart(4, '0')}`;
      recordApiActivityEvent(base, 'proj-1', 'run-1', startedEvent({ id, startedAt: 1700000000000 + i }));
      recordApiActivityEvent(base, 'proj-1', 'run-1', terminalEvent({ id }));
    }
    const records = getApiActivity(base, 'proj-1');
    assert.equal(records.length, MAX_PROJECT_ACTIVITY_RECORDS);
    assert.equal(records[0].id, 'req-0010');
    assert.equal(records[records.length - 1].id, `req-${String(MAX_PROJECT_ACTIVITY_RECORDS + 9).padStart(4, '0')}`);
  } finally {
    cleanup();
  }
});

test('settings retention is tighter than project retention', () => {
  assert.ok(MAX_SETTINGS_ACTIVITY_RECORDS < MAX_PROJECT_ACTIVITY_RECORDS);
  const { base, cleanup } = makeUserData();
  try {
    _resetApiActivityCache();
    for (let i = 0; i < MAX_SETTINGS_ACTIVITY_RECORDS + 5; i += 1) {
      recordCompletedActivity(base, null, {
        id: `local-${i}`, provider: 'custom', purpose: 'list-models', status: 'succeeded',
        startedAt: 1700000000000 + i, completedAt: 1700000000000 + i,
      });
    }
    assert.equal(getApiActivity(base, null).length, MAX_SETTINGS_ACTIVITY_RECORDS);
  } finally {
    cleanup();
  }
});

test('interrupted requests reconcile on reload, never while live', () => {
  const { base, cleanup } = makeUserData();
  try {
    _resetApiActivityCache();
    recordApiActivityEvent(base, 'proj-1', 'run-1', startedEvent({ id: 'req-live' }));
    // Still live in this process: no reconciliation.
    assert.equal(getApiActivity(base, 'proj-1')[0].status, 'started');
    flushApiActivity(base, { force: true });
    // Simulate a restart: a fresh cache loads the file and reconciles.
    _resetApiActivityCache();
    const records = getApiActivity(base, 'proj-1');
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'interrupted');
  } finally {
    cleanup();
  }
});

test('completed records survive a flush and reload cycle', () => {
  const { base, cleanup } = makeUserData();
  try {
    _resetApiActivityCache();
    recordApiActivityEvent(base, 'proj-1', 'run-1', startedEvent());
    recordApiActivityEvent(base, 'proj-1', 'run-1', terminalEvent());
    flushApiActivity(base, { force: true });
    assert.ok(fs.existsSync(path.join(base, 'projects', 'proj-1', 'api-activity.json')));
    _resetApiActivityCache();
    const records = getApiActivity(base, 'proj-1');
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'succeeded');
    assert.equal(records[0].outputTokens, 50);
  } finally {
    cleanup();
  }
});

test('dropApiActivityScope clears cached history', () => {
  const { base, cleanup } = makeUserData();
  try {
    _resetApiActivityCache();
    recordApiActivityEvent(base, 'proj-1', 'run-1', startedEvent());
    recordApiActivityEvent(base, 'proj-1', 'run-1', terminalEvent());
    flushApiActivity(base, { force: true });
    assert.equal(getApiActivity(base, 'proj-1').length, 1);
    // Project deletion removes the directory, then drops the scope:
    // a recreated id must never see the stale cached records.
    fs.rmSync(path.join(base, 'projects', 'proj-1'), { recursive: true, force: true });
    dropApiActivityScope(base, 'proj-1');
    assert.deepEqual(getApiActivity(base, 'proj-1'), []);
  } finally {
    cleanup();
  }
});

test('recordCompletedActivity validates its fields', () => {
  const { base, cleanup } = makeUserData();
  try {
    _resetApiActivityCache();
    assert.equal(recordCompletedActivity(base, null, null), null);
    assert.equal(recordCompletedActivity(base, null, { provider: 'x', purpose: 'y', status: 'bogus' }), null);
    assert.equal(recordCompletedActivity(base, null, { purpose: 'y', status: 'succeeded' }), null);
    const record = recordCompletedActivity(base, null, {
      provider: 'google-gemini-tts',
      purpose: 'voice-preview',
      model: 'gemini-tts-1',
      status: 'failed',
      startedAt: 1000,
      completedAt: 2500,
      errorCode: 'preview-failed',
      errorMessage: 'no audio',
      metadata: { voice: 'Aoede' },
    });
    assert.equal(record.status, 'failed');
    assert.equal(record.durationMs, 1500);
    assert.equal(record.errorCode, 'preview-failed');
    assert.equal(record.runId, null);
  } finally {
    cleanup();
  }
});

test('corrupt history files degrade to empty instead of throwing', () => {
  const { base, cleanup } = makeUserData();
  try {
    _resetApiActivityCache();
    fs.mkdirSync(path.join(base, 'projects', 'proj-1'), { recursive: true });
    fs.writeFileSync(path.join(base, 'projects', 'proj-1', 'api-activity.json'), '{not json');
    assert.deepEqual(getApiActivity(base, 'proj-1'), []);
  } finally {
    cleanup();
  }
});
