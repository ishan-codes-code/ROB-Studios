// Curated provider catalogue (MVP): exactly two providers, no generic
// endpoints, no user-editable base URLs, no arbitrary model IDs.
// The renderer offers only these choices; the worker receives the
// resolved base URL + model through its environment.

export const PROVIDER_META = 'meta';
export const PROVIDER_BASETEN = 'baseten';
export const PROVIDER_GEMINI_TTS = 'google-gemini-tts';

// Current documented Baseten model string (meta-oss-cookbook muse-spark
// hosted baseten guide). Previously pinned identifier, kept only as a
// compatibility alias: stored records and environments still carrying
// it resolve to the current id; re-verification is still required.
export const BASETEN_MODEL = 'meta-models/muse-spark-open';
export const LEGACY_BASETEN_MODEL = 'meta-models/muse-spark-open-1026';

export function normalizeModelId(providerId, modelId) {
  const clean = typeof modelId === 'string' ? modelId.trim() : '';
  if (providerId === PROVIDER_BASETEN && clean === LEGACY_BASETEN_MODEL) {
    return BASETEN_MODEL;
  }
  return clean;
}

export const PROVIDERS = Object.freeze({
  [PROVIDER_META]: Object.freeze({
    id: PROVIDER_META,
    displayName: 'Meta Model API',
    baseUrl: 'https://api.meta.ai/v1',
    fixedModel: false,
    models: Object.freeze([
      Object.freeze({ id: 'muse-spark-1.3', displayName: 'Muse Spark 1.3' }),
      Object.freeze({ id: 'muse-wonder-1.0', displayName: 'Muse Wonder 1.0' }),
    ]),
  }),
  [PROVIDER_BASETEN]: Object.freeze({
    id: PROVIDER_BASETEN,
    displayName: 'Baseten',
    baseUrl: 'https://inference.baseten.co/v1',
    fixedModel: true,
    models: Object.freeze([
      Object.freeze({
        id: BASETEN_MODEL,
        displayName: 'Muse Spark Open',
      }),
    ]),
  }),
  [PROVIDER_GEMINI_TTS]: Object.freeze({
    id: PROVIDER_GEMINI_TTS,
    displayName: 'Google Gemini TTS',
    purpose: 'tts',
    model: null,
    models: Object.freeze([]),
  }),
});

export const SUPPORTED_PROVIDERS = Object.freeze(
  Object.keys(PROVIDERS),
);

export function getProvider(providerId) {
  const entry = PROVIDERS[providerId];
  if (!entry) throw new Error(`Unsupported provider '${providerId}'.`);
  return entry;
}

export function getProviderModels(providerId) {
  return getProvider(providerId).models.map((model) => ({ ...model }));
}

export function getProviderBaseUrl(providerId) {
  return getProvider(providerId).baseUrl;
}

export function isSupportedModel(providerId, modelId) {
  const entry = PROVIDERS[providerId];
  if (!entry) return false;
  return entry.models.some((model) => model.id === modelId);
}

export function validateProviderModel(providerId, modelId) {
  const entry = getProvider(providerId);
  if (entry.purpose === 'tts') {
    if (modelId !== null && modelId !== undefined) {
      throw new Error('TTS configurations do not use a Vision model.');
    }
    return { provider: entry.id, model: null };
  }
  if (typeof modelId !== 'string' || modelId.trim() === '') {
    throw new Error('Vision model is required.');
  }
  // Previously saved Baseten configurations carry the retired pinned
  // identifier; resolve it instead of rejecting the stored record.
  const clean = normalizeModelId(entry.id, modelId);
  if (!entry.models.some((model) => model.id === clean)) {
    throw new Error(
      `Unsupported model '${clean}' for provider '${providerId}'.`,
    );
  }
  return { provider: entry.id, model: clean };
}

/** Infer a supported provider from a legacy base URL; null when unmappable. */
export function inferProviderFromBaseUrl(baseUrl) {
  if (typeof baseUrl !== 'string') return null;
  const normalized = baseUrl.trim().toLowerCase();
  if (normalized.includes('inference.baseten.co')) return PROVIDER_BASETEN;
  if (normalized.includes('api.meta.ai')) return PROVIDER_META;
  return null;
}
