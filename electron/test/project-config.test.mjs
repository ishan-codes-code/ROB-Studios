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
import { resolveProjectRunConfig, stripHostSecrets } from '../src/main/run-config.mjs';

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
    name: 'B', provider: 'baseten', model: 'meta-models/muse-spark-open-1026', key: 'k',
  });
  updateProject(dir, project.id, { configuration: { credentialId: credential.id } });
  const resolved = resolveProjectRunConfig(dir, storage(), project.id);
  assert.equal(resolved.verified, false);
});

test('host secrets are stripped from the worker environment', async () => {
  const clean = stripHostSecrets({
    PATH: '/usr/bin', BASETEN_API_KEY: 'x', AI_COMMENTATOR_API_KEY: 'y',
    GITHUB_TOKEN: 'z', DB_PASSWORD: 'w', KEEP_ME: '1',
  });
  assert.deepEqual(clean, { PATH: '/usr/bin', KEEP_ME: '1' });
});
