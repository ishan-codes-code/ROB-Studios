import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applySessionMessage,
  disposeSession,
  routeSessionTarget,
  runStateFromArtifacts,
  updateSessionState,
  useWorkspaceSession,
} from '../src/lib/workspace-sessions.js';
import { createInitialRunState } from '../src/lib/worker-view.js';

function completedListing() {
  return {
    observations: { count: 2, items: [] },
    events: { present: true, invalid: false, count: 1 },
    commentary: { present: true, invalid: false, lines: 3 },
    manifest: { present: true, invalid: false },
    state: { present: true, invalid: false },
    script: { present: true, invalid: false, status: 'success' },
    tts: { present: true, invalid: false, count: 2 },
  };
}

test('routeSessionTarget prefers the tagged project with workspace fallback', () => {
  assert.equal(routeSessionTarget('a', { type: 'progress', projectId: 'b' }), 'b');
  assert.equal(routeSessionTarget('a', { type: 'progress', projectId: null }), 'a');
  assert.equal(routeSessionTarget('a', { type: 'progress' }), 'a');
  assert.equal(routeSessionTarget('a', null), 'a');
  assert.equal(routeSessionTarget(null, { type: 'progress' }), null);
});

test('empty artifacts hydrate to the initial idle state', () => {
  const run = runStateFromArtifacts({ processingStatus: 'idle', listing: null });
  assert.deepEqual(run, createInitialRunState());
});

test('completed projects restore stages, samples, and segments', () => {
  const manifest = {
    observations: 2,
    requests: 2,
    iterations: [
      { timestamp: 0, speed: 'HIGH', reason: 'fast action' },
      { timestamp: 0.5, speed: 'NORMAL', reason: 'calm' },
    ],
  };
  const script = {
    status: 'success',
    segments: [
      { segment_id: 'segment-001', timestamp_seconds: 0, text: 'Hello', source_claim_ids: ['clm-1'] },
      { segment_id: 'segment-002', timestamp_seconds: 4, text: 'World', source_claim_ids: [] },
    ],
  };
  const tts = {
    status: 'success',
    entries: [
      { segment_id: 'segment-001', status: 'success' },
      { segment_id: 'segment-002', status: 'error', error: 'voice failed' },
    ],
  };
  const run = runStateFromArtifacts({ processingStatus: 'done', listing: completedListing(), manifest, script, tts });

  assert.equal(run.status, 'completed');
  assert.equal(run.settled, true);
  assert.deepEqual(run.result, { observations: 2, events: 1, commentary_lines: 3 });
  assert.equal(run.stages.adaptive_vision.status, 'done');
  assert.deepEqual(run.stages.adaptive_vision.detail, { observations: 2, requests: 2 });
  assert.equal(run.stages.state_rebuild.status, 'done');
  assert.equal(run.stages.event_detection.detail.events, 1);
  assert.equal(run.stages.commentary.detail.lines, 3);
  assert.equal(run.stages.script.detail.status, 'success');
  assert.equal(run.stages.tts.detail.succeeded, 1);
  assert.equal(run.stages.tts.detail.failed, 1);
  assert.deepEqual(run.adaptive.samples, [
    { timestamp: 0, speed: 'HIGH', reason: 'fast action', next: 0.5 },
    { timestamp: 0.5, speed: 'NORMAL', reason: 'calm', next: null },
  ]);
  assert.equal(run.script.segments.length, 2);
  assert.deepEqual(run.script.segments[0], {
    utteranceId: 'segment-001',
    timestamp: 0,
    text: 'Hello',
    sourceClaimIds: ['clm-1'],
    priority: null,
    scriptStatus: 'worded',
    ttsStatus: 'success',
    ttsError: null,
  });
  assert.equal(run.script.segments[1].ttsStatus, 'error');
  assert.equal(run.script.segments[1].ttsError, 'voice failed');
  assert.deepEqual(run.workerLogs, []);
});

test('failed runs restore the persisted error without invention', () => {
  const manifest = { observations: 1, requests: 1, iterations: [], error: { phase: 'request-failed', message: 'boom' } };
  const run = runStateFromArtifacts({ processingStatus: 'error', listing: completedListing(), manifest });
  assert.equal(run.status, 'failed');
  assert.deepEqual(run.error, { stage: 'worker', message: 'boom' });

  const generic = runStateFromArtifacts({ processingStatus: 'error', listing: null });
  assert.equal(generic.error.message, 'A previous run failed.');
});

test('interrupted runs restore as failed with an honest message', () => {
  const run = runStateFromArtifacts({ processingStatus: 'interrupted', listing: completedListing() });
  assert.equal(run.status, 'failed');
  assert.equal(run.settled, true);
});

test('processing status restores unsettled so live events attach', () => {
  const run = runStateFromArtifacts({ processingStatus: 'processing', listing: null });
  assert.equal(run.status, 'processing');
  assert.equal(run.settled, false);
});

test('missing artifacts leave stages absent instead of inventing them', () => {
  const run = runStateFromArtifacts({ processingStatus: 'done', listing: null });
  assert.deepEqual(run.stages, {});
  assert.equal(run.script, null);
  assert.equal(run.adaptive, null);
});

test('sessions isolate run state by project id', () => {
  disposeSession('iso-a');
  disposeSession('iso-b');
  try {
    applySessionMessage('iso-a', { type: 'started' });
    applySessionMessage('iso-b', { type: 'started' });
    applySessionMessage('iso-a', { type: 'result', data: { observations: 9 } });
    updateSessionState('iso-a', { adaptiveMaxFrames: 5 });

    // Read back through updater echoes (no DOM needed): patch functions
    // receive the live session.
    let seenA = null;
    let seenB = null;
    updateSessionState('iso-a', (session) => { seenA = session; return {}; });
    updateSessionState('iso-b', (session) => { seenB = session; return {}; });
    assert.equal(seenA.run.status, 'completed');
    assert.equal(seenA.run.result.observations, 9);
    assert.equal(seenA.adaptiveMaxFrames, 5);
    assert.equal(seenB.run.status, 'processing');
    assert.equal(seenB.adaptiveMaxFrames, null);

    disposeSession('iso-a');
    let recreated = null;
    updateSessionState('iso-a', (session) => { recreated = session; return {}; });
    assert.equal(recreated.run.status, 'idle');
    assert.equal(recreated.hydration, 'pending');
  } finally {
    disposeSession('iso-a');
    disposeSession('iso-b');
  }
});

test('session hook is exported for the workspace view', () => {
  assert.equal(typeof useWorkspaceSession, 'function');
});
