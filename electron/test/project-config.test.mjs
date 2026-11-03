import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createProject,
  getProject,
  updateProject,
  defaultProjectConfiguration,
} from '../src/project-store.mjs';
import {
  createCredential,
  markCredentialVerified,
} from '../src/credentials-store.mjs';
import { resolveProjectRunConfig, resolveTtsRunConfig, stripHostSecrets } from '../src/main/run-config.mjs';

const storage = () => ({
  isEncryptionAvailable: () => true,
  encryptString: (v) => Buffer.from(`enc:${Buffer.from(String(v), 'utf8').toString('base64')}`, 'utf8'),
  decryptString: (buf) => Buffer.from(String(buf == null ? '' : buf).replace(/^enc:/, ''), 'base64').toString('utf8'),
});

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-projcfg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seedVideo(t) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-vid-')), 'clip.mp4');
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  fs.writeFileSync(file, Buffer.alloc(16, 0));
  return file;
}

test('new projects carry default configuration; legacy projects default on read', async (t) => {
  const dir = tempDir(t);
  const project = createProject(dir, { name: 'Fresh', sourcePath: seedVideo(t) });
  assert.deepEqual(project.configuration, defaultProjectConfiguration());
  assert.equal(project.configuration.credentialId, null);
  // Simulate a pre-migration project.json without configuration.
  const rawPath = path.join(dir, 'projects', project.id, 'project.json');
  const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  delete raw.configuration;
  fs.writeFileSync(rawPath, JSON.stringify(raw, null, 2));
  const reread = getProject(dir, project.id);
  assert.equal(reread.configuration.gameProfileId, 'free-fire-default');
});

test('partial stored configuration defaults on read without rewriting', async (t) => {
  const dir = tempDir(t);
  const project = createProject(dir, { name: 'Legacy', sourcePath: seedVideo(t) });
  // Simulate an older project.json carrying only a credential reference.
  const rawPath = path.join(dir, 'projects', project.id, 'project.json');
  const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  raw.configuration = { credentialId: null };
  fs.writeFileSync(rawPath, JSON.stringify(raw, null, 2));
  const reread = getProject(dir, project.id);
  assert.equal(reread.configuration.credentialId, null);
  assert.equal(reread.configuration.gameProfileId, 'free-fire-default');
  assert.equal(reread.configuration.commentaryPresetId, 'default-energetic');
  // Loading must not silently overwrite the stored selections.
  const stored = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  assert.deepEqual(stored.configuration, { credentialId: null });
});

test('project TTS overrides default to inherit and persist explicitly', async (t) => {
  const dir = tempDir(t);
  const project = createProject(dir, { name: 'TTS', sourcePath: seedVideo(t) });
  assert.deepEqual(project.configuration.tts, {
    model: null, voice: null, voiceDirection: null, credentialId: null,
  });
  const updated = updateProject(dir, project.id, {
    configuration: { tts: { voice: 'Fenrir', credentialId: null } },
  });
  assert.deepEqual(updated.configuration.tts, {
    model: null, voice: 'Fenrir', voiceDirection: null, credentialId: null,
  });
  // A fresh read (application restart) returns the same override.
  assert.deepEqual(getProject(dir, project.id).configuration.tts, updated.configuration.tts);
  assert.throws(
    () => updateProject(dir, project.id, { configuration: { tts: { voice: 'v'.repeat(65) } } }),
    /Invalid TTS configuration field 'voice'/,
  );
});

test('legacy project configuration without TTS inherits without rewriting', async (t) => {
  const dir = tempDir(t);
  const project = createProject(dir, { name: 'LegacyTTS', sourcePath: seedVideo(t) });
  const rawPath = path.join(dir, 'projects', project.id, 'project.json');
  const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  raw.configuration = { credentialId: null };
  fs.writeFileSync(rawPath, JSON.stringify(raw, null, 2));
  const reread = getProject(dir, project.id);
  assert.deepEqual(reread.configuration.tts, {
    model: null, voice: null, voiceDirection: null, credentialId: null,
  });
  const stored = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  assert.deepEqual(stored.configuration, { credentialId: null });
});

test('TTS run resolution merges config and gates the credential', async (t) => {
  const dir = tempDir(t);
  const catalog = {
    models: [{ id: 'gemini-3.8-flash-tts', description: '' }],
    voices: [{ id: 'Kore', character: '' }],
    defaults: { model: 'gemini-3.8-flash-tts', voice: 'Kore', voiceDirection: 'Default style.' },
    limits: { voiceMaxLength: 64, voiceDirectionMaxLength: 500 },
  };
  const project = createProject(dir, { name: 'TTS Run', sourcePath: seedVideo(t) });
  assert.throws(
    () => resolveTtsRunConfig(dir, storage(), project.id, catalog),
    /no TTS credential selected/,
  );
  const tts = createCredential(dir, storage(), {
    name: 'TTS', provider: 'google-gemini-tts', model: null, key: 'run-tts-key',
  });
  updateProject(dir, project.id, {
    configuration: { tts: { voice: 'Kore', credentialId: tts.id } },
  });
  assert.throws(
    () => resolveTtsRunConfig(dir, storage(), project.id, catalog),
    /not verified/,
  );
  markCredentialVerified(dir, storage(), tts.id, null);
  const resolved = resolveTtsRunConfig(dir, storage(), project.id, catalog);
  assert.deepEqual(resolved.config, {
    model: 'gemini-3.8-flash-tts',
    voice: 'Kore',
    voiceDirection: 'Default style.',
  });
  assert.equal(resolved.apiKey, 'run-tts-key');
  assert.equal(resolved.credentialName, 'TTS');
  const vision = createCredential(dir, storage(), {
    name: 'Vision', provider: 'meta', model: 'muse-spark-1.3', key: 'vision-key',
  });
  updateProject(dir, project.id, { configuration: { tts: { credentialId: vision.id } } });
  assert.throws(
    () => resolveTtsRunConfig(dir, storage(), project.id, catalog),
    /not a TTS credential/,
  );
});

test('configuration patches merge and validate fields', async (t) => {
  const dir = tempDir(t);
  const project = createProject(dir, { name: 'P', sourcePath: seedVideo(t) });
  const updated = updateProject(dir, project.id, {
    configuration: { gameProfileId: 'free-fire-default' },
  });
  assert.equal(updated.configuration.gameProfileId, 'free-fire-default');
  assert.throws(() => updateProject(dir, project.id, { configuration: { gameProfileId: 'nope!' } }), /Invalid project configuration/);
  assert.throws(() => updateProject(dir, project.id, { configuration: { unknown: 'x' } }), /cannot be updated/);
  assert.throws(() => updateProject(dir, project.id, { name: 'New name' }), /cannot be updated/);
});

test('run resolution returns provider runtime without leaking other keys', async (t) => {
  const dir = tempDir(t);
  const credential = createCredential(dir, storage(), {
    name: 'Meta', provider: 'meta', model: 'muse-spark-1.3', key: 'run-key',
  });
  markCredentialVerified(dir, storage(), credential.id, credential.model);
  const project = createProject(dir, { name: 'P', sourcePath: seedVideo(t) });
  updateProject(dir, project.id, { configuration: { credentialId: credential.id } });
  const resolved = resolveProjectRunConfig(dir, storage(), project.id);
  assert.equal(resolved.provider, 'meta');
  assert.equal(resolved.model, 'muse-spark-1.3');
  assert.equal(resolved.apiKey, 'run-key');
  assert.equal(resolved.baseUrl, 'https://api.meta.ai/v1');
  assert.equal(resolved.verified, true);
  assert.equal(resolved.preferences.game.id, 'free-fire');
});

test('run resolution never substitutes another key and flags unverified', async (t) => {
  const dir = tempDir(t);
  const project = createProject(dir, { name: 'P', sourcePath: seedVideo(t) });
  assert.throws(() => resolveProjectRunConfig(dir, storage(), project.id), /no API configuration/);
  updateProject(dir, project.id, { configuration: { credentialId: 'cred-does-not-exist' } });
  assert.throws(() => resolveProjectRunConfig(dir, storage(), project.id), /missing or unreadable/);
  const credential = createCredential(dir, storage(), {
    name: 'B', provider: 'baseten', model: 'meta-models/muse-spark-open', key: 'k',
  });
  updateProject(dir, project.id, { configuration: { credentialId: credential.id } });
  const resolved = resolveProjectRunConfig(dir, storage(), project.id);
  assert.equal(resolved.verified, false);
});

test('prompt pack selection defaults to null and stays patchable', async (t) => {
  const dir = tempDir(t);
  const project = createProject(dir, { name: 'P', sourcePath: seedVideo(t) });
  assert.equal(project.configuration.promptPackId, null);
  // Legacy files without the field read as null (application default).
  const rawPath = path.join(dir, 'projects', project.id, 'project.json');
  const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  delete raw.configuration.promptPackId;
  fs.writeFileSync(rawPath, JSON.stringify(raw, null, 2));
  assert.equal(getProject(dir, project.id).configuration.promptPackId, null);
  const updated = updateProject(dir, project.id, { configuration: { promptPackId: 'cod' } });
  assert.equal(updated.configuration.promptPackId, 'cod');
  assert.throws(() => updateProject(dir, project.id, { configuration: { promptPackId: 'bad id!' } }), /Invalid project configuration/);
});

test('run resolution snapshots the prompt pack with customs', async (t) => {
  const dir = tempDir(t);
  const credential = createCredential(dir, storage(), {
    name: 'Meta', provider: 'meta', model: 'muse-spark-1.3', key: 'run-key',
  });
  markCredentialVerified(dir, storage(), credential.id, credential.model);
  const project = createProject(dir, { name: 'P', sourcePath: seedVideo(t) });
  updateProject(dir, project.id, { configuration: { credentialId: credential.id, promptPackId: 'cod' } });
  fs.writeFileSync(
    path.join(dir, 'prompt-packs.json'),
    JSON.stringify({ version: 1, custom: { cod: { script_closing: 'Custom.' } } }),
  );
  const resolved = resolveProjectRunConfig(dir, storage(), project.id);
  assert.deepEqual(resolved.preferences.promptPack, { packId: 'cod', custom: { script_closing: 'Custom.' } });
  const fresh = createProject(dir, { name: 'Q', sourcePath: seedVideo(t) });
  updateProject(dir, fresh.id, { configuration: { credentialId: credential.id } });
  const fallback = resolveProjectRunConfig(dir, storage(), fresh.id);
  assert.deepEqual(fallback.preferences.promptPack, { packId: 'free-fire', custom: {} });
});

test('host secrets are stripped from the worker environment', async () => {
  const clean = stripHostSecrets({
    PATH: '/usr/bin', BASETEN_API_KEY: 'x', AI_COMMENTATOR_API_KEY: 'y',
    GITHUB_TOKEN: 'z', DB_PASSWORD: 'w', KEEP_ME: '1',
  });
  assert.deepEqual(clean, { PATH: '/usr/bin', KEEP_ME: '1' });
});
