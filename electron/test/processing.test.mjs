import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { registerProcessingIpc } from '../src/main/ipc/processing.js';
import { createProject, getProject, updateProject } from '../src/project-store.mjs';
import { createCredential, markCredentialVerified, setDevBypassEnabled } from '../src/credentials-store.mjs';

// Real repo root so resolvePythonExecutable/resolveWorkerScript find the
// checked-in .venv layout and worker script; the fake manager never spawns.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

let rootCounter = 0;

function makeUserData(t) {
  rootCounter += 1;
  const base = fs.mkdtempSync(
    path.join(os.tmpdir(), `ai-commentator-stop-ipc-${process.pid}-${rootCounter}-`),
  );
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}

function makeFixtureVideo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'clip.mp4');
  fs.writeFileSync(file, Buffer.alloc(1024, 7));
  return file;
}

const testSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (v) => Buffer.from(`enc:${Buffer.from(String(v), 'utf8').toString('base64')}`, 'utf8'),
  decryptString: (buf) => Buffer.from(String(buf == null ? '' : buf).replace(/^enc:/, ''), 'base64').toString('utf8'),
};

function setup(t, { requestStopResult, ttsCatalog = null, safeStorage = testSafeStorage } = {}) {
  const userData = makeUserData(t);
  const handlers = {};
  const ipcMain = {
    handle: (name, fn) => {
      handlers[name] = fn;
    },
  };
  const app = { getPath: (name) => {
    assert.equal(name, 'userData');
    return userData;
  } };
  const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) };
  const fakeFs = { statSync: () => ({ size: 8 }) };
  let captured = null;
  const workerManager = {
    isBusy: () => false,
    start: (calls) => {
      captured = calls;
      return { started: true, pid: 1 };
    },
    // Explicit undefined check: `??` would swallow an intentionally null
    // result that the malformed-result test needs to exercise.
    requestStop: () => (requestStopResult === undefined
      ? { requested: false, reason: 'no-active-job' }
      : requestStopResult),
    cancel: async () => false,
  };
  const state = { activeProjectId: null, appQuitting: false };
  const events = [];
  registerProcessingIpc({
    ipcMain,
    app,
    dialog,
    fs: fakeFs,
    safeStorage,
    workerManager,
    state,
    repoRoot: () => repoRoot,
    sendWorkerEvent: (message) => events.push(message),
    getMainWindow: () => null,
    ttsCatalogLoader: ttsCatalog ? { load: async () => ttsCatalog, reset: () => {} } : null,
  });
  return { userData, handlers, workerManager, state, events, getStart: () => captured };
}

async function startRun(t, setupResult, videoPath, options) {
  const video = videoPath ?? makeFixtureVideo(path.join(setupResult.userData, 'incoming'));
  // Every run is paid now: select a verified vault credential so the
  // fake manager (which never spawns) starts the job. No request can
  // leave the machine.
  startRun.credentialCounter = (startRun.credentialCounter ?? 0) + 1;
  const credential = createCredential(setupResult.userData, testSafeStorage, {
    name: `Stop Test ${startRun.credentialCounter}`, provider: 'meta', model: 'muse-spark-1.3', key: 'test-dummy-key',
  });
  markCredentialVerified(setupResult.userData, testSafeStorage, credential.id, credential.model);
  const project = createProject(setupResult.userData, { name: 'stop test', sourcePath: video });
  updateProject(setupResult.userData, project.id, { configuration: { credentialId: credential.id } });
  // ipcMain passes the event first.
  const started = await setupResult.handlers['process-video'](
    {}, video, { adaptive: true, projectId: project.id, ...(options ?? {}) },
  );
  assert.equal(started.ok, true);
  // Mirror the renderer: a started run marks its project processing, which
  // is the state the terminal onExit settlement settles from.
  updateProject(setupResult.userData, project.id, { processingStatus: 'processing' });
  return project.id;
}

test('request-stop reports no active job', async (t) => {
  const s = setup(t);
  assert.deepEqual(await s.handlers['request-stop'](), {
    ok: true,
    requested: false,
    reason: 'no-active-job',
  });
});

test('request-stop forwards an accepted request', async (t) => {
  const s = setup(t, { requestStopResult: { requested: true, reason: 'stop-requested' } });
  assert.deepEqual(await s.handlers['request-stop'](), {
    ok: true,
    requested: true,
    reason: 'stop-requested',
  });
});

test('request-stop reports undeliverable requests without internals', async (t) => {
  const s = setup(t, { requestStopResult: { requested: false, reason: 'stdin-unavailable' } });
  assert.deepEqual(await s.handlers['request-stop'](), {
    ok: true,
    requested: false,
    reason: 'stdin-unavailable',
  });
});

test('request-stop survives a throwing manager', async (t) => {
  const s = setup(t);
  s.workerManager.requestStop = () => {
    throw new Error('boom');
  };
  assert.deepEqual(await s.handlers['request-stop'](), {
    ok: false,
    error: 'Stop request failed.',
  });
});

test('request-stop rejects malformed manager results', async (t) => {
  const s = setup(t, { requestStopResult: null });
  assert.deepEqual(await s.handlers['request-stop'](), {
    ok: false,
    error: 'Stop request failed.',
  });
});

test('a stopped run settles the project as stopped', async (t) => {
  const s = setup(t);
  const projectId = await startRun(t, s);
  const start = s.getStart();
  start.onMessage({ type: 'started', message: 'Processing video clip.mp4' });
  start.onMessage({ type: 'stopped', data: { status: 'stopped' } });
  start.onExit({ code: 0, signal: null, cancelled: false });
  assert.equal(getProject(s.userData, projectId).processingStatus, 'stopped');
  assert.deepEqual(
    s.events.filter((m) => m.type === 'stopped'),
    [{ type: 'stopped', data: { status: 'stopped' } }],
  );
});

test('a completed run still settles as done', async (t) => {
  const s = setup(t);
  const projectId = await startRun(t, s);
  const start = s.getStart();
  start.onMessage({ type: 'result', data: {} });
  start.onExit({ code: 0, signal: null, cancelled: false });
  assert.equal(getProject(s.userData, projectId).processingStatus, 'done');
});

test('a cancelled run still settles as cancelled', async (t) => {
  const s = setup(t);
  const projectId = await startRun(t, s);
  const start = s.getStart();
  start.onExit({ code: null, signal: 'SIGTERM', cancelled: true });
  assert.equal(getProject(s.userData, projectId).processingStatus, 'cancelled');
});

test('a stopped flag does not leak into the next run', async (t) => {
  const s = setup(t);
  const firstId = await startRun(t, s);
  const first = s.getStart();
  first.onMessage({ type: 'stopped', data: { status: 'stopped' } });
  first.onExit({ code: 0, signal: null, cancelled: false });
  assert.equal(getProject(s.userData, firstId).processingStatus, 'stopped');
  const secondId = await startRun(t, s);
  const second = s.getStart();
  second.onExit({ code: 0, signal: null, cancelled: false });
  assert.equal(getProject(s.userData, secondId).processingStatus, 'done');
});

test('quitting still settles as interrupted after a stop', async (t) => {
  const s = setup(t);
  const projectId = await startRun(t, s);
  const start = s.getStart();
  start.onMessage({ type: 'stopped', data: { status: 'stopped' } });
  s.state.appQuitting = true;
  start.onExit({ code: 0, signal: null, cancelled: false });
  assert.equal(getProject(s.userData, projectId).processingStatus, 'interrupted');
});

test('an adaptive run carries sampling bounds and settles stopped', async (t) => {
  const s = setup(t);
  // Paid project runs use the project's selected vault credential -
  // never an ambient environment key. The fake manager never spawns,
  // so no request can leave the machine.
  const credential = createCredential(s.userData, testSafeStorage, {
    name: 'Meta Test', provider: 'meta', model: 'muse-spark-1.3', key: 'test-dummy-key',
  });
  markCredentialVerified(s.userData, testSafeStorage, credential.id, credential.model);
  const video = makeFixtureVideo(path.join(s.userData, 'incoming'));
  const draft = createProject(s.userData, { name: 'adaptive test', sourcePath: video });
  updateProject(s.userData, draft.id, { configuration: { credentialId: credential.id } });
  const started = await s.handlers['process-video'](
    {}, video, { projectId: draft.id, adaptive: true, adaptiveMaxFrames: 5 },
  );
  assert.equal(started.ok, true);
  updateProject(s.userData, draft.id, { processingStatus: 'processing' });
  const projectId = draft.id;
  const start = s.getStart();
  assert.ok(start.argv.includes('--adaptive'));
  assert.equal(start.argv.includes('test-dummy-key'), false);
  assert.equal(start.env?.AI_COMMENTATOR_PROVIDER, 'meta');
  assert.equal(start.env?.AI_COMMENTATOR_MODEL, 'muse-spark-1.3');
  assert.equal(start.env?.AI_COMMENTATOR_API_KEY, 'test-dummy-key');
  const flagAt = start.argv.indexOf('--adaptive-max-frames');
  assert.notEqual(flagAt, -1);
  assert.equal(start.argv[flagAt + 1], '5');
  start.onMessage({ type: 'started', message: 'Processing video clip.mp4' });
  start.onMessage({
    type: 'adaptive_sample',
    data: {
      timestamp: 0,
      speed: 'HIGH',
      reason: 'Fast.',
      next_timestamp: 0.5,
      observations: 1,
      requests: 1,
    },
  });
  start.onMessage({ type: 'stopped', data: { status: 'stopped' } });
  start.onExit({ code: 0, signal: null, cancelled: false });
  assert.equal(getProject(s.userData, projectId).processingStatus, 'stopped');
});

test('a paid project run without a selected credential fails closed', async (t) => {
  const s = setup(t);
  const video = makeFixtureVideo(path.join(s.userData, 'incoming'));
  const project = createProject(s.userData, { name: 'unconfigured', sourcePath: video });
  const started = await s.handlers['process-video'](
    {}, video, { projectId: project.id, adaptive: true, adaptiveMaxFrames: 2 },
  );
  assert.equal(started.ok, false);
  assert.match(started.error, /no API configuration/i);
  assert.equal(s.getStart(), null);
});

test('stop-request IPC acceptance does not settle the run by itself', async (t) => {
  const s = setup(t, { requestStopResult: { requested: true, reason: 'stop-requested' } });
  const accepted = await s.handlers['request-stop']();
  assert.deepEqual(accepted, { ok: true, requested: true, reason: 'stop-requested' });
  // No run exists, so nothing settled: acceptance is not completion.
  assert.equal(s.state.activeProjectId, null);
});

const TTS_CATALOG = {
  models: [
    { id: 'gemini-3.8-flash-tts', description: '' },
    { id: 'gemini-3.8-flash-lite-tts', description: '' },
  ],
  voices: [{ id: 'Kore', character: '' }, { id: 'Fenrir', character: '' }],
  defaults: { model: 'gemini-3.8-flash-tts', voice: 'Kore', voiceDirection: 'Default style.' },
  limits: { voiceMaxLength: 64, voiceDirectionMaxLength: 500 },
};

function seedTtsProject(userData, { voice = null } = {}) {
  const vision = createCredential(userData, testSafeStorage, {
    name: 'Vision', provider: 'meta', model: 'muse-spark-1.3', key: 'vision-run-key',
  });
  markCredentialVerified(userData, testSafeStorage, vision.id, vision.model);
  const tts = createCredential(userData, testSafeStorage, {
    name: 'TTS', provider: 'google-gemini-tts', model: null, key: 'tts-run-key',
  });
  markCredentialVerified(userData, testSafeStorage, tts.id, null);
  const video = makeFixtureVideo(path.join(userData, 'incoming'));
  const project = createProject(userData, { name: 'tts run', sourcePath: video });
  updateProject(userData, project.id, {
    configuration: {
      credentialId: vision.id,
      tts: { voice, voiceDirection: null, model: null, credentialId: tts.id },
    },
  });
  return project;
}

test('TTS run passes resolved config argv and injects the vault key only', async (t) => {
  const s = setup(t, { ttsCatalog: TTS_CATALOG });
  const project = seedTtsProject(s.userData, { voice: 'Fenrir' });
  const started = await s.handlers['process-video'](
    {}, project.sourceVideo.path,
    {
      projectId: project.id, adaptive: true, withScript: true, requestTts: true,
      // Renderer-supplied TTS values must never reach the worker.
      generateTts: false, ttsVoice: 'Evil', ttsModel: 'evil-model', ttsVoiceDirection: 'evil',
    },
  );
  assert.equal(started.ok, true);
  const { argv, env } = s.getStart();
  assert.ok(argv.includes('--with-script'));
  assert.ok(argv.includes('--generate-tts'));
  const valueOf = (flag) => argv[argv.indexOf(flag) + 1];
  assert.equal(valueOf('--tts-model'), 'gemini-3.8-flash-tts');
  assert.equal(valueOf('--tts-voice'), 'Fenrir');
  assert.equal(valueOf('--tts-voice-direction'), 'Default style.');
  assert.equal(argv.join(' ').includes('Evil'), false);
  assert.equal(env.AI_COMMENTATOR_PROVIDER_API_KEY, 'tts-run-key');
  assert.equal(env.AI_COMMENTATOR_API_KEY, 'vision-run-key');
});

test('plain runs carry no TTS key or flags', async (t) => {
  const s = setup(t, { ttsCatalog: TTS_CATALOG });
  const project = seedTtsProject(s.userData);
  const started = await s.handlers['process-video'](
    {}, project.sourceVideo.path, { projectId: project.id, adaptive: true },
  );
  assert.equal(started.ok, true);
  const { argv, env } = s.getStart();
  assert.equal(argv.includes('--generate-tts'), false);
  assert.equal('AI_COMMENTATOR_PROVIDER_API_KEY' in env, false);
});

test('TTS run without the script or credential fails before spawning', async (t) => {
  const s = setup(t, { ttsCatalog: TTS_CATALOG });
  const project = seedTtsProject(s.userData);
  const noScript = await s.handlers['process-video'](
    {}, project.sourceVideo.path, { projectId: project.id, adaptive: true, requestTts: true },
  );
  assert.equal(noScript.ok, false);
  assert.match(noScript.error, /final casting script/);
  assert.equal(s.getStart(), null);

  updateProject(s.userData, project.id, { configuration: { tts: { credentialId: null } } });
  const noCredential = await s.handlers['process-video'](
    {}, project.sourceVideo.path,
    { projectId: project.id, adaptive: true, withScript: true, requestTts: true },
  );
  assert.equal(noCredential.ok, false);
  assert.match(noCredential.error, /no TTS credential selected/);
  assert.equal(s.getStart(), null);
});

test('TTS run with dev-bypass memory credentials injects keys via env only', async (t) => {
  const downStorage = {
    isEncryptionAvailable: () => false,
    encryptString: () => { throw new Error('no encryption'); },
    decryptString: () => { throw new Error('no encryption'); },
  };
  const s = setup(t, { ttsCatalog: TTS_CATALOG, safeStorage: downStorage });
  t.after(() => setDevBypassEnabled(false, { isPackaged: false }));
  setDevBypassEnabled(true, { isPackaged: false });
  const vision = createCredential(s.userData, downStorage, {
    name: 'Vision', provider: 'meta', model: 'muse-spark-1.3', key: 'memory-vision-key',
  });
  markCredentialVerified(s.userData, downStorage, vision.id, vision.model);
  const tts = createCredential(s.userData, downStorage, {
    name: 'TTS', provider: 'google-gemini-tts', model: null, key: 'memory-tts-key',
  });
  markCredentialVerified(s.userData, downStorage, tts.id, null);
  const video = makeFixtureVideo(path.join(s.userData, 'incoming'));
  const project = createProject(s.userData, { name: 'bypass run', sourcePath: video });
  updateProject(s.userData, project.id, {
    configuration: { credentialId: vision.id, tts: { credentialId: tts.id } },
  });
  const started = await s.handlers['process-video'](
    {}, project.sourceVideo.path,
    { projectId: project.id, adaptive: true, withScript: true, requestTts: true },
  );
  assert.equal(started.ok, true);
  const { argv, env } = s.getStart();
  assert.ok(argv.includes('--generate-tts'));
  assert.equal(argv.join(' ').includes('memory-tts-key'), false);
  assert.equal(argv.join(' ').includes('memory-vision-key'), false);
  assert.equal(env.AI_COMMENTATOR_PROVIDER_API_KEY, 'memory-tts-key');
  assert.equal(env.AI_COMMENTATOR_API_KEY, 'memory-vision-key');
});
