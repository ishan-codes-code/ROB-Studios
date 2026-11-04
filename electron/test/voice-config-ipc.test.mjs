import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerVoiceConfigIpc } from '../src/main/ipc/voice-configs.js';
import { createCredential } from '../src/credentials-store.mjs';
import { createProject } from '../src/project-store.mjs';

const TRIPLE = {
  model: 'gemini-3.8-flash-tts',
  voice: 'Kore',
  voiceDirection: 'Energetic esports commentator.',
};

const storage = () => ({
  isEncryptionAvailable: () => true,
  encryptString: (v) => Buffer.from(`enc:${Buffer.from(String(v), 'utf8').toString('base64')}`, 'utf8'),
  decryptString: (buf) => Buffer.from(String(buf == null ? '' : buf).replace(/^enc:/, ''), 'base64').toString('utf8'),
});

function tempUserData(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-voice-ipc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function register(dir, safeStorage) {
  const handlers = {};
  registerVoiceConfigIpc({
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
    app: { getPath: () => dir },
    safeStorage,
  });
  return handlers;
}

test('library CRUD round-trips through IPC', async (t) => {
  const dir = tempUserData(t);
  const handlers = register(dir, storage());
  assert.deepEqual(Object.keys(handlers).sort(), [
    'voice-config-create', 'voice-config-delete', 'voice-config-list', 'voice-config-update',
  ]);
  const empty = await handlers['voice-config-list']({});
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.configs, []);

  const created = await handlers['voice-config-create']({}, { name: 'Ranked', ...TRIPLE });
  assert.equal(created.ok, true);
  assert.equal(created.config.name, 'Ranked');
  assert.equal(created.config.providerId, 'google-gemini-tts');

  const listed = await handlers['voice-config-list']({});
  assert.equal(listed.configs.length, 1);

  const updated = await handlers['voice-config-update']({}, created.config.id, { name: 'Ranked grind' });
  assert.equal(updated.ok, true);
  assert.equal(updated.config.name, 'Ranked grind');

  const deleted = await handlers['voice-config-delete']({}, created.config.id);
  assert.deepEqual(deleted, { ok: true, deleted: true, id: created.config.id });
  const relisted = await handlers['voice-config-list']({});
  assert.deepEqual(relisted.configs, []);
});

test('invalid input fails closed with nothing persisted', async (t) => {
  const dir = tempUserData(t);
  const handlers = register(dir, storage());
  for (const input of [{}, { name: '' }, { name: 'A' }, { name: 'A', ...TRIPLE, apiKey: 'sk-x' }, null, []]) {
    const result = await handlers['voice-config-create']({}, input);
    assert.equal(result.ok, false, `create should reject ${JSON.stringify(input)}`);
    assert.equal(typeof result.error, 'string');
  }
  assert.equal((await handlers['voice-config-update']({}, '', { name: 'x' })).ok, false);
  assert.equal((await handlers['voice-config-update']({}, 'voice-abcdefabcdef', { name: 'x' })).ok, false);
  assert.equal((await handlers['voice-config-delete']({}, 'voice-abcdefabcdef')).ok, false);
  const listed = await handlers['voice-config-list']({});
  assert.deepEqual(listed.configs, []);
});

test('provider pins from TTS credentials and rejects vision credentials', async (t) => {
  const dir = tempUserData(t);
  const safeStorage = storage();
  const handlers = register(dir, safeStorage);
  const tts = createCredential(dir, safeStorage, {
    name: 'Gemini TTS', provider: 'google-gemini-tts', model: null, key: 'tts-private-key',
  });
  const vision = createCredential(dir, safeStorage, {
    name: 'Vision', provider: 'baseten', model: 'meta-models/muse-spark-open', key: 'vision-private-key',
  });

  const stamped = await handlers['voice-config-create']({}, {
    name: 'Stamped', ...TRIPLE, credentialId: tts.id,
  });
  assert.equal(stamped.ok, true);
  assert.equal(stamped.config.providerId, 'google-gemini-tts');

  const mismatch = await handlers['voice-config-create']({}, {
    name: 'Mismatch', ...TRIPLE, credentialId: vision.id,
  });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.error, /TTS credential/);

  const updateMismatch = await handlers['voice-config-update'](
    {}, stamped.config.id, { credentialId: vision.id },
  );
  assert.equal(updateMismatch.ok, false);

  // Key material never crosses these responses.
  for (const response of [stamped, mismatch, updateMismatch, await handlers['voice-config-list']({})]) {
    const serialized = JSON.stringify(response);
    assert.ok(!serialized.includes('tts-private-key'), 'TTS key leaked into IPC');
    assert.ok(!serialized.includes('vision-private-key'), 'vision key leaked into IPC');
  }
});

test('dangling credential references are tolerated at save time', async (t) => {
  const dir = tempUserData(t);
  const handlers = register(dir, storage());
  const created = await handlers['voice-config-create']({}, {
    name: 'Dangling', ...TRIPLE, credentialId: 'cred-gone',
  });
  assert.equal(created.ok, true);
  assert.equal(created.config.credentialId, 'cred-gone');
  assert.equal(created.config.providerId, 'google-gemini-tts');
});

test('library operations never touch projects (isolation)', async (t) => {
  const dir = tempUserData(t);
  const handlers = register(dir, storage());
  const videoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-voice-vid-'));
  t.after(() => fs.rmSync(videoDir, { recursive: true, force: true }));
  const video = path.join(videoDir, 'clip.mp4');
  fs.writeFileSync(video, Buffer.alloc(16, 0));
  const project = createProject(dir, { name: 'Isolated', sourcePath: video });
  const before = fs.readFileSync(path.join(dir, 'projects', project.id, 'project.json'), 'utf8');

  const created = await handlers['voice-config-create']({}, { name: 'Preset', ...TRIPLE });
  assert.equal(created.ok, true);
  await handlers['voice-config-update']({}, created.config.id, { voice: 'Fenrir' });
  await handlers['voice-config-list']({});
  await handlers['voice-config-delete']({}, created.config.id);

  const after = fs.readFileSync(path.join(dir, 'projects', project.id, 'project.json'), 'utf8');
  assert.equal(after, before);
});
