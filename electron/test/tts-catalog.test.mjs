import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createTtsCatalogLoader,
  parseCatalogOutput,
  ttsCatalogScript,
} from '../src/tts-catalog.mjs';

const PROBE_JSON = JSON.stringify({
  ok: true,
  models: [{ id: 'gemini-3.8-flash-tts', description: 'Expressive.' }],
  voices: [{ id: 'Kore', character: 'Firm' }],
  defaults: { model: 'gemini-3.8-flash-tts', voice: 'Kore', voiceDirection: 'Style.' },
  limits: { voiceMaxLength: 64, voiceDirectionMaxLength: 500 },
});

function tempRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-tts-cat-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const venvBin = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin');
  fs.mkdirSync(venvBin, { recursive: true });
  fs.writeFileSync(path.join(venvBin, process.platform === 'win32' ? 'python.exe' : 'python'), '');
  return root;
}

function fakeSpawn({ stdout = PROBE_JSON, code = 0, seen = null } = {}) {
  return (executable, args) => {
    if (seen) seen.calls.push({ executable, args });
    return {
      stdout: { on: (event, fn) => { if (event === 'data') fn(stdout); } },
      on: (event, fn) => { if (event === 'close') fn(code); },
      kill: () => {},
    };
  };
}

test('catalogue script resolves under the repository python tree', async (t) => {
  const root = tempRepo(t);
  assert.equal(ttsCatalogScript(root), path.join(root, 'python', 'tts_catalog.py'));
});

test('probe output parses the last line and validates shape', () => {
  const catalog = parseCatalogOutput(`diagnostic noise\n${PROBE_JSON}\n`);
  assert.equal(catalog.models[0].id, 'gemini-3.8-flash-tts');
  assert.throws(() => parseCatalogOutput('not json'), /invalid response/);
  assert.throws(() => parseCatalogOutput(JSON.stringify({ ok: false })), /unavailable/);
});

test('loader caches the catalogue for the session', async (t) => {
  const root = tempRepo(t);
  const seen = { calls: [] };
  const loader = createTtsCatalogLoader({ repoRoot: root, spawnFn: fakeSpawn({ seen }) });
  const first = await loader.load();
  const second = await loader.load();
  assert.equal(first, second);
  assert.equal(seen.calls.length, 1);
  loader.reset();
  await loader.load();
  assert.equal(seen.calls.length, 2);
});

test('loader fails closed without a virtual environment', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-tts-cat-novenv-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const loader = createTtsCatalogLoader({ repoRoot: root, spawnFn: fakeSpawn() });
  await assert.rejects(() => loader.load(), /Python virtual environment is not configured/);
});

test('loader surfaces probe failure without caching it', async (t) => {
  const root = tempRepo(t);
  const seen = { calls: [] };
  const loader = createTtsCatalogLoader({ repoRoot: root, spawnFn: fakeSpawn({ seen, code: 1 }) });
  await assert.rejects(() => loader.load(), /probe failed/);
  await assert.rejects(() => loader.load(), /probe failed/);
  assert.equal(seen.calls.length, 2);
});
