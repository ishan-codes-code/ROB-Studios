import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  listCredentials,
  createCredential,
  renameCredential,
  setCredentialKey,
  setCredentialModel,
  deleteCredential,
  markCredentialVerified,
  getCredentialForRun,
  isCredentialVerifiedForRun,
} from '../src/credentials-store.mjs';

const storage = () => ({
  isEncryptionAvailable: () => true,
  encryptString: (v) => Buffer.from(`enc:${Buffer.from(String(v), 'utf8').toString('base64')}`, 'utf8'),
  decryptString: (buf) => Buffer.from(String(buf == null ? '' : buf).replace(/^enc:/, ''), 'base64').toString('utf8'),
});

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-vault-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeCredential(dir, overrides = {}) {
  return createCredential(dir, storage(), {
    name: 'Meta Personal',
    provider: 'meta',
    model: 'muse-spark-1.3',
    key: 'secret-key-1',
    ...overrides,
  });
}

test('vault starts empty and creates a credential without leaking secrets', async (t) => {
  const dir = tempDir(t);
  assert.deepEqual(listCredentials(dir, storage()), []);
  const created = makeCredential(dir);
  assert.equal(created.name, 'Meta Personal');
  assert.equal(created.provider, 'meta');
  assert.equal(created.keyAvailable, true);
  assert.equal(created.verification.status, 'unverified');
  assert.ok(!('key' in created) && !('apiKey' in created));
  const raw = fs.readFileSync(path.join(dir, 'provider-vault.json'), 'utf8');
  assert.equal(raw.includes('secret-key-1'), false);
  const cipher = fs.readFileSync(path.join(dir, 'credentials', `${created.id}.enc`), 'utf8');
  assert.equal(cipher.includes('secret-key-1'), false);
  assert.equal(JSON.stringify(listCredentials(dir, storage())).includes('secret-key-1'), false);
});

test('multiple credentials can share one provider', async (t) => {
  const dir = tempDir(t);
  makeCredential(dir, { name: 'Meta Personal' });
  makeCredential(dir, { name: 'Meta Hackathon', model: 'muse-wonder-1.0' });
  makeCredential(dir, { name: 'Baseten Hackathon', provider: 'baseten', model: 'meta-models/muse-spark-open' });
  const items = listCredentials(dir, storage());
  assert.equal(items.length, 3);
});

test('invalid provider and model are rejected', async (t) => {
  const dir = tempDir(t);
  assert.throws(() => makeCredential(dir, { provider: 'openai' }), /Unsupported provider/);
  assert.throws(() => makeCredential(dir, { model: 'gpt-4' }), /Unsupported model/);
  assert.throws(() => makeCredential(dir, { name: '  ' }), /must not be empty/);
  assert.throws(() => makeCredential(dir, { key: '' }), /non-empty/);
});

test('duplicate names are rejected', async (t) => {
  const dir = tempDir(t);
  makeCredential(dir, { name: 'Shared' });
  assert.throws(() => makeCredential(dir, { name: 'shared' }), /already exists/);
});

test('key rotation bumps version and clears verification', async (t) => {
  const dir = tempDir(t);
  const created = makeCredential(dir);
  const verified = markCredentialVerified(dir, storage(), created.id, created.model);
  assert.equal(verified.verification.status, 'verified');
  const rotated = setCredentialKey(dir, storage(), created.id, 'secret-key-2');
  assert.equal(rotated.credentialVersion, 2);
  assert.equal(rotated.verification.status, 'unverified');
  const run = getCredentialForRun(dir, storage(), created.id);
  assert.equal(run.apiKey, 'secret-key-2');
  assert.equal(isCredentialVerifiedForRun(rotated), false);
});

test('model change clears verification; same model is a no-op', async (t) => {
  const dir = tempDir(t);
  const created = makeCredential(dir);
  markCredentialVerified(dir, storage(), created.id, created.model);
  const same = setCredentialModel(dir, storage(), created.id, 'muse-spark-1.3');
  assert.equal(same.verification.status, 'verified');
  const changed = setCredentialModel(dir, storage(), created.id, 'muse-wonder-1.0');
  assert.equal(changed.model, 'muse-wonder-1.0');
  assert.equal(changed.verification.status, 'unverified');
  assert.throws(() => setCredentialModel(dir, storage(), created.id, 'gpt-4'), /Unsupported model/);
});

test('rename validates and dedupes', async (t) => {
  const dir = tempDir(t);
  const first = makeCredential(dir, { name: 'First' });
  makeCredential(dir, { name: 'Second' });
  assert.throws(() => renameCredential(dir, storage(), first.id, 'second'), /already exists/);
  const renamed = renameCredential(dir, storage(), first.id, 'Renamed');
  assert.equal(renamed.name, 'Renamed');
});

test('delete removes index and ciphertext', async (t) => {
  const dir = tempDir(t);
  const created = makeCredential(dir);
  const result = deleteCredential(dir, storage(), created.id);
  assert.deepEqual(result, { deleted: true, id: created.id });
  assert.deepEqual(listCredentials(dir, storage()), []);
  assert.equal(fs.existsSync(path.join(dir, 'credentials', `${created.id}.enc`)), false);
  assert.throws(() => getCredentialForRun(dir, storage(), created.id), /not found/);
});

test('corrupted vault fails closed with a clear error', async (t) => {
  const dir = tempDir(t);
  makeCredential(dir);
  fs.writeFileSync(path.join(dir, 'provider-vault.json'), '{not json');
  assert.throws(() => listCredentials(dir, storage()), /corrupted/);
});

test('missing ciphertext flags the credential unavailable', async (t) => {
  const dir = tempDir(t);
  const created = makeCredential(dir);
  fs.unlinkSync(path.join(dir, 'credentials', `${created.id}.enc`));
  const items = listCredentials(dir, storage());
  assert.equal(items.length, 1);
  assert.equal(items[0].keyAvailable, false);
  assert.throws(() => getCredentialForRun(dir, storage(), created.id), /unavailable/);
});

test('secure storage unavailable fails every operation', async (t) => {
  const dir = tempDir(t);
  const down = { isEncryptionAvailable: () => false };
  assert.throws(() => listCredentials(dir, down), /unavailable/);
  assert.throws(() => createCredential(dir, down, { name: 'X', provider: 'meta', model: 'muse-spark-1.3', key: 'k' }), /unavailable/);
});

test('retired Baseten model id normalizes and requires re-verification', async (t) => {
  const dir = tempDir(t);
  const created = makeCredential(dir, {
    name: 'Baseten Old', provider: 'baseten',
    model: 'meta-models/muse-spark-open-1026', key: 'k',
  });
  assert.equal(created.model, 'meta-models/muse-spark-open');
  // A vault written before the rename claims verified for the retired id.
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'provider-vault.json'), 'utf8'));
  raw.credentials[0].model = 'meta-models/muse-spark-open-1026';
  raw.credentials[0].verification = {
    status: 'verified',
    verifiedAt: new Date().toISOString(),
    verifiedCredentialVersion: 1,
    verifiedModel: 'meta-models/muse-spark-open-1026',
  };
  fs.writeFileSync(path.join(dir, 'provider-vault.json'), JSON.stringify(raw));
  const items = listCredentials(dir, storage());
  assert.equal(items.length, 1);
  assert.equal(items[0].model, 'meta-models/muse-spark-open');
  assert.equal(items[0].verification.status, 'unverified');
});

test('verification requires matching model and readable key', async (t) => {
  const dir = tempDir(t);
  const created = makeCredential(dir);
  assert.throws(() => markCredentialVerified(dir, storage(), created.id, 'muse-wonder-1.0'), /does not match/);
  const verified = markCredentialVerified(dir, storage(), created.id, 'muse-spark-1.3');
  assert.equal(verified.verification.verifiedModel, 'muse-spark-1.3');
  assert.equal(verified.verification.verifiedCredentialVersion, 1);
  assert.ok(Date.parse(verified.verification.verifiedAt) > 0);
});

test('TTS credentials use a null model, encrypted key, and credential-scoped verification', async (t) => {
  const dir = tempDir(t);
  const created = createCredential(dir, storage(), {
    name: 'Gemini TTS', provider: 'google-gemini-tts', model: null, key: 'tts-secret',
  });
  assert.equal(created.purpose, 'tts');
  assert.equal(created.model, null);
  assert.equal(created.verification.status, 'unverified');
  assert.equal(JSON.stringify(created).includes('tts-secret'), false);
  const verified = markCredentialVerified(dir, storage(), created.id, null);
  assert.equal(verified.verification.status, 'verified');
  assert.equal(verified.verification.verifiedModel, null);
  const rotated = setCredentialKey(dir, storage(), created.id, 'tts-secret-2');
  assert.equal(rotated.verification.status, 'unverified');
});
