import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BASETEN_MODEL,
  LEGACY_BASETEN_MODEL,
  PROVIDERS,
  getProviderBaseUrl,
  getProviderModels,
  isBlockedCustomHost,
  isSupportedModel,
  normalizeModelId,
  validateCustomBaseUrl,
  validateProviderModel,
} from '../src/provider-catalog.mjs';

test('Baseten pins the current documented model identifier', async () => {
  // Mirrors python/ai_commentator/vision/providers/baseten.py MODEL.
  assert.equal(BASETEN_MODEL, 'meta-models/muse-spark-open');
  assert.deepEqual(getProviderModels('baseten').map((m) => m.id), [BASETEN_MODEL]);
  assert.equal(isSupportedModel('baseten', BASETEN_MODEL), true);
  assert.equal(isSupportedModel('baseten', LEGACY_BASETEN_MODEL), false);
});

test('retired Baseten identifier normalizes instead of breaking saved configs', async () => {
  assert.equal(normalizeModelId('baseten', LEGACY_BASETEN_MODEL), BASETEN_MODEL);
  assert.equal(normalizeModelId('baseten', BASETEN_MODEL), BASETEN_MODEL);
  assert.equal(normalizeModelId('meta', 'muse-spark-1.3'), 'muse-spark-1.3');
  const validated = validateProviderModel('baseten', LEGACY_BASETEN_MODEL);
  assert.deepEqual(validated, { provider: 'baseten', model: BASETEN_MODEL });
  assert.throws(() => validateProviderModel('baseten', 'gpt-4'), /Unsupported model/);
});

test('Meta catalogue is unchanged', async () => {
  assert.deepEqual(
    getProviderModels('meta').map((m) => m.id),
    ['muse-spark-1.3', 'muse-wonder-1.0'],
  );
  assert.equal(PROVIDERS.baseten.fixedModel, true);
  assert.equal(PROVIDERS.meta.fixedModel, false);
});

test('Google Gemini TTS is a separate provider without fake Vision model metadata', () => {
  const tts = validateProviderModel('google-gemini-tts', null);
  assert.deepEqual(tts, { provider: 'google-gemini-tts', model: null });
  assert.equal(PROVIDERS['google-gemini-tts'].purpose, 'tts');
  assert.deepEqual(getProviderModels('google-gemini-tts'), []);
  assert.throws(() => validateProviderModel('google-gemini-tts', 'gemini-3.8-flash-tts'), /do not use a Vision model/);
  assert.throws(() => validateProviderModel('google-gemini-tts', ''), /do not use a Vision model/);
  assert.throws(() => validateProviderModel('unknown', null), /Unsupported provider/);
});

test('custom provider accepts explicit model IDs without a catalogue', () => {
  assert.equal(PROVIDERS.custom.customEndpoint, true);
  assert.deepEqual(getProviderModels('custom'), []);
  assert.deepEqual(validateProviderModel('custom', '  qwen-vl-max '), { provider: 'custom', model: 'qwen-vl-max' });
  assert.throws(() => validateProviderModel('custom', ''), /Vision model is required/);
  assert.throws(() => validateProviderModel('custom', 'x'.repeat(201)), /too long/);
  assert.throws(() => validateProviderModel('custom', 'bad\nid'), /invalid characters/);
});

test('custom base URLs must be public HTTPS without embedded parts', () => {
  assert.equal(validateCustomBaseUrl('https://llm.example.com/v1/'), 'https://llm.example.com/v1');
  assert.throws(() => validateCustomBaseUrl('http://llm.example.com/v1'), /HTTPS/);
  assert.throws(() => validateCustomBaseUrl('https://user:pw@llm.example.com/v1'), /HTTPS/);
  assert.throws(() => validateCustomBaseUrl('https://llm.example.com/v1?x=1'), /HTTPS/);
  assert.throws(() => validateCustomBaseUrl('https://llm.example.com/v1#frag'), /HTTPS/);
  assert.throws(() => validateCustomBaseUrl('not-a-url'), /valid HTTPS URL/);
  assert.throws(() => validateCustomBaseUrl(''), /required/);
});

test('custom endpoints block local and private-network targets', () => {
  for (const host of ['localhost', 'api.localhost', '127.0.0.1', '10.1.2.3', '172.16.0.9', '172.31.255.1', '192.168.1.1', '169.254.10.20', '0.0.0.0', '[::1]']) {
    assert.equal(isBlockedCustomHost(host), true, host);
    assert.throws(() => validateCustomBaseUrl(`https://${host}/v1`), /local or private/, host);
  }
  assert.equal(isBlockedCustomHost('::1'), true);
  assert.equal(isBlockedCustomHost('llm.example.com'), false);
  assert.equal(isBlockedCustomHost('8.8.8.8'), false);
  // Adjacent public ranges stay allowed: 172.15/172.32 are not private.
  assert.equal(isBlockedCustomHost('172.15.0.1'), false);
  assert.equal(isBlockedCustomHost('172.32.0.1'), false);
});

test('custom base URLs resolve from the record, never from curated state', () => {
  const record = { baseUrl: 'https://llm.example.com/v1' };
  assert.equal(getProviderBaseUrl('custom', record), 'https://llm.example.com/v1');
  assert.throws(() => getProviderBaseUrl('custom', null), /missing/);
  assert.throws(() => getProviderBaseUrl('custom', { baseUrl: 'http://x/v1' }), /HTTPS/);
  // Curated providers ignore the record argument entirely.
  assert.equal(getProviderBaseUrl('meta', { baseUrl: 'https://evil.example/v1' }), 'https://api.meta.ai/v1');
  assert.equal(getProviderBaseUrl('baseten'), 'https://inference.baseten.co/v1');
});
