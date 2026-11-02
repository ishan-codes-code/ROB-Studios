import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SETTINGS } from '../src/settings-defaults.mjs';
import { loadSettings, saveSettings, validateSettings } from '../src/settings-store.mjs';

function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-settings-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }

test('settings default safely and round-trip without a credential field', (t) => {
  const dir = temp(t);
  assert.equal(loadSettings(dir).game.id, 'free-fire');
  const result = saveSettings(dir, { ...DEFAULT_SETTINGS, prompt: { ...DEFAULT_SETTINGS.prompt, language: 'Hindi' } });
  assert.equal(loadSettings(dir).prompt.language, 'Hindi');
  assert.equal(JSON.stringify(result).includes('apiKey'), false);
});

test('secret-like unknown fields are stripped before persistence', (t) => {
  const dir = temp(t);
  const settings = { ...DEFAULT_SETTINGS, provider: { ...DEFAULT_SETTINGS.provider, apiKey: 'must-not-persist' } };
  saveSettings(dir, settings);
  assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8').includes('must-not-persist'), false);
});

test('settings reject unsafe URLs and unsupported games', () => {
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, provider: { ...DEFAULT_SETTINGS.provider, baseUrl: 'http://example.com' } }), /HTTPS/);
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, game: { id: 'unknown', context: '' } }), /Unsupported game/);
});

test('partial existing settings are defaulted during load', (t) => {
  const dir = temp(t);
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ prompt: { language: 'Japanese' } }));
  const result = loadSettings(dir);
  assert.equal(result.game.id, 'free-fire');
  assert.equal(result.prompt.language, 'Japanese');
});

test('global TTS layer persists, reloads, and trims voice input', (t) => {
  const dir = temp(t);
  const saved = saveSettings(dir, {
    ...DEFAULT_SETTINGS,
    tts: { model: null, voice: '  Fenrir ', voiceDirection: 'Calm and measured.', credentialId: null },
  });
  assert.deepEqual(saved.tts, { model: null, voice: 'Fenrir', voiceDirection: 'Calm and measured.', credentialId: null });
  // A fresh load (application restart) returns the same layer.
  assert.deepEqual(loadSettings(dir).tts, saved.tts);
});

test('legacy settings without a TTS section inherit fully', (t) => {
  const dir = temp(t);
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ prompt: { language: 'Japanese' } }));
  assert.deepEqual(loadSettings(dir).tts, { model: null, voice: null, voiceDirection: null, credentialId: null });
});

test('global TTS layer rejects overlong and unknown fields', () => {
  assert.throws(
    () => validateSettings({ ...DEFAULT_SETTINGS, tts: { voice: 'v'.repeat(65) } }),
    /Invalid TTS configuration field 'voice'/,
  );
  assert.throws(
    () => validateSettings({ ...DEFAULT_SETTINGS, tts: { tempo: 2 } }),
    /Unknown TTS configuration field/,
  );
});
