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

test('onboarding progress defaults, persists, and round-trips', (t) => {
  const dir = temp(t);
  assert.deepEqual(loadSettings(dir).onboarding, { step: 0, credentialId: null, dismissed: false });
  const saved = saveSettings(dir, {
    ...DEFAULT_SETTINGS,
    onboarding: { step: 3, credentialId: 'cred-abc123' },
  });
  assert.deepEqual(saved.onboarding, { step: 3, credentialId: 'cred-abc123', dismissed: false });
  assert.deepEqual(loadSettings(dir).onboarding, { step: 3, credentialId: 'cred-abc123', dismissed: false });
  // Completion does not require clearing; the flag stays authoritative.
  const done = saveSettings(dir, { ...saved, onboardingCompleted: true });
  assert.equal(done.onboardingCompleted, true);
});

test('legacy settings without onboarding progress start at step zero', (t) => {
  const dir = temp(t);
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ prompt: { language: 'Japanese' } }));
  assert.deepEqual(loadSettings(dir).onboarding, { step: 0, credentialId: null, dismissed: false });
});

test('malformed onboarding progress falls back instead of failing load', (t) => {
  const dir = temp(t);
  for (const onboarding of [{ step: 9 }, { step: -1, credentialId: 'x'.repeat(65) }, 'done', 42]) {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ onboarding }));
    assert.deepEqual(loadSettings(dir).onboarding, { step: 0, credentialId: null, dismissed: false });
  }
});

test('finish-later dismissal persists without completing setup', (t) => {
  const dir = temp(t);
  const saved = saveSettings(dir, {
    ...DEFAULT_SETTINGS,
    onboarding: { step: 2, credentialId: null, dismissed: true },
  });
  assert.deepEqual(saved.onboarding, { step: 2, credentialId: null, dismissed: true });
  assert.equal(saved.onboardingCompleted, false, 'dismissal never completes setup');
  const reloaded = loadSettings(dir);
  assert.deepEqual(reloaded.onboarding, { step: 2, credentialId: null, dismissed: true });
  assert.equal(reloaded.onboardingCompleted, false);
});

test('dismissal normalizes strictly to boolean', (t) => {
  const dir = temp(t);
  for (const dismissed of ['yes', 1, {}, []]) {
    const saved = saveSettings(dir, { ...DEFAULT_SETTINGS, onboarding: { step: 1, dismissed } });
    assert.equal(saved.onboarding.dismissed, false, JSON.stringify(dismissed));
  }
  const saved = saveSettings(dir, { ...DEFAULT_SETTINGS, onboarding: { step: 1, dismissed: true } });
  assert.equal(saved.onboarding.dismissed, true);
});
