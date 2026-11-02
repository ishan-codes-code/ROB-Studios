import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerSettingsIpc } from '../src/main/ipc/settings.js';
import { createCredential as vaultCreate, setCredentialKey, setCredentialModel } from '../src/credentials-store.mjs';
import { createGameProfile, createCommentaryPreset } from '../src/game-store.mjs';
import { createProject } from '../src/project-store.mjs';

const storage = () => ({
  isEncryptionAvailable: () => true,
  encryptString: (v) => Buffer.from(`enc:${Buffer.from(String(v), 'utf8').toString('base64')}`, 'utf8'),
  decryptString: (buf) => Buffer.from(String(buf == null ? '' : buf).replace(/^enc:/, ''), 'base64').toString('utf8'),
});

function setup(t, { spawnSetup = async () => ({ ok: true, connected: true }) } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-vault-ipc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const handlers = {};
  const ipcMain = { handle: (name, fn) => { handlers[name] = fn; } };
  registerSettingsIpc({
    ipcMain,
    app: { getPath: () => dir },
    safeStorage: storage(),
    spawnSetup,
  });
  return { dir, handlers };
}

function seedVideo(t) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-vid-')), 'clip.mp4');
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  fs.writeFileSync(file, Buffer.alloc(16, 0));
  return file;
}

test('vault IPC creates, lists, tests, verifies, and deletes', async (t) => {
  const { handlers } = setup(t, {
    spawnSetup: async ({ operation }) => (operation === 'verify-vision'
      ? { ok: true, visionVerified: true }
      : { ok: true, connected: true }),
  });
  const created = await handlers['credential-create']({}, {
    name: 'Meta Personal', provider: 'meta', model: 'muse-spark-1.3', key: 'zz-top-secret-9',
  });
  assert.equal(created.ok, true);
  const id = created.credential.id;

  const listed = await handlers['credential-list']();
  assert.equal(listed.ok, true);
  assert.equal(listed.credentials.length, 1);
  assert.equal(listed.secureStorageAvailable, true);
  assert.equal(JSON.stringify(listed).includes('zz-top-secret-9'), false);

  const tested = await handlers['credential-test']({}, id);
  assert.deepEqual(tested, { ok: true, connected: true });

  const verified = await handlers['credential-verify']({}, id);
  assert.equal(verified.ok, true);
  assert.equal(verified.credential.verification.status, 'verified');

  const renamed = await handlers['credential-rename']({}, id, 'Meta Renamed');
  assert.equal(renamed.credential.name, 'Meta Renamed');

  const removed = await handlers['credential-remove']({}, id);
  assert.deepEqual(removed, { ok: true, deleted: true, id });
});

test('vault IPC never leaks secrets in outputs or errors', async (t) => {
  const { handlers } = setup(t);
  const created = await handlers['credential-create']({}, {
    name: 'B', provider: 'baseten', model: 'meta-models/muse-spark-open-1026', key: 'super-secret-key',
  });
  assert.equal(JSON.stringify(created).includes('super-secret-key'), false);
  const bad = await handlers['credential-set-key']({}, created.credential.id, '');
  assert.equal(bad.ok, false);
  assert.equal(JSON.stringify(bad).includes('super-secret-key'), false);
});

test('credential in use by a project cannot be deleted', async (t) => {
  const { dir, handlers } = setup(t);
  const created = await handlers['credential-create']({}, {
    name: 'Shared', provider: 'meta', model: 'muse-spark-1.3', key: 'k',
  });
  const project = createProject(dir, { name: 'Run one', sourcePath: seedVideo(t) });
  const set = await handlers['project-config-set']({}, project.id, { credentialId: created.credential.id });
  assert.equal(set.ok, true);
  const blocked = await handlers['credential-remove']({}, created.credential.id);
  assert.equal(blocked.ok, false);
  assert.ok(Array.isArray(blocked.referencedBy) && blocked.referencedBy.length === 1);
});

test('project config resolves metadata with missing-reference warnings', async (t) => {
  const { dir, handlers } = setup(t);
  const project = createProject(dir, { name: 'P', sourcePath: seedVideo(t) });
  const initial = await handlers['project-config-get']({}, project.id);
  assert.equal(initial.ok, true);
  assert.equal(initial.credential, null);
  assert.deepEqual(initial.warnings, []);

  const missing = await handlers['project-config-set']({}, project.id, { credentialId: 'cred-missing' });
  assert.equal(missing.ok, false);

  const stored = vaultCreate(dir, storage(), { name: 'K', provider: 'meta', model: 'muse-spark-1.3', key: 'k' });
  const ok = await handlers['project-config-set']({}, project.id, { credentialId: stored.id });
  assert.equal(ok.configuration.credentialId, stored.id);
  const resolved = await handlers['project-config-get']({}, project.id);
  assert.equal(resolved.credential.id, stored.id);
  assert.equal(resolved.credential.verified, false);
  assert.equal(resolved.warnings.length, 1);
});

test('structured provider failures reach the renderer without secrets', async (t) => {
  const failure = {
    ok: false,
    error: 'Authentication failed. Check the API key.',
    code: 'auth',
    status: 401,
    provider: 'meta',
    operation: 'verify-vision',
  };
  const { handlers } = setup(t, { spawnSetup: async () => ({ ...failure }) });
  const created = await handlers['credential-create']({}, {
    name: 'Meta', provider: 'meta', model: 'muse-spark-1.3', key: 'zz-top-secret-9',
  });
  assert.equal(created.ok, true);
  const tested = await handlers['credential-test']({}, created.credential.id);
  assert.equal(tested.ok, false);
  assert.equal(tested.error, 'Authentication failed. Check the API key.');
  assert.equal(tested.code, 'auth');
  const verified = await handlers['credential-verify']({}, created.credential.id);
  assert.equal(verified.ok, false);
  assert.equal(verified.error, 'Authentication failed. Check the API key.');
  assert.equal(verified.code, 'auth');
  assert.equal(JSON.stringify({ tested, verified }).includes('zz-top-secret-9'), false);
  const listed = await handlers['credential-list']();
  assert.equal(listed.credentials[0].verification.status, 'unverified');
});

test('key rotation during verification refuses to mark verified', async (t) => {
  const dirHolder = {};
  const { dir, handlers } = setup(t, {
    spawnSetup: async () => {
      // Simulate the user replacing the key while the check runs.
      setCredentialKey(dirHolder.dir, storage(), dirHolder.id, 'rotated-key');
      return { ok: true, visionVerified: true };
    },
  });
  const created = await handlers['credential-create']({}, {
    name: 'Meta', provider: 'meta', model: 'muse-spark-1.3', key: 'original-key',
  });
  dirHolder.dir = dir;
  dirHolder.id = created.credential.id;
  const result = await handlers['credential-verify']({}, created.credential.id);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'stale');
  assert.match(result.error, /changed during verification/);
  const listed = await handlers['credential-list']();
  assert.equal(listed.credentials[0].verification.status, 'unverified');
});

test('model change during verification refuses to mark verified', async (t) => {
  const dirHolder = {};
  const { dir, handlers } = setup(t, {
    spawnSetup: async () => {
      setCredentialModel(dirHolder.dir, storage(), dirHolder.id, 'muse-wonder-1.0');
      return { ok: true, visionVerified: true };
    },
  });
  const created = await handlers['credential-create']({}, {
    name: 'Meta', provider: 'meta', model: 'muse-spark-1.3', key: 'k',
  });
  dirHolder.dir = dir;
  dirHolder.id = created.credential.id;
  const result = await handlers['credential-verify']({}, created.credential.id);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'stale');
});

test('game and preset IPC enforce built-in immutability and references', async (t) => {
  const { dir, handlers } = setup(t);
  const profiles = await handlers['game-profile-list']();
  assert.equal(profiles.profiles.length, 1);
  const custom = await handlers['game-profile-create']({}, { name: 'Ranked', context: 'Zones.' });
  assert.equal(custom.profile.gameId, 'free-fire');
  const preset = await handlers['preset-create']({}, {
    profileId: custom.profile.id, name: 'Caster', tone: 'hype',
  });
  assert.equal(preset.preset.profileId, custom.profile.id);
  const dupe = await handlers['preset-duplicate']({}, preset.preset.id);
  assert.ok(dupe.preset.id !== preset.preset.id);
  const project = createProject(dir, { name: 'P', sourcePath: seedVideo(t) });
  await handlers['project-config-set']({}, project.id, {
    gameProfileId: custom.profile.id, commentaryPresetId: preset.preset.id,
  });
  const blockedProfile = await handlers['game-profile-delete']({}, custom.profile.id);
  assert.equal(blockedProfile.ok, false);
  const blockedPreset = await handlers['preset-delete']({}, preset.preset.id);
  assert.equal(blockedPreset.ok, false);
  const builtInEdit = await handlers['preset-update']({}, 'default-energetic', { tone: 'calm' });
  assert.equal(builtInEdit.ok, false);
});
