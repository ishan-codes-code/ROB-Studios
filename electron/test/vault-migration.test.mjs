import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateLegacyVault } from '../src/vault-migration.mjs';
import { DEFAULT_SETTINGS } from '../src/settings-defaults.mjs';

const storage = (keyAvailable = true) => ({
  isEncryptionAvailable: () => keyAvailable,
  encryptString: (v) => Buffer.from(`enc:${v}`, 'utf8'),
  decryptString: (buf) => String(buf == null ? '' : buf).replace(/^enc:/, ''),
});

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-migrate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seedLegacy(dir, { settings = {}, key = 'legacy-key' } = {}) {
  const merged = {
    ...JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
    ...settings,
    provider: { ...DEFAULT_SETTINGS.provider, ...(settings.provider ?? {}) },
    game: { ...DEFAULT_SETTINGS.game, ...(settings.game ?? {}) },
    prompt: { ...DEFAULT_SETTINGS.prompt, ...(settings.prompt ?? {}) },
  };
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(merged, null, 2));
  fs.writeFileSync(path.join(dir, 'provider-key.enc'), storage().encryptString(key));
  return merged;
}

function harness(dir) {
  const created = { credentials: [] };
  return {
    created,
    safeStorage: storage(),
    loadSettings: (userData) => JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8')),
    vaultHasCredentials: () => created.credentials.length > 0,
    createCredential: (input) => {
      const record = { id: `cred-${created.credentials.length}`, model: input.model, verification: { status: 'unverified' }, ...input };
      created.credentials.push(record);
      return record;
    },
    markCredentialVerified: (id, model) => ({ id, model }),
  };
}

test('migrates a Baseten legacy credential and leaves game/prompt prefs untouched', async (t) => {
  const dir = tempDir(t);
  seedLegacy(dir, {
    settings: {
      provider: { type: 'openai-compatible', baseUrl: 'https://inference.baseten.co/v1', model: 'meta-models/muse-spark-open-1026', modelVisionVerified: true },
      game: { id: 'free-fire', context: 'My ranked context.' },
      prompt: { personality: 'Caster', tone: 'hype', language: 'English', instructions: 'Be brief.' },
    },
  });
  const h = harness(dir);
  const result = migrateLegacyVault(dir, h);
  assert.equal(result.migrated, true);
  assert.equal(h.created.credentials.length, 1);
  assert.equal(h.created.credentials[0].provider, 'baseten');
  assert.equal(fs.existsSync(path.join(dir, 'provider-key.enc')), false);
  assert.equal(fs.existsSync(path.join(dir, 'provider-key.enc.migrated')), true);
  assert.ok(result.notice.includes('Baseten'));
  // Legacy preferences stay in the old settings file; nothing is
  // written to a game library (the feature no longer exists).
  const kept = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.equal(kept.game.context, 'My ranked context.');
  assert.equal(kept.prompt.tone, 'hype');
  assert.equal(fs.existsSync(path.join(dir, 'game-library.json')), false);
});

test('unmappable custom URL migrates nothing and keeps legacy files', async (t) => {
  const dir = tempDir(t);
  seedLegacy(dir, { settings: { provider: { type: 'openai-compatible', baseUrl: 'https://custom.example.com/v1', model: 'anything', modelVisionVerified: false } } });
  const h = harness(dir);
  const result = migrateLegacyVault(dir, h);
  assert.equal(result.migrated, false);
  assert.equal(h.created.credentials.length, 0);
  assert.equal(fs.existsSync(path.join(dir, 'provider-key.enc')), true);
  assert.ok(result.notice.includes('not a supported'));
});

test('undecryptable legacy key migrates nothing and asks for a new key', async (t) => {
  const dir = tempDir(t);
  seedLegacy(dir, {});
  const h = harness(dir);
  h.safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (v) => Buffer.from(v),
    decryptString: () => { throw new Error('nope'); },
  };
  const result = migrateLegacyVault(dir, h);
  assert.equal(result.migrated, false);
  assert.ok(result.notice.toLowerCase().includes('re-enter'));
  assert.equal(fs.existsSync(path.join(dir, 'provider-key.enc')), true);
});

test('no legacy key means a fresh start', async (t) => {
  const dir = tempDir(t);
  const h = harness(dir);
  const result = migrateLegacyVault(dir, h);
  assert.equal(result.migrated, false);
  assert.ok(result.notice.includes('fresh'));
});

test('already-initialized vault skips migration', async (t) => {
  const dir = tempDir(t);
  seedLegacy(dir, {});
  const h = harness(dir);
  h.vaultHasCredentials = () => true;
  const result = migrateLegacyVault(dir, h);
  assert.equal(result.migrated, false);
  assert.equal(h.created.credentials.length, 0);
});
