// Pure provider-status derivation (renderer-safe, no IPC).
// One status vocabulary shared by the providers list, the onboarding
// wizard, the editor Configure summary, and the settings overview, so
// every surface describes the same record the same way.
// Covered by electron/test/provider-status.test.mjs.

export const PROVIDER_STATUS = Object.freeze({
  NOT_CONNECTED: 'not-connected',
  SAVED: 'saved',
  CONNECTED: 'connected',
  MODEL_SELECTED: 'model-selected',
  VISION_VERIFIED: 'vision-verified',
  NEEDS_ATTENTION: 'needs-attention',
});

/**
 * Derive the display status for one vault credential (public record
 * shape; never key material).
 *
 * @param {object|null} credential public record or null when none exists
 * @param {object} [options]
 * @param {Set<string>|string[]} [options.connectedIds] ids with a
 *   successful connection test this session (the check result itself is
 *   ephemeral and intentionally not persisted)
 * @param {Set<string>|string[]} [options.failedIds] ids with a failed
 *   check this session
 */
export function credentialStatus(credential, options = {}) {
  if (!credential) return PROVIDER_STATUS.NOT_CONNECTED;
  const connectedIds = options.connectedIds ?? [];
  const failedIds = options.failedIds ?? [];
  const has = (collection, id) => (typeof collection.has === 'function'
    ? collection.has(id)
    : Array.isArray(collection) && collection.includes(id));
  if (credential.keyAvailable !== true) return PROVIDER_STATUS.NEEDS_ATTENTION;
  if (has(failedIds, credential.id)) return PROVIDER_STATUS.NEEDS_ATTENTION;
  if (credential.verification?.status === 'verified') return PROVIDER_STATUS.VISION_VERIFIED;
  if (has(connectedIds, credential.id)) return PROVIDER_STATUS.CONNECTED;
  if (credential.purpose !== 'tts' && typeof credential.model === 'string' && credential.model !== '') {
    return PROVIDER_STATUS.MODEL_SELECTED;
  }
  return PROVIDER_STATUS.SAVED;
}

const STATUS_META = {
  [PROVIDER_STATUS.NOT_CONNECTED]: { label: 'Not connected', variant: 'outline' },
  [PROVIDER_STATUS.SAVED]: { label: 'Saved', variant: 'outline' },
  [PROVIDER_STATUS.CONNECTED]: { label: 'Connected', variant: 'secondary' },
  [PROVIDER_STATUS.MODEL_SELECTED]: { label: 'Model selected', variant: 'secondary' },
  [PROVIDER_STATUS.VISION_VERIFIED]: { label: 'Vision verified', variant: 'secondary' },
  [PROVIDER_STATUS.NEEDS_ATTENTION]: { label: 'Needs attention', variant: 'destructive' },
};

/**
 * Badge copy for a status. TTS records never claim vision: their
 * verified state reads as an access check, matching the vault wording.
 */
export function statusMeta(status, purpose = 'vision') {
  const meta = STATUS_META[status] ?? STATUS_META[PROVIDER_STATUS.NOT_CONNECTED];
  if (status === PROVIDER_STATUS.VISION_VERIFIED && purpose === 'tts') {
    return { label: 'TTS access checked', variant: 'secondary' };
  }
  return { ...meta };
}

/**
 * Highest-priority status across a credential list for overview
 * surfaces. Verified vision wins; unreadable/failed records surface
 * next so problems are never hidden behind a healthy sibling.
 */
export function summarizeCredentials(credentials, options = {}) {
  const list = Array.isArray(credentials) ? credentials : [];
  const vision = list.filter((entry) => entry && entry.purpose !== 'tts');
  if (vision.length === 0) {
    return {
      status: PROVIDER_STATUS.NOT_CONNECTED,
      verifiedCount: 0,
      total: 0,
      hasProblem: false,
    };
  }
  let verifiedCount = 0;
  let hasProblem = false;
  let best = PROVIDER_STATUS.SAVED;
  const rank = {
    [PROVIDER_STATUS.SAVED]: 0,
    [PROVIDER_STATUS.MODEL_SELECTED]: 1,
    [PROVIDER_STATUS.CONNECTED]: 2,
    [PROVIDER_STATUS.VISION_VERIFIED]: 3,
  };
  for (const entry of vision) {
    const status = credentialStatus(entry, options);
    if (status === PROVIDER_STATUS.VISION_VERIFIED) verifiedCount += 1;
    if (status === PROVIDER_STATUS.NEEDS_ATTENTION) hasProblem = true;
    if ((rank[status] ?? 0) > (rank[best] ?? 0)) best = status;
  }
  return {
    status: hasProblem && verifiedCount === 0 ? PROVIDER_STATUS.NEEDS_ATTENTION : best,
    verifiedCount,
    total: vision.length,
    hasProblem,
  };
}
