// Pure guided-setup helpers (renderer-safe, no IPC).
// Steps: 0 welcome, 1 provider, 2 models, 3 commentator, 4 done.
// Covered by electron/test/onboarding.test.mjs.

export const ONBOARDING_STEPS = Object.freeze([
  'welcome',
  'provider',
  'models',
  'commentator',
  'done',
]);

export const ONBOARDING_STEP_COUNT = ONBOARDING_STEPS.length;

/** Clamp any persisted or caller-supplied step into 0..4. */
export function clampOnboardingStep(value) {
  if (!Number.isInteger(value)) return 0;
  if (value < 0) return 0;
  if (value >= ONBOARDING_STEP_COUNT) return ONBOARDING_STEP_COUNT - 1;
  return value;
}

/** Step id ('welcome' | …) for an index; 'welcome' for anything odd. */
export function stepId(index) {
  return ONBOARDING_STEPS[clampOnboardingStep(index)] ?? 'welcome';
}

/**
 * Whether the wizard may advance past the provider step: a vault
 * credential exists for the in-progress setup (created or adopted).
 */
export function providerStepReady({ credentialId = null } = {}) {
  return typeof credentialId === 'string' && credentialId !== '';
}

/**
 * Whether the wizard may advance past the models step: the setup
 * credential carries a model and passed explicit image verification.
 * Discovery membership or a bare connection test is never enough.
 */
export function modelsStepReady({ model = null, visionVerified = false } = {}) {
  return (typeof model === 'string' && model !== '') && visionVerified === true;
}

/**
 * Whether the wizard may advance past the commentator step: a game
 * profile and a commentary preset are selected (built-in defaults are
 * valid selections). TTS is optional and never gates completion.
 */
export function commentatorStepReady({ gameProfileId = null, commentaryPresetId = null } = {}) {
  return (typeof gameProfileId === 'string' && gameProfileId !== '')
    && (typeof commentaryPresetId === 'string' && commentaryPresetId !== '');
}

/**
 * Completion readiness for the summary step. Returns `{ ready, missing }`
 * where `missing` names the human-readable gaps in wizard order.
 */
export function onboardingReadiness({
  credentialId = null,
  visionVerified = false,
  model = null,
  gameProfileId = null,
  commentaryPresetId = null,
} = {}) {
  const missing = [];
  if (!providerStepReady({ credentialId })) missing.push('AI provider');
  else if (!modelsStepReady({ model, visionVerified })) missing.push('Verified vision model');
  if (!commentatorStepReady({ gameProfileId, commentaryPresetId })) missing.push('Commentator setup');
  return { ready: missing.length === 0, missing };
}
