import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BASETEN_MODEL,
  LEGACY_BASETEN_MODEL,
  PROVIDERS,
  getProviderModels,
  isSupportedModel,
  normalizeModelId,
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
