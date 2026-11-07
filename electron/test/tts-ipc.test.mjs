import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildPreviewArgv,
  previewsDir,
  registerTtsIpc,
  runTtsPreviewProcess,
  sweepStalePreviews,
  TTS_PREVIEW_PHRASE,
} from '../src/main/ipc/tts.js';
import {
  createCredential,
  markCredentialVerified,
} from '../src/credentials-store.mjs';
import { createProject } from '../src/project-store.mjs';
import { getApiActivity } from '../src/project-store/api-activity.mjs';
import { loadSettings, saveSettings } from '../src/settings-store.mjs';

const CATALOG = {
  models: [
    { id: 'gemini-3.8-flash-tts', description: 'Expressive.' },
    { id: 'gemini-3.8-flash-lite-tts', description: 'Fast.' },
  ],
  voices: [
    { id: 'Kore', character: 'Firm' },
    { id: 'Fenrir', character: 'Excitable' },
  ],
  defaults: {
    model: 'gemini-3.8-flash-tts',
    voice: 'Kore',
    voiceDirection: 'Energetic esports commentator.',
  },
  limits: { voiceMaxLength: 64, voiceDirectionMaxLength: 500 },
};

const storage = () => ({
  isEncryptionAvailable: () => true,
  encryptString: (v) => Buffer.from(`enc:${Buffer.from(String(v), 'utf8').toString('base64')}`, 'utf8'),
  decryptString: (buf) => Buffer.from(String(buf == null ? '' : buf).replace(/^enc:/, ''), 'base64').toString('utf8'),
});

function tempUserData(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-tts-ipc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seedVideo(t) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-tts-vid-')), 'clip.mp4');
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  fs.writeFileSync(file, Buffer.alloc(16, 0));
  return file;
}

function makeTtsCredential(dir, safeStorage, key = 'tts-private-key') {
  const record = createCredential(dir, safeStorage, {
    name: 'Gemini TTS', provider: 'google-gemini-tts', model: null, key,
  });
  return markCredentialVerified(dir, safeStorage, record.id, null);
}

function register({ dir, safeStorage, catalog = CATALOG, runPreview = null, catalogError = null }) {
  const handlers = {};
  const calls = { previews: [] };
  // Fake repository root with a resolvable (never executed) interpreter.
  const repoRoot = path.join(dir, 'repo');
  const venvBin = path.join(repoRoot, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin');
  fs.mkdirSync(venvBin, { recursive: true });
  fs.writeFileSync(path.join(venvBin, process.platform === 'win32' ? 'python.exe' : 'python'), '');
  const fakePreview = runPreview ?? (async (request) => {
    calls.previews.push(request);
    const outIndex = request.args.indexOf('--out');
    fs.writeFileSync(request.args[outIndex + 1], Buffer.from('RIFFfake-wav-bytes'));
    return { ok: true, stderr: '' };
  });
  registerTtsIpc({
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
    app: { getPath: () => dir },
    safeStorage,
    repoRoot,
    catalogLoader: {
      load: async () => {
        if (catalogError) throw new Error(catalogError);
        return catalog;
      },
      reset: () => {},
    },
    runPreview: fakePreview,
  });
  return { handlers, calls };
}

test('tts-catalog returns the backend catalogue and preview phrase', async (t) => {
  const dir = tempUserData(t);
  const { handlers } = register({ dir, safeStorage: storage() });
  const result = await handlers['tts-catalog']({});
  assert.equal(result.ok, true);
  assert.equal(result.catalog.models.length, 2);
  assert.equal(result.catalog.voices.length, 2);
  assert.equal(result.previewPhrase, TTS_PREVIEW_PHRASE);
  assert.equal(result.textLimit, 500);
});

test('tts-catalog failure is actionable', async (t) => {
  const dir = tempUserData(t);
  const { handlers } = register({ dir, safeStorage: storage(), catalogError: 'Python virtual environment is not configured.' });
  const result = await handlers['tts-catalog']({});
  assert.equal(result.ok, false);
  assert.match(result.error, /Python virtual environment/);
});

test('tts-config-get resolves layers with precedence and no key material', async (t) => {
  const dir = tempUserData(t);
  const safeStorage = storage();
  const credential = makeTtsCredential(dir, safeStorage);
  const project = createProject(dir, { name: 'P', sourcePath: seedVideo(t) });
  const { handlers } = register({ dir, safeStorage });
  await handlers['tts-config-set']({}, {
    scope: 'global',
    patch: { voice: 'Fenrir', credentialId: credential.id },
  });
  await handlers['tts-config-set']({}, {
    scope: 'project', projectId: project.id, patch: { voiceDirection: 'Project style.' },
  });
  const result = await handlers['tts-config-get']({}, project.id);
  assert.equal(result.ok, true);
  assert.deepEqual(result.resolved, {
    model: 'gemini-3.8-flash-tts',
    voice: 'Fenrir',
    voiceDirection: 'Project style.',
  });
  assert.deepEqual(result.sources, { model: 'appDefault', voice: 'global', voiceDirection: 'project' });
  assert.equal(result.credentialId, credential.id);
  assert.equal(result.credentialSource, 'global');
  assert.equal(result.credential.name, 'Gemini TTS');
  assert.equal(result.credential.verified, true);
  assert.deepEqual(result.warnings, []);
  assert.equal(JSON.stringify(result).includes('tts-private-key'), false);
});

test('tts-config-set validates scope, patch shape, and model membership', async (t) => {
  const dir = tempUserData(t);
  const { handlers } = register({ dir, safeStorage: storage() });
  const badScope = await handlers['tts-config-set']({}, { scope: 'session', patch: { voice: 'Kore' } });
  assert.equal(badScope.ok, false);
  const unknown = await handlers['tts-config-set']({}, { scope: 'global', patch: { tempo: 2 } });
  assert.equal(unknown.ok, false);
  const empty = await handlers['tts-config-set']({}, { scope: 'global', patch: {} });
  assert.equal(empty.ok, false);
  const badModel = await handlers['tts-config-set']({}, { scope: 'global', patch: { model: 'gemini-2.0-flash' } });
  assert.equal(badModel.ok, false);
  assert.match(badModel.error, /Unsupported TTS model/);
  // Nothing was persisted by the rejected writes.
  assert.deepEqual(loadSettings(dir).tts, { model: null, voice: null, voiceDirection: null, credentialId: null });
});

test('stored settings that outlive the catalogue fall back with a warning', async (t) => {
  const dir = tempUserData(t);
  const safeStorage = storage();
  const credential = makeTtsCredential(dir, safeStorage);
  // Simulate an older save whose model left the catalogue: write past the
  // membership gate the same way a catalogue shrink would leave behind.
  saveSettings(dir, {
    ...loadSettings(dir),
    tts: { model: 'retired-model', voice: 'Kore', voiceDirection: 'Style.', credentialId: credential.id },
  });
  const { handlers } = register({ dir, safeStorage });
  const result = await handlers['tts-config-get']({}, null);
  assert.equal(result.ok, true);
  assert.deepEqual(result.resolved, {
    model: 'gemini-3.8-flash-tts',
    voice: 'Kore',
    voiceDirection: 'Energetic esports commentator.',
  });
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /no longer valid/);
  // The stored credential stays visible so repairing never wipes it.
  assert.equal(result.credentialId, credential.id);
  assert.equal(result.credential.name, 'Gemini TTS');
});

test('tts-config-set project overrides reset to inherit with explicit null', async (t) => {
  const dir = tempUserData(t);
  const project = createProject(dir, { name: 'P', sourcePath: seedVideo(t) });
  const { handlers } = register({ dir, safeStorage: storage() });
  await handlers['tts-config-set']({}, { scope: 'global', patch: { voice: 'Fenrir' } });
  const overridden = await handlers['tts-config-set']({}, {
    scope: 'project', projectId: project.id, patch: { voice: 'Kore' },
  });
  assert.equal(overridden.resolved.voice, 'Kore');
  assert.equal(overridden.sources.voice, 'project');
  const reset = await handlers['tts-config-set']({}, {
    scope: 'project', projectId: project.id, patch: { voice: null },
  });
  assert.equal(reset.resolved.voice, 'Fenrir');
  assert.equal(reset.sources.voice, 'global');
  const badProject = await handlers['tts-config-set']({}, {
    scope: 'project', projectId: 'missing', patch: { voice: 'Kore' },
  });
  assert.equal(badProject.ok, false);
});

test('tts-config-set accepts only TTS-purpose credentials', async (t) => {
  const dir = tempUserData(t);
  const safeStorage = storage();
  const tts = makeTtsCredential(dir, safeStorage);
  const vision = createCredential(dir, safeStorage, {
    name: 'Vision', provider: 'baseten', model: 'meta-models/muse-spark-open', key: 'vision-key',
  });
  const { handlers } = register({ dir, safeStorage });
  const wrongPurpose = await handlers['tts-config-set']({}, {
    scope: 'global', patch: { credentialId: vision.id },
  });
  assert.equal(wrongPurpose.ok, false);
  assert.match(wrongPurpose.error, /TTS credential/);
  const missing = await handlers['tts-config-set']({}, {
    scope: 'global', patch: { credentialId: 'cred-does-not-exist' },
  });
  assert.equal(missing.ok, false);
  const accepted = await handlers['tts-config-set']({}, {
    scope: 'global', patch: { credentialId: tts.id },
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.credentialId, tts.id);
});

test('tts-preview synthesizes with the resolved key and cleans up', async (t) => {
  const dir = tempUserData(t);
  const safeStorage = storage();
  const credential = makeTtsCredential(dir, safeStorage, 'preview-secret-key');
  const project = createProject(dir, { name: 'P', sourcePath: seedVideo(t) });
  const { handlers, calls } = register({ dir, safeStorage });
  await handlers['tts-config-set']({}, {
    scope: 'project', projectId: project.id, patch: { credentialId: credential.id },
  });
  const result = await handlers['tts-preview']({}, {
    text: 'Hello from the booth.',
    model: 'gemini-3.8-flash-tts',
    voice: 'Fenrir',
    voiceDirection: 'Calm and measured.',
    projectId: project.id,
  });
  assert.equal(result.ok, true);
  assert.equal(result.mimeType, 'audio/wav');
  assert.equal(Buffer.from(result.audioBase64, 'base64').toString(), 'RIFFfake-wav-bytes');
  assert.deepEqual(result.config, { model: 'gemini-3.8-flash-tts', voice: 'Fenrir' });
  // The key traveled beside argv, never inside it; the temp file is gone.
  assert.equal(calls.previews.length, 1);
  const request = calls.previews[0];
  assert.equal(request.key, 'preview-secret-key');
  assert.equal(request.args.join(' ').includes('preview-secret-key'), false);
  assert.ok(request.args.includes('Hello from the booth.'));
  // The selected configuration reaches the synthesis call verbatim.
  const valueOf = (flag) => request.args[request.args.indexOf(flag) + 1];
  assert.equal(valueOf('--model'), 'gemini-3.8-flash-tts');
  assert.equal(valueOf('--voice'), 'Fenrir');
  assert.equal(valueOf('--style'), 'Calm and measured.');
  assert.equal(JSON.stringify(result).includes('preview-secret-key'), false);
  assert.deepEqual(fs.readdirSync(previewsDir(dir)), []);
  // Project artifacts are untouched by previews.
  assert.equal(fs.existsSync(path.join(dir, 'projects', project.id, 'output', 'audio')), false);
  // The request is recorded at settings level, never under the project.
  const settingsActivity = getApiActivity(dir, null);
  assert.equal(settingsActivity.length, 1);
  assert.equal(settingsActivity[0].purpose, 'voice-preview');
  assert.equal(settingsActivity[0].status, 'succeeded');
  assert.equal(settingsActivity[0].model, 'gemini-3.8-flash-tts');
  assert.deepEqual(getApiActivity(dir, project.id), []);
  assert.equal(JSON.stringify(settingsActivity).includes('preview-secret-key'), false);
});

test('tts-preview validates input and credential state without spawning', async (t) => {
  const dir = tempUserData(t);
  const safeStorage = storage();
  const { handlers, calls } = register({ dir, safeStorage });
  const empty = await handlers['tts-preview']({}, {
    text: '  ', model: 'gemini-3.8-flash-tts', voice: 'Kore', voiceDirection: 'Style.',
  });
  assert.equal(empty.ok, false);
  const badModel = await handlers['tts-preview']({}, {
    text: 'Hi.', model: 'nope', voice: 'Kore', voiceDirection: 'Style.',
  });
  assert.equal(badModel.ok, false);
  const leadingDash = await handlers['tts-preview']({}, {
    text: '--model oops', model: 'gemini-3.8-flash-tts', voice: 'Kore', voiceDirection: 'Style.',
  });
  assert.equal(leadingDash.ok, false);
  assert.match(leadingDash.error, /must not start with a dash/);
  const noCredential = await handlers['tts-preview']({}, {
    text: 'Hi.', model: 'gemini-3.8-flash-tts', voice: 'Kore', voiceDirection: 'Style.',
  });
  assert.equal(noCredential.ok, false);
  assert.equal(noCredential.code, 'no-credential');
  const unverified = createCredential(dir, safeStorage, {
    name: 'Fresh TTS', provider: 'google-gemini-tts', model: null, key: 'fresh-key',
  });
  const gated = await handlers['tts-preview']({}, {
    text: 'Hi.', model: 'gemini-3.8-flash-tts', voice: 'Kore', voiceDirection: 'Style.',
    credentialId: unverified.id,
  });
  assert.equal(gated.ok, false);
  assert.equal(gated.code, 'unverified');
  assert.equal(calls.previews.length, 0);
});

test('tts-preview failure scrubs key material and removes temp audio', async (t) => {
  const dir = tempUserData(t);
  const safeStorage = storage();
  const credential = makeTtsCredential(dir, safeStorage, 'leaky-preview-key');
  let outPath = null;
  const { handlers } = register({
    dir,
    safeStorage,
    runPreview: async (request) => {
      const outIndex = request.args.indexOf('--out');
      outPath = request.args[outIndex + 1];
      fs.writeFileSync(outPath, Buffer.from('partial'));
      return { ok: false, stderr: `auth failed for leaky-preview-key end` };
    },
  });
  const result = await handlers['tts-preview']({}, {
    text: 'Hi.', model: 'gemini-3.8-flash-tts', voice: 'Kore', voiceDirection: 'Style.',
    credentialId: credential.id,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.includes('leaky-preview-key'), false);
  assert.match(result.error, /\[REDACTED\]/);
  assert.equal(fs.existsSync(outPath), false);
  const settingsActivity = getApiActivity(dir, null);
  assert.equal(settingsActivity.length, 1);
  assert.equal(settingsActivity[0].status, 'failed');
  assert.equal(settingsActivity[0].errorCode, 'preview-failed');
  assert.equal(JSON.stringify(settingsActivity).includes('leaky-preview-key'), false);
});

test('preview argv carries config and output path in order', () => {
  assert.deepEqual(
    buildPreviewArgv('/repo/python/tts_say.py', {
      text: 'Hi.', model: 'm', voice: 'v', style: 's', out: '/tmp/x.wav',
    }),
    ['/repo/python/tts_say.py', 'Hi.', '--model', 'm', '--voice', 'v', '--style', 's', '--out', '/tmp/x.wav'],
  );
});

test('stale preview sweep removes only old WAV files', async (t) => {
  const dir = tempUserData(t);
  const previews = previewsDir(dir);
  fs.mkdirSync(previews, { recursive: true });
  const oldFile = path.join(previews, 'preview-old.wav');
  const freshFile = path.join(previews, 'preview-fresh.wav');
  const noteFile = path.join(previews, 'note.txt');
  fs.writeFileSync(oldFile, 'old');
  fs.writeFileSync(freshFile, 'fresh');
  fs.writeFileSync(noteFile, 'note');
  const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(oldFile, oldTime, oldTime);
  sweepStalePreviews(dir);
  assert.equal(fs.existsSync(oldFile), false);
  assert.equal(fs.existsSync(freshFile), true);
  assert.equal(fs.existsSync(noteFile), true);
});

test('preview process runner maps exit codes and keeps the key out of argv', async (t) => {
  const events = {};
  const seen = {};
  const fakeSpawn = (executable, args, options) => {
    seen.executable = executable;
    seen.args = args;
    seen.env = options.env;
    return {
      stdout: { on: () => {} },
      stderr: { on: (event, fn) => { events[event] = fn; } },
      on: (event, fn) => { events[event] = fn; },
      kill: () => {},
    };
  };
  const pending = runTtsPreviewProcess({
    executable: '/venv/python', args: ['tts_say.py', 'Hi.'], key: 'spawn-secret', spawnFn: fakeSpawn,
  });
  events['close'](0);
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(seen.env.AI_COMMENTATOR_PROVIDER_API_KEY, 'spawn-secret');
  assert.equal(seen.args.join(' ').includes('spawn-secret'), false);

  const failing = runTtsPreviewProcess({
    executable: '/venv/python', args: ['tts_say.py', 'Hi.'], key: 'k', spawnFn: fakeSpawn,
  });
  events['data']('error: synthesis blew up\n');
  events['close'](1);
  const failed = await failing;
  assert.equal(failed.ok, false);
  assert.match(failed.stderr, /synthesis blew up/);
});
