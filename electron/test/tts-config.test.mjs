import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyTtsConfig,
  normalizePartialTtsConfig,
  normalizePreviewText,
  normalizeTtsCatalog,
  resolveTtsConfig,
  TTS_CONFIG_BOUNDS,
  TTS_PREVIEW_TEXT_MAX_LENGTH,
} from '../src/tts-config.mjs';

const CATALOG = {
  ok: true,
  models: [
    { id: 'gemini-3.8-flash-tts', description: 'Expressive.' },
    { id: 'gemini-3.8-flash-lite-tts', description: 'Fast.' },
  ],
  voices: [
    { id: 'Kore', character: 'Firm' },
    { id: 'Fenrir', character: 'Excitable' },
  ],
  defaults: {
    model: 'gemini-3.8-flash-tts',
    voice: 'Kore',
    voiceDirection: 'Energetic esports commentator.',
  },
  limits: { voiceMaxLength: 64, voiceDirectionMaxLength: 500 },
};

test('partial layers normalize: missing means inherit, unknowns rejected', () => {
  assert.deepEqual(normalizePartialTtsConfig(null), emptyTtsConfig());
  assert.deepEqual(normalizePartialTtsConfig(undefined), emptyTtsConfig());
  assert.deepEqual(normalizePartialTtsConfig({ voice: 'Fenrir' }), {
    model: null, voice: 'Fenrir', voiceDirection: null, credentialId: null,
  });
  assert.equal(normalizePartialTtsConfig({ voice: '  Kore ' }).voice, 'Kore');
  assert.throws(() => normalizePartialTtsConfig({ tempo: 2 }), /Unknown TTS configuration field/);
  assert.throws(() => normalizePartialTtsConfig('Kore'), /Invalid TTS configuration/);
});

test('partial layers enforce bounds', () => {
  assert.throws(
    () => normalizePartialTtsConfig({ voice: '' }),
    /Invalid TTS configuration field 'voice'/,
  );
  assert.throws(
    () => normalizePartialTtsConfig({ voice: 'v'.repeat(TTS_CONFIG_BOUNDS.voiceMaxLength + 1) }),
    /Invalid TTS configuration field 'voice'/,
  );
  assert.throws(
    () => normalizePartialTtsConfig({ voiceDirection: '   ' }),
    /Invalid TTS configuration field 'voiceDirection'/,
  );
  assert.throws(
    () => normalizePartialTtsConfig({ voiceDirection: 'd'.repeat(TTS_CONFIG_BOUNDS.voiceDirectionMaxLength + 1) }),
    /Invalid TTS configuration field 'voiceDirection'/,
  );
  assert.throws(
    () => normalizePartialTtsConfig({ model: '' }),
    /Invalid TTS configuration field 'model'/,
  );
  assert.throws(
    () => normalizePartialTtsConfig({ credentialId: '' }),
    /Invalid TTS configuration field 'credentialId'/,
  );
});

test('catalogue validation rejects corrupt probe output', () => {
  const catalog = normalizeTtsCatalog(CATALOG);
  assert.equal(catalog.models.length, 2);
  assert.equal(catalog.voices.length, 2);
  assert.throws(() => normalizeTtsCatalog(null), /unavailable/);
  assert.throws(() => normalizeTtsCatalog({ ok: false }), /unavailable/);
  assert.throws(() => normalizeTtsCatalog({ ...CATALOG, models: [] }), /incomplete/);
  assert.throws(() => normalizeTtsCatalog({ ...CATALOG, voices: [] }), /incomplete/);
  assert.throws(
    () => normalizeTtsCatalog({ ...CATALOG, defaults: { ...CATALOG.defaults, model: 'other' } }),
    /default model is not listed/,
  );
  assert.throws(
    () => normalizeTtsCatalog({ ...CATALOG, defaults: { ...CATALOG.defaults, voice: 'other' } }),
    /default voice is not listed/,
  );
  assert.throws(
    () => normalizeTtsCatalog({ ...CATALOG, models: [{ id: '' }] }),
    /invalid model/,
  );
});

test('resolution precedence: project > global > app default', () => {
  const catalog = normalizeTtsCatalog(CATALOG);
  const resolved = resolveTtsConfig({
    catalog,
    globalTts: { voice: 'Fenrir', voiceDirection: 'Global style.' },
    projectTts: { voiceDirection: 'Project style.' },
  });
  assert.deepEqual(resolved.config, {
    model: 'gemini-3.8-flash-tts',
    voice: 'Fenrir',
    voiceDirection: 'Project style.',
  });
  assert.deepEqual(resolved.sources, { model: 'appDefault', voice: 'global', voiceDirection: 'project' });
  assert.equal(resolved.credentialId, null);
  assert.equal(resolved.credentialSource, null);
});

test('resolution falls back fully and tracks credential source', () => {
  const catalog = normalizeTtsCatalog(CATALOG);
  const resolved = resolveTtsConfig({ catalog, globalTts: null, projectTts: null });
  assert.deepEqual(resolved.config, { ...CATALOG.defaults });
  assert.deepEqual(resolved.sources, { model: 'appDefault', voice: 'appDefault', voiceDirection: 'appDefault' });

  const withCredential = resolveTtsConfig({
    catalog,
    globalTts: { credentialId: 'cred-global' },
    projectTts: { credentialId: 'cred-project' },
  });
  assert.equal(withCredential.credentialId, 'cred-project');
  assert.equal(withCredential.credentialSource, 'project');

  const inherited = resolveTtsConfig({
    catalog,
    globalTts: { credentialId: 'cred-global' },
    projectTts: { voice: 'Fenrir' },
  });
  assert.equal(inherited.credentialId, 'cred-global');
  assert.equal(inherited.credentialSource, 'global');
});

test('resolution rejects off-catalogue models without substitution', () => {
  const catalog = normalizeTtsCatalog(CATALOG);
  assert.throws(
    () => resolveTtsConfig({ catalog, globalTts: { model: 'gemini-2.0-flash' } }),
    /Unsupported TTS model/,
  );
  assert.throws(() => resolveTtsConfig({ catalog: null }), /catalogue is required/);
});

test('preview text is non-empty and bounded', () => {
  assert.equal(normalizePreviewText('Hello.'), 'Hello.');
  assert.throws(() => normalizePreviewText(''), /must not be empty/);
  assert.throws(() => normalizePreviewText('   '), /must not be empty/);
  assert.throws(() => normalizePreviewText('--model x'), /must not start with a dash/);
  assert.throws(
    () => normalizePreviewText('x'.repeat(TTS_PREVIEW_TEXT_MAX_LENGTH + 1)),
    /under 501 characters/,
  );
});
