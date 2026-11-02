// Curated provider catalogue (MVP): exactly two providers, no generic
// endpoints, no user-editable base URLs, no arbitrary model IDs.
// The renderer offers only these choices; the worker receives the
// resolved base URL + model through its environment.

export const PROVIDER_META = 'meta';
export const PROVIDER_BASETEN = 'baseten';

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
        id: 'meta-models/muse-spark-open-1026',
        displayName: 'Muse Spark Open 1026',
      }),
    ]),
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
  if (typeof modelId !== 'string' || modelId.trim() === '') {
    throw new Error('Vision model is required.');
  }
  const clean = modelId.trim();
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
