// Pure guided-setup helpers (renderer-safe, no IPC).
// Steps: 0 welcome, 1 provider, 2 models, 3 done.
// Covered by electron/test/onboarding.test.mjs.

export const ONBOARDING_STEPS = Object.freeze([
  'welcome',
  'provider',
  'models',
  'done',
]);

export const ONBOARDING_STEP_COUNT = ONBOARDING_STEPS.length;

/** Clamp any persisted or caller-supplied step into 0..3. */
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
 * Completion readiness for the summary step. Returns `{ ready, missing }`
 * where `missing` names the human-readable gaps in wizard order. Game
 * metadata lives on each project and TTS is optional: neither gates
 * completion.
 */
export function onboardingReadiness({
  credentialId = null,
  visionVerified = false,
  model = null,
} = {}) {
  const missing = [];
  if (!providerStepReady({ credentialId })) missing.push('AI provider');
  else if (!modelsStepReady({ model, visionVerified })) missing.push('Verified vision model');
  return { ready: missing.length === 0, missing };
}

/**
 * Whether the guided-setup wizard takes over the window at startup.
 * An explicit Finish-later dismissal hides the wizard without
 * claiming setup is complete; only completed setup or dismissal
 * keeps it hidden. Malformed settings fall back to showing it.
 */
export function shouldShowOnboarding(settings) {
  if (!settings || typeof settings !== 'object') return true;
  if (settings.onboardingCompleted === true) return false;
  return settings.onboarding?.dismissed !== true;
}

/**
 * Persist a Finish-later dismissal through the settings bridge.
 * Resolves to the saved settings. Rejects when the bridge is missing
 * or the save fails, so the caller can stay on the wizard instead of
 * navigating on an unpersisted dismissal.
 */
export async function persistOnboardingDismissal(api, currentSettings, step, credentialId) {
  if (!api || typeof api.saveSettings !== 'function') {
    throw new Error('Settings bridge unavailable (running outside Electron?).');
  }
  const current = currentSettings && typeof currentSettings === 'object' ? currentSettings : {};
  const result = await api.saveSettings({
    ...current,
    onboarding: {
      step: clampOnboardingStep(step),
      credentialId: credentialId ?? null,
      dismissed: true,
    },
  });
  if (!result?.ok) throw new Error('Could not save setup progress. Check the local data directory and try again.');
  return result.settings;
}

/**
 * Preferences setup-toggle payload. Marking complete leaves progress
 * untouched (completion dominates). Replaying — from completed setup
 * or from a Finish-later dismissal — clears both flags so the wizard
 * actually shows, restarting from the welcome step.
 */
export function setupTogglePayload(settings) {
  const completed = settings?.onboardingCompleted === true;
  const dismissed = settings?.onboarding?.dismissed === true;
  if (!completed && !dismissed) {
    return { onboardingCompleted: true };
  }
  return {
    onboardingCompleted: false,
    onboarding: {
      step: 0,
      credentialId: settings?.onboarding?.credentialId ?? null,
      dismissed: false,
    },
  };
}
