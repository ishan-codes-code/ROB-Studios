// Temporary development-only secure-storage bypass: memory-held
// credentials when OS encryption is unavailable. Every test restores
// the module-level bypass flag so the default-off state never leaks.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerSettingsIpc } from '../src/main/ipc/settings.js';
import { registerTtsIpc } from '../src/main/ipc/tts.js';
import {
  clearDevCredentials,
  getCredentialForRun,
  isCredentialVerifiedForRun,
  isDevBypassActive,
  isDevBypassEnabled,
  listCredentials,
  markCredentialVerified,
  setDevBypassEnabled,
  vaultPath,
  credentialsDir,
} from '../src/credentials-store.mjs';

const downStorage = () => ({
  isEncryptionAvailable: () => false,
  encryptString: () => { throw new Error('no encryption'); },
  decryptString: () => { throw new Error('no encryption'); },
});

const upStorage = () => ({
  isEncryptionAvailable: () => true,
  encryptString: (v) => Buffer.from(`enc:${Buffer.from(String(v), 'utf8').toString('base64')}`, 'utf8'),
  decryptString: (buf) => Buffer.from(String(buf == null ? '' : buf).replace(/^enc:/, ''), 'base64').toString('utf8'),
});

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function resetBypass(t) {
  t.after(() => {
    setDevBypassEnabled(false, { isPackaged: false });
  });
}

function setup(t, { safeStorage, isPackaged = false, spawnSetup = async () => ({ ok: true, connected: true }) } = {}) {
  const dir = tempDir(t, 'ai-dev-bypass-');
  resetBypass(t);
  const handlers = {};
  registerSettingsIpc({
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
    app: { getPath: () => dir, isPackaged },
    safeStorage: safeStorage ?? downStorage(),
    spawnSetup,
  });
  return { dir, handlers };
}

function walkFiles(root) {
  const out = [];
  const visit = (entry) => {
    let stat;
    try {
      stat = fs.statSync(entry);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(entry)) visit(path.join(entry, child));
    } else if (stat.isFile()) {
      out.push(entry);
    }
  };
  visit(root);
  return out;
}

// Must stay first: the bypass defaults to OFF on a fresh import.
test('development bypass is disabled by default', () => {
  assert.equal(isDevBypassEnabled(), false);
  assert.equal(isDevBypassActive(downStorage()), false);
  assert.equal(isDevBypassActive(upStorage()), false);
});

test('unpackaged builds can enable and disable the bypass', async (t) => {
  const { handlers } = setup(t);
  const initial = await handlers['dev-bypass-get']();
  assert.deepEqual(initial, { ok: true, supported: true, enabled: false });
  const enabled = await handlers['dev-bypass-set']({}, true);
  assert.deepEqual(enabled, { ok: true, supported: true, enabled: true });
  assert.equal(isDevBypassEnabled(), true);
  assert.equal(isDevBypassActive(downStorage()), true);
  // Encryption available means the bypass stays dormant: secure wins.
  assert.equal(isDevBypassActive(upStorage()), false);
  const disabled = await handlers['dev-bypass-set']({}, false);
  assert.deepEqual(disabled, { ok: true, supported: true, enabled: false });
});

test('packaged builds reject the bypass', async (t) => {
  const dir = tempDir(t, 'ai-dev-bypass-prod-');
  resetBypass(t);
  const handlers = {};
  registerSettingsIpc({
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
    app: { getPath: () => dir, isPackaged: true },
    safeStorage: downStorage(),
    spawnSetup: async () => ({ ok: true }),
  });
  assert.deepEqual(await handlers['dev-bypass-get'](), { ok: true, supported: false, enabled: false });
  const rejected = await handlers['dev-bypass-set']({}, true);
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /not available in production builds/);
  assert.equal(isDevBypassEnabled(), false);
  assert.throws(
    () => setDevBypassEnabled(true, { isPackaged: true }),
    /not available in production builds/,
  );
});

test('bypass off preserves the secure-storage requirement', async (t) => {
  const { handlers } = setup(t);
  const created = await handlers['credential-create']({}, {
    name: 'K', provider: 'meta', model: 'muse-spark-1.3', key: 'secret',
  });
  assert.equal(created.ok, false);
  // List reports the outage instead of failing: empty, flagged unavailable.
  const listed = await handlers['credential-list']();
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.credentials, []);
  assert.equal(listed.secureStorageAvailable, false);
});

test('memory credentials: create, list, rename, set-key, verify, delete', async (t) => {
  const { dir, handlers } = setup(t);
  await handlers['dev-bypass-set']({}, true);
  const visionKey = 'dev-bypass-vision-key-1';
  const ttsKey = 'dev-bypass-tts-key-2';
  const vision = await handlers['credential-create']({}, {
    name: 'Dev Vision', provider: 'meta', model: 'muse-spark-1.3', key: visionKey,
  });
  const tts = await handlers['credential-create']({}, {
    name: 'Dev TTS', provider: 'google-gemini-tts', model: null, key: ttsKey,
  });
  assert.equal(vision.ok, true);
  assert.equal(tts.ok, true);
  assert.equal(vision.credential.devOnly, true);
  assert.equal(vision.credential.keyAvailable, true);
  assert.equal(tts.credential.purpose, 'tts');

  const listed = await handlers['credential-list']();
  assert.equal(listed.ok, true);
  assert.equal(listed.credentials.length, 2);
  assert.ok(listed.credentials.every((entry) => entry.devOnly === true));
  assert.equal(JSON.stringify(listed).includes(visionKey), false);
  assert.equal(JSON.stringify(listed).includes(ttsKey), false);

  const renamed = await handlers['credential-rename']({}, vision.credential.id, 'Dev Vision 2');
  assert.equal(renamed.ok, true);
  assert.equal(renamed.credential.name, 'Dev Vision 2');

  const rotated = await handlers['credential-set-key']({}, tts.credential.id, 'dev-bypass-tts-key-3');
  assert.equal(rotated.ok, true);

  const run = getCredentialForRun(dir, downStorage(), vision.credential.id);
  assert.equal(run.apiKey, visionKey);
  assert.equal(run.provider, 'meta');

  const verified = markCredentialVerified(dir, downStorage(), vision.credential.id, 'muse-spark-1.3');
  assert.equal(verified.verification.status, 'verified');
  const stored = getCredentialForRun(dir, downStorage(), vision.credential.id);
  assert.equal(isCredentialVerifiedForRun(stored.record), true);

  const deleted = await handlers['credential-remove']({}, vision.credential.id);
  assert.equal(deleted.ok, true);
  const relisted = await handlers['credential-list']();
  assert.equal(relisted.credentials.length, 1);
  assert.throws(() => getCredentialForRun(dir, downStorage(), vision.credential.id));
});

test('verification flows run against memory credentials', async (t) => {
  const seen = [];
  const { handlers } = setup(t, {
    spawnSetup: async (input) => {
      seen.push(input);
      if (input.operation === 'verify-vision') return { ok: true, visionVerified: true };
      if (input.operation === 'verify-tts-auth') {
        return { ok: true, ttsAuthenticated: true, ttsModelMetadataAvailable: true };
      }
      return { ok: true, connected: true };
    },
  });
  await handlers['dev-bypass-set']({}, true);
  const vision = await handlers['credential-create']({}, {
    name: 'V', provider: 'meta', model: 'muse-spark-1.3', key: 'verify-memory-vision',
  });
  const tts = await handlers['credential-create']({}, {
    name: 'T', provider: 'google-gemini-tts', model: null, key: 'verify-memory-tts',
  });
  const visionCheck = await handlers['credential-verify']({}, vision.credential.id);
  assert.equal(visionCheck.ok, true);
  const ttsCheck = await handlers['credential-verify']({}, tts.credential.id);
  assert.equal(ttsCheck.ok, true);
  // The exact memory keys reached the setup probe through the key slot.
  assert.ok(seen.some((call) => call.key === 'verify-memory-vision'));
  assert.ok(seen.some((call) => call.key === 'verify-memory-tts'));
  const listed = await handlers['credential-list']();
  assert.ok(listed.credentials.every((entry) => entry.verification.status === 'verified'));
  assert.equal(JSON.stringify(listed).includes('verify-memory-vision'), false);
});

test('memory lifecycle writes no key material to disk', async (t) => {
  const { dir, handlers } = setup(t);
  await handlers['dev-bypass-set']({}, true);
  const key = 'dev-bypass-never-on-disk-7';
  const created = await handlers['credential-create']({}, {
    name: 'Ephemeral', provider: 'meta', model: 'muse-spark-1.3', key,
  });
  await handlers['credential-set-key']({}, created.credential.id, `${key}-rotated`);
  await handlers['credential-rename']({}, created.credential.id, 'Ephemeral 2');
  await handlers['credential-remove']({}, created.credential.id);
  for (const file of walkFiles(dir)) {
    const content = fs.readFileSync(file);
    assert.equal(content.includes(key), false, `key leaked into ${file}`);
    assert.equal(content.includes(`${key}-rotated`), false, `rotated key leaked into ${file}`);
  }
  assert.equal(fs.existsSync(vaultPath(dir)), false);
  assert.equal(fs.existsSync(credentialsDir(dir)), false);
});

test('disabling the bypass wipes memory credentials immediately', async (t) => {
  const { dir, handlers } = setup(t);
  await handlers['dev-bypass-set']({}, true);
  const created = await handlers['credential-create']({}, {
    name: 'Temp', provider: 'meta', model: 'muse-spark-1.3', key: 'wipe-me',
  });
  assert.equal(created.ok, true);
  await handlers['dev-bypass-set']({}, false);
  assert.throws(() => getCredentialForRun(dir, downStorage(), created.credential.id));
  const listed = await handlers['credential-list']();
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.credentials, []);
  assert.equal(listed.secureStorageAvailable, false);
});

test('shutdown clearing removes memory credentials', async (t) => {
  const { dir, handlers } = setup(t);
  await handlers['dev-bypass-set']({}, true);
  const created = await handlers['credential-create']({}, {
    name: 'Temp', provider: 'meta', model: 'muse-spark-1.3', key: 'quit-me',
  });
  clearDevCredentials();
  assert.throws(() => getCredentialForRun(dir, downStorage(), created.credential.id));
  const listed = await handlers['credential-list']();
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.credentials, []);
  // main.js wires the shutdown hook.
  const mainSource = fs.readFileSync(
    new URL('../src/main.js', import.meta.url), 'utf8',
  );
  assert.match(mainSource, /clearDevCredentials/);
  assert.match(mainSource, /before-quit/);
});

test('secure storage stays preferred when available', async (t) => {
  const dir = tempDir(t, 'ai-dev-bypass-pref-');
  resetBypass(t);
  const handlers = {};
  registerSettingsIpc({
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
    app: { getPath: () => dir, isPackaged: false },
    safeStorage: upStorage(),
    spawnSetup: async () => ({ ok: true }),
  });
  await handlers['dev-bypass-set']({}, true);
  const created = await handlers['credential-create']({}, {
    name: 'Secure', provider: 'meta', model: 'muse-spark-1.3', key: 'stays-encrypted',
  });
  assert.equal(created.ok, true);
  assert.equal(created.credential.devOnly, false);
  assert.equal(fs.existsSync(vaultPath(dir)), true);
});

test('TTS preview synthesizes with a memory credential', async (t) => {
  const dir = tempDir(t, 'ai-dev-bypass-tts-');
  resetBypass(t);
  setDevBypassEnabled(true, { isPackaged: false });
  const settingsHandlers = {};
  registerSettingsIpc({
    ipcMain: { handle: (name, fn) => { settingsHandlers[name] = fn; } },
    app: { getPath: () => dir, isPackaged: false },
    safeStorage: downStorage(),
    spawnSetup: async () => ({ ok: true }),
  });
  const created = await settingsHandlers['credential-create']({}, {
    name: 'Dev TTS', provider: 'google-gemini-tts', model: null, key: 'preview-memory-key',
  });
  markCredentialVerified(dir, downStorage(), created.credential.id, null);

  const catalog = {
    models: [{ id: 'gemini-3.8-flash-tts', description: '' }],
    voices: [{ id: 'Kore', character: '' }],
    defaults: { model: 'gemini-3.8-flash-tts', voice: 'Kore', voiceDirection: 'Style.' },
    limits: { voiceMaxLength: 64, voiceDirectionMaxLength: 500 },
  };
  const seen = [];
  const ttsHandlers = {};
  registerTtsIpc({
    ipcMain: { handle: (name, fn) => { ttsHandlers[name] = fn; } },
    app: { getPath: () => dir },
    safeStorage: downStorage(),
    repoRoot: dir,
    catalogLoader: { load: async () => catalog, reset: () => {} },
    runPreview: async (request) => {
      seen.push(request);
      const out = request.args[request.args.indexOf('--out') + 1];
      fs.writeFileSync(out, Buffer.from('RIFFdev'));
      return { ok: true, stderr: '' };
    },
  });
  // Fake interpreter so preview path resolution succeeds (never executed).
  const venvBin = path.join(dir, '.venv', 'bin');
  fs.mkdirSync(venvBin, { recursive: true });
  fs.writeFileSync(path.join(venvBin, 'python'), '');
  const result = await ttsHandlers['tts-preview']({}, {
    text: 'Hello from memory.',
    model: 'gemini-3.8-flash-tts',
    voice: 'Kore',
    voiceDirection: 'Style.',
    credentialId: created.credential.id,
  });
  assert.equal(result.ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].key, 'preview-memory-key');
  assert.equal(seen[0].args.join(' ').includes('preview-memory-key'), false);
  assert.equal(JSON.stringify(result).includes('preview-memory-key'), false);
});
