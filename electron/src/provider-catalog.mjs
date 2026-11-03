// Provider catalogue: two curated providers with fixed endpoints and
// model lists, one TTS-only provider, and one user-configured
// OpenAI-compatible custom endpoint. Curated entries keep their pinned
// base URLs and model allowlists; custom records carry their own
// validated base URL (see validateCustomBaseUrl) plus an explicit model
// ID. The renderer offers only these choices; the worker receives the
// resolved base URL + model through its environment.

export const PROVIDER_META = 'meta';
export const PROVIDER_BASETEN = 'baseten';
export const PROVIDER_CUSTOM = 'custom';
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
  [PROVIDER_CUSTOM]: Object.freeze({
    id: PROVIDER_CUSTOM,
    displayName: 'Custom OpenAI-compatible API',
    fixedModel: false,
    // No curated models and no pinned base URL: each custom credential
    // stores its own validated endpoint + explicit model ID. Discovery
    // (GET /models) is best-effort; manual model entry always works.
    customEndpoint: true,
    models: Object.freeze([]),
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

export function getProviderBaseUrl(providerId, record = null) {
  const entry = getProvider(providerId);
  if (entry.customEndpoint === true) {
    // Custom records carry their own endpoint; curated base URLs must
    // never substitute for it (that would send the key to the wrong host).
    const baseUrl = record?.baseUrl;
    if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
      throw new Error('Custom endpoint URL is missing.');
    }
    return validateCustomBaseUrl(baseUrl);
  }
  return entry.baseUrl;
}

export function isSupportedModel(providerId, modelId) {
  const entry = PROVIDERS[providerId];
  if (!entry) return false;
  return entry.models.some((model) => model.id === modelId);
}

export const MAX_CUSTOM_MODEL_LENGTH = 200;

/** Custom model IDs are explicit, not curated: bounded, printable, single-line. */
export function validateCustomModelId(modelId) {
  if (typeof modelId !== 'string') throw new Error('Vision model is required.');
  const clean = modelId.trim();
  if (clean === '') throw new Error('Vision model is required.');
  if (clean.length > MAX_CUSTOM_MODEL_LENGTH) throw new Error('Vision model ID is too long.');
  if (/[\u0000-\u001f\u007f]/.test(clean)) throw new Error('Vision model ID contains invalid characters.');
  return clean;
}

export function validateProviderModel(providerId, modelId) {
  const entry = getProvider(providerId);
  if (entry.purpose === 'tts') {
    if (modelId !== null && modelId !== undefined) {
      throw new Error('TTS configurations do not use a Vision model.');
    }
    return { provider: entry.id, model: null };
  }
  if (entry.customEndpoint === true) {
    return { provider: entry.id, model: validateCustomModelId(modelId) };
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

export const MAX_CUSTOM_BASE_URL_LENGTH = 2048;

/**
 * True for hostnames/IPs a custom endpoint must never target: loopback,
 * link-local, unspecified, and RFC 1918 private ranges, plus localhost
 * names. Literal-IP checks are exact; hostnames that resolve to such
 * addresses can only be blocked at request time (see the Python custom
 * adapter guard), so this is the configuration-time layer.
 */
export function isBlockedCustomHost(hostname) {
  const host = (hostname ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (host === '') return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '0.0.0.0' || host === '::') return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const parts = v4.slice(1).map(Number);
    if (parts.some((n) => n > 255)) return true;
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 0) return true;
    return false;
  }
  if (host.includes(':')) {
    // IPv6 literal (brackets already stripped by URL parsing): block
    // loopback, link-local, and unique-local ranges by prefix.
    const compact = host.replace(/^\[|\]$/g, '').toLowerCase();
    if (compact === '::1') return true;
    if (/^(fe80|fec0|fc00|fd00)/.test(compact.replace(/:/g, ''))) return true;
    return false;
  }
  return false;
}

/**
 * Validate + normalize a user-supplied custom endpoint base URL.
 * HTTPS only, no credentials/query/fragment, no local or private
 * targets. Returns the canonical URL string (no trailing slash).
 */
export function validateCustomBaseUrl(baseUrl) {
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
    throw new Error('Custom endpoint URL is required.');
  }
  const trimmed = baseUrl.trim();
  if (trimmed.length > MAX_CUSTOM_BASE_URL_LENGTH) {
    throw new Error('Custom endpoint URL is too long.');
  }
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('Custom endpoint URL must be a valid HTTPS URL.');
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error('Custom endpoint URL must be HTTPS without credentials, query, or fragment.');
  }
  if (isBlockedCustomHost(url.hostname)) {
    throw new Error('Custom endpoints on local or private networks are not allowed.');
  }
  return url.toString().replace(/\/$/, '');
}

/** Infer a supported provider from a legacy base URL; null when unmappable. */
export function inferProviderFromBaseUrl(baseUrl) {
  if (typeof baseUrl !== 'string') return null;
  const normalized = baseUrl.trim().toLowerCase();
  if (normalized.includes('inference.baseten.co')) return PROVIDER_BASETEN;
  if (normalized.includes('api.meta.ai')) return PROVIDER_META;
  return null;
}
