import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildPackSnapshot,
  createPromptPackLoader,
  getPromptPack,
  listPromptPacks,
  normalizeFactoryPacks,
  parsePacksOutput,
  promptPacksScript,
  resetPromptPack,
  setPromptField,
} from '../src/prompt-packs.mjs';

const FIELD_META = {
  vision_intro: { label: 'Vision subject', description: '', max_chars: 500 },
  script_closing: { label: 'Script closing', description: '', max_chars: 500 },
};

function probeDoc(overrides = {}) {
  return {
    ok: true,
    schema_version: 'game-pack-v1',
    version: 1,
    default_pack_id: 'free-fire',
    fields: FIELD_META,
    packs: [
      {
        pack_id: 'free-fire',
        display_name: 'Free Fire',
        version: 1,
        fields: { vision_intro: 'Factory vision.', script_closing: 'Factory closing.' },
      },
      {
        pack_id: 'cod',
        display_name: 'Call of Duty',
        version: 1,
        fields: { vision_intro: 'COD vision.', script_closing: 'COD closing.' },
      },
    ],
    ...overrides,
  };
}

function factory() {
  return normalizeFactoryPacks(probeDoc());
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-packs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function tempRepo(t) {
  const root = tempDir(t);
  const venvBin = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin');
  fs.mkdirSync(venvBin, { recursive: true });
  fs.writeFileSync(path.join(venvBin, process.platform === 'win32' ? 'python.exe' : 'python'), '');
  fs.mkdirSync(path.join(root, 'python'), { recursive: true });
  fs.writeFileSync(path.join(root, 'python', 'prompt_packs.py'), '');
  return root;
}

function fakeSpawn({ stdout = JSON.stringify(probeDoc()), code = 0, seen = null } = {}) {
  return (executable, args) => {
    if (seen) seen.calls.push({ executable, args });
    return {
      stdout: { on: (event, fn) => { if (event === 'data') fn(stdout); } },
      on: (event, fn) => { if (event === 'close') fn(code); },
      kill: () => {},
    };
  };
}

test('probe script resolves under the repository python tree', async (t) => {
  const root = tempRepo(t);
  assert.equal(promptPacksScript(root), path.join(root, 'python', 'prompt_packs.py'));
});

test('probe output parses the last line and validates shape', () => {
  const parsed = parsePacksOutput(`diagnostic noise\n${JSON.stringify(probeDoc())}\n`);
  assert.equal(parsed.packs.length, 2);
  assert.equal(parsed.defaultPackId, 'free-fire');
  assert.throws(() => parsePacksOutput('not json'), /invalid response/);
  assert.throws(() => parsePacksOutput(JSON.stringify({ ok: false })), /invalid response/);
  assert.throws(() => parsePacksOutput(JSON.stringify(probeDoc({ schema_version: 'x' }))), /unsupported schema/);
  assert.throws(() => parsePacksOutput(JSON.stringify(probeDoc({ packs: [] }))), /pack list/);
});

test('loader caches factory packs for the session', async (t) => {
  const root = tempRepo(t);
  const seen = { calls: [] };
  const loader = createPromptPackLoader({ repoRoot: root, spawnFn: fakeSpawn({ seen }) });
  const first = await loader.load();
  const second = await loader.load();
  assert.equal(first, second);
  assert.equal(seen.calls.length, 1);
  loader.reset();
  await loader.load();
  assert.equal(seen.calls.length, 2);
});

test('loader fails cleanly without a venv or on probe failure', async (t) => {
  const bare = tempDir(t);
  const missing = createPromptPackLoader({ repoRoot: bare, spawnFn: fakeSpawn() });
  await assert.rejects(() => missing.load(), /virtual environment/);
  const root = tempRepo(t);
  const failing = createPromptPackLoader({ repoRoot: root, spawnFn: fakeSpawn({ code: 1 }) });
  await assert.rejects(() => failing.load(), /probe failed/);
});

test('listing starts at pure factory defaults', async (t) => {
  const dir = tempDir(t);
  const packs = listPromptPacks(dir, factory());
  assert.equal(packs.length, 2);
  for (const pack of packs) {
    assert.deepEqual(pack.customized, []);
    assert.deepEqual(pack.effective, pack.fields);
  }
  assert.equal(packs[0].fields.vision_intro, 'Factory vision.');
});

test('custom fields overlay factory without modifying it', async (t) => {
  const dir = tempDir(t);
  const before = factory();
  const updated = setPromptField(dir, before, 'cod', 'script_closing', 'Custom closing.');
  assert.deepEqual(updated.customized, ['script_closing']);
  assert.equal(updated.effective.script_closing, 'Custom closing.');
  assert.equal(updated.fields.script_closing, 'COD closing.');
  // Factory document untouched; store holds custom text only.
  assert.equal(before.packs[1].fields.script_closing, 'COD closing.');
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'prompt-packs.json'), 'utf8'));
  assert.deepEqual(stored, { version: 1, custom: { cod: { script_closing: 'Custom closing.' } } });
  // A fresh read overlays the same customization.
  const relisted = getPromptPack(dir, factory(), 'cod');
  assert.equal(relisted.effective.script_closing, 'Custom closing.');
});

test('empty text resets one field; reset clears the pack', async (t) => {
  const dir = tempDir(t);
  setPromptField(dir, factory(), 'cod', 'script_closing', 'Custom closing.');
  setPromptField(dir, factory(), 'cod', 'vision_intro', 'Custom vision.');
  const cleared = setPromptField(dir, factory(), 'cod', 'vision_intro', '   ');
  assert.deepEqual(cleared.customized, ['script_closing']);
  assert.equal(cleared.effective.vision_intro, 'COD vision.');
  const reset = resetPromptPack(dir, factory(), 'cod');
  assert.deepEqual(reset.customized, []);
  assert.deepEqual(reset.effective, reset.fields);
});

test('invalid pack, field, and text are rejected', async (t) => {
  const dir = tempDir(t);
  assert.throws(() => setPromptField(dir, factory(), 'nope', 'script_closing', 'x'), /not found/);
  assert.throws(() => setPromptField(dir, factory(), 'cod', 'nope', 'x'), /Unknown prompt field/);
  assert.throws(() => setPromptField(dir, factory(), 'cod', 'script_closing', 'x'.repeat(501)), /exceeds 500/);
  assert.throws(() => resetPromptPack(dir, factory(), 'nope'), /not found/);
  assert.throws(() => getPromptPack(dir, factory(), 'nope'), /not found/);
});

test('corrupt store fails loudly', async (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'prompt-packs.json'), '{broken');
  assert.throws(() => listPromptPacks(dir, factory()), /corrupted/);
});

test('run snapshot defaults, selects, and overlays customs', async (t) => {
  const dir = tempDir(t);
  assert.deepEqual(buildPackSnapshot(dir, factory(), null), { packId: 'free-fire', custom: {} });
  assert.deepEqual(buildPackSnapshot(dir, factory(), 'cod'), { packId: 'cod', custom: {} });
  setPromptField(dir, factory(), 'cod', 'script_closing', 'Custom closing.');
  assert.deepEqual(buildPackSnapshot(dir, factory(), 'cod'), {
    packId: 'cod',
    custom: { script_closing: 'Custom closing.' },
  });
  // Other packs are unaffected by the overlay.
  assert.deepEqual(buildPackSnapshot(dir, factory(), 'free-fire'), { packId: 'free-fire', custom: {} });
  assert.throws(() => buildPackSnapshot(dir, factory(), 'bad id!'), /Invalid prompt pack/);
});

test('run snapshot maps the project game when no pack is selected', async (t) => {
  const dir = tempDir(t);
  assert.deepEqual(buildPackSnapshot(dir, factory(), null, 'bgmi'), { packId: 'bgmi', custom: {} });
  assert.deepEqual(buildPackSnapshot(dir, factory(), null, 'cod'), { packId: 'cod', custom: {} });
  assert.deepEqual(buildPackSnapshot(dir, factory(), null, 'free-fire'), { packId: 'free-fire', custom: {} });
  assert.deepEqual(buildPackSnapshot(dir, factory(), null, null), { packId: 'free-fire', custom: {} });
  assert.deepEqual(buildPackSnapshot(dir, factory(), null, 'unknown-game'), { packId: 'free-fire', custom: {} });
  // An explicit selection always wins over the game default.
  assert.deepEqual(buildPackSnapshot(dir, factory(), 'cod', 'bgmi'), { packId: 'cod', custom: {} });
});

test('run snapshot passes customs through without factory', async (t) => {
  const dir = tempDir(t);
  setPromptField(dir, factory(), 'cod', 'script_closing', 'Custom closing.');
  assert.deepEqual(buildPackSnapshot(dir, null, 'cod'), {
    packId: 'cod',
    custom: { script_closing: 'Custom closing.' },
  });
  assert.deepEqual(buildPackSnapshot(dir, null, null), { packId: 'free-fire', custom: {} });
});

test('prompt pack IPC lists, saves, and resets through the loader', async (t) => {
  const { registerSettingsIpc } = await import('../src/main/ipc/settings.js');
  const dir = tempDir(t);
  const handlers = {};
  const ipcMain = { handle: (name, fn) => { handlers[name] = fn; } };
  const packsLoader = { load: async () => factory() };
  registerSettingsIpc({
    ipcMain,
    app: { getPath: () => dir },
    safeStorage: { isEncryptionAvailable: () => false },
    spawnSetup: async () => ({ ok: true }),
    packsLoader,
  });
  const listed = await handlers['prompt-pack-list']({});
  assert.equal(listed.ok, true);
  assert.equal(listed.packs.length, 2);
  assert.equal(listed.defaultPackId, 'free-fire');
  assert.ok(listed.fieldMeta.script_closing);
  const saved = await handlers['prompt-pack-set']({}, 'cod', 'script_closing', 'Custom closing.');
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.pack.customized, ['script_closing']);
  const rejected = await handlers['prompt-pack-set']({}, 'cod', 'nope', 'x');
  assert.equal(rejected.ok, false);
  const reset = await handlers['prompt-pack-reset']({}, 'cod');
  assert.equal(reset.ok, true);
  assert.deepEqual(reset.pack.customized, []);
});

test('prompt pack IPC fails closed without a loader', async (t) => {
  const { registerSettingsIpc } = await import('../src/main/ipc/settings.js');
  const dir = tempDir(t);
  const handlers = {};
  registerSettingsIpc({
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
    app: { getPath: () => dir },
    safeStorage: { isEncryptionAvailable: () => false },
    spawnSetup: async () => ({ ok: true }),
  });
  assert.equal((await handlers['prompt-pack-list']({})).ok, false);
  assert.equal((await handlers['prompt-pack-set']({}, 'cod', 'script_closing', 'x')).ok, false);
  assert.equal((await handlers['prompt-pack-reset']({}, 'cod')).ok, false);
});
