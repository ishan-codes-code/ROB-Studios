import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerSettingsIpc } from '../src/main/ipc/settings.js';
import {
  createCredential,
  setCredentialEndpoint,
  setCredentialKey,
  setCredentialModel,
  markCredentialVerified,
  isCredentialVerifiedForRun,
  getCredentialForRun,
} from '../src/credentials-store.mjs';

const BASE = 'https://llm.example.com/v1';

const storage = () => ({
  isEncryptionAvailable: () => true,
  encryptString: (v) => Buffer.from(`enc:${Buffer.from(String(v), 'utf8').toString('base64')}`, 'utf8'),
  decryptString: (buf) => Buffer.from(String(buf == null ? '' : buf).replace(/^enc:/, ''), 'base64').toString('utf8'),
});

function setup(t, { spawnSetup = async () => ({ ok: true, connected: true }) } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-custom-ep-'));
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

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-custom-vault-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('custom records require a valid endpoint and expose it as metadata', (t) => {
  const dir = temp(t);
  const safe = storage();
  const created = createCredential(dir, safe, {
    name: 'Gateway', provider: 'custom', model: 'qwen-vl', key: 'k-1', baseUrl: `${BASE}/`,
  });
  assert.equal(created.baseUrl, BASE);
  assert.equal(created.purpose, 'vision');
  assert.equal(JSON.stringify(created).includes('k-1'), false);

  assert.throws(() => createCredential(dir, safe, {
    name: 'Missing', provider: 'custom', model: 'm', key: 'k',
  }), /endpoint URL is required/);
  assert.throws(() => createCredential(dir, safe, {
    name: 'Local', provider: 'custom', model: 'm', key: 'k', baseUrl: 'https://127.0.0.1/v1',
  }), /local or private/);
  assert.throws(() => createCredential(dir, safe, {
    name: 'Curated', provider: 'meta', model: 'muse-spark-1.3', key: 'k', baseUrl: BASE,
  }), /Only custom endpoints store a base URL/);
});

test('changing the endpoint resets verification; curated records reject it', (t) => {
  const dir = temp(t);
  const safe = storage();
  const created = createCredential(dir, safe, {
    name: 'Gateway', provider: 'custom', model: 'qwen-vl', key: 'k-1', baseUrl: BASE,
  });
  const verified = markCredentialVerified(dir, safe, created.id, 'qwen-vl', BASE);
  assert.equal(verified.verification.status, 'verified');
  assert.equal(verified.verification.verifiedBaseUrl, BASE);

  const fresh = getCredentialForRun(dir, safe, created.id);
  assert.equal(isCredentialVerifiedForRun(fresh.record), true);

  const moved = setCredentialEndpoint(dir, safe, created.id, 'https://other.example/v1');
  assert.equal(moved.baseUrl, 'https://other.example/v1');
  assert.equal(moved.verification.status, 'unverified');
  assert.equal(isCredentialVerifiedForRun(getCredentialForRun(dir, safe, created.id).record), false);

  const curated = createCredential(dir, safe, {
    name: 'Meta', provider: 'meta', model: 'muse-spark-1.3', key: 'k-2',
  });
  assert.throws(() => setCredentialEndpoint(dir, safe, curated.id, BASE), /Only custom endpoints/);
});

test('verification pins the exact endpoint: stale hosts never verify', (t) => {
  const dir = temp(t);
  const safe = storage();
  const created = createCredential(dir, safe, {
    name: 'Gateway', provider: 'custom', model: 'qwen-vl', key: 'k-1', baseUrl: BASE,
  });
  assert.throws(() => markCredentialVerified(dir, safe, created.id, 'qwen-vl', 'https://other.example/v1'),
    /does not match/);
  // Key and model rotation keep their existing invalidation behavior.
  markCredentialVerified(dir, safe, created.id, 'qwen-vl', BASE);
  const rotated = setCredentialKey(dir, safe, created.id, 'k-2');
  assert.equal(rotated.verification.status, 'unverified');
  markCredentialVerified(dir, safe, created.id, 'qwen-vl', BASE);
  const remodeled = setCredentialModel(dir, safe, created.id, 'qwen-vl-max');
  assert.equal(remodeled.model, 'qwen-vl-max');
  assert.equal(remodeled.verification.status, 'unverified');
});

test('credential-set-endpoint IPC updates custom records only', async (t) => {
  const { handlers } = setup(t);
  const created = await handlers['credential-create']({}, {
    name: 'Gateway', provider: 'custom', model: 'qwen-vl', key: 'k-1', baseUrl: BASE,
  });
  assert.equal(created.ok, true);
  const updated = await handlers['credential-set-endpoint']({}, created.credential.id, 'https://two.example/v1');
  assert.equal(updated.ok, true);
  assert.equal(updated.credential.baseUrl, 'https://two.example/v1');

  const curated = await handlers['credential-create']({}, {
    name: 'Meta', provider: 'meta', model: 'muse-spark-1.3', key: 'k-2',
  });
  const rejected = await handlers['credential-set-endpoint']({}, curated.credential.id, BASE);
  assert.equal(rejected.ok, false);

  const badUrl = await handlers['credential-set-endpoint']({}, created.credential.id, 'http://plain.example/v1');
  assert.equal(badUrl.ok, false);
});

test('custom-models IPC discovers via saved credentials without key IPC', async (t) => {
  const calls = [];
  const { handlers } = setup(t, {
    spawnSetup: async (input) => {
      calls.push(input);
      return { ok: true, provider: 'custom', models: [{ id: 'a-vision', vision: 'unverified' }] };
    },
  });
  const created = await handlers['credential-create']({}, {
    name: 'Gateway', provider: 'custom', model: 'qwen-vl', key: 'vault-secret-7', baseUrl: BASE,
  });
  const result = await handlers['custom-models']({}, { credentialId: created.credential.id });
  assert.equal(result.ok, true);
  assert.deepEqual(result.models, [{ id: 'a-vision' }]);
  assert.equal(JSON.stringify(result).includes('vault-secret-7'), false);
  // The child receives the decrypted key + pinned endpoint; nothing else.
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].provider, { id: 'custom', baseUrl: BASE });
  assert.equal(calls[0].operation, 'models');
  assert.equal(calls[0].key, 'vault-secret-7');

  const curated = await handlers['credential-create']({}, {
    name: 'Meta', provider: 'meta', model: 'muse-spark-1.3', key: 'k-2',
  });
  const refused = await handlers['custom-models']({}, { credentialId: curated.credential.id });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'config');
});

test('custom-models IPC supports one-shot pre-create discovery', async (t) => {
  const { handlers } = setup(t, {
    spawnSetup: async () => ({ ok: true, provider: 'custom', models: [] }),
  });
  const result = await handlers['custom-models']({}, { baseUrl: BASE, key: 'typed-secret-3' });
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(result).includes('typed-secret-3'), false);

  const badUrl = await handlers['custom-models']({}, { baseUrl: 'https://localhost/v1', key: 'k' });
  assert.equal(badUrl.ok, false);
  assert.match(badUrl.error, /local or private/);
  const noKey = await handlers['custom-models']({}, { baseUrl: BASE, key: '' });
  assert.equal(noKey.ok, false);
});

test('custom-models IPC preserves discovery-unsupported for manual fallback', async (t) => {
  const { handlers } = setup(t, {
    spawnSetup: async () => ({
      ok: false, error: 'This endpoint does not list models. Enter the model ID manually.',
      code: 'discovery_unsupported', status: 404, provider: 'custom', operation: 'models', detail: 'HTTP 404',
    }),
  });
  const created = await handlers['credential-create']({}, {
    name: 'Gateway', provider: 'custom', model: 'qwen-vl', key: 'k-1', baseUrl: BASE,
  });
  const result = await handlers['custom-models']({}, { credentialId: created.credential.id });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'discovery_unsupported');
  assert.match(result.error, /manually/);
});

test('custom connection and verification checks pin the saved endpoint', async (t) => {
  const calls = [];
  const { handlers } = setup(t, {
    spawnSetup: async (input) => {
      calls.push(input);
      return input.operation === 'verify-vision'
        ? { ok: true, provider: 'custom', visionVerified: true }
        : { ok: true, provider: 'custom', connected: true };
    },
  });
  const created = await handlers['credential-create']({}, {
    name: 'Gateway', provider: 'custom', model: 'qwen-vl', key: 'k-1', baseUrl: BASE,
  });
  const id = created.credential.id;
  const tested = await handlers['credential-test']({}, id);
  assert.deepEqual(tested, { ok: true, connected: true });
  const verified = await handlers['credential-verify']({}, id);
  assert.equal(verified.ok, true);
  assert.equal(verified.credential.verification.verifiedBaseUrl, BASE);
  assert.deepEqual(calls[0].provider, { id: 'custom', baseUrl: BASE });
  assert.deepEqual(calls[1].provider, { id: 'custom', baseUrl: BASE });
});
