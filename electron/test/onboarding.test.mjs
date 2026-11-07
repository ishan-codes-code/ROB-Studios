import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ONBOARDING_STEP_COUNT,
  clampOnboardingStep,
  stepId,
  providerStepReady,
  modelsStepReady,
  onboardingReadiness,
  persistOnboardingDismissal,
  setupTogglePayload,
  shouldShowOnboarding,
} from '../src/lib/onboarding.js';

test('steps clamp into the wizard range', () => {
  assert.equal(ONBOARDING_STEP_COUNT, 4);
  assert.equal(clampOnboardingStep(2), 2);
  assert.equal(clampOnboardingStep(-1), 0);
  assert.equal(clampOnboardingStep(99), 3);
  assert.equal(clampOnboardingStep('3'), 0);
  assert.equal(clampOnboardingStep(null), 0);
  assert.equal(stepId(0), 'welcome');
  assert.equal(stepId(3), 'done');
  assert.equal(stepId(99), 'done');
  // A stored step from the retired five-step wizard lands on done.
  assert.equal(clampOnboardingStep(4), 3);
});

test('provider step needs a saved credential, nothing more', () => {
  assert.equal(providerStepReady({ credentialId: 'cred-1' }), true);
  assert.equal(providerStepReady({ credentialId: '' }), false);
  assert.equal(providerStepReady({}), false);
});

test('models step needs an explicit verified model', () => {
  assert.equal(modelsStepReady({ model: 'm', visionVerified: true }), true);
  assert.equal(modelsStepReady({ model: 'm', visionVerified: false }), false);
  assert.equal(modelsStepReady({ model: '', visionVerified: true }), false);
  assert.equal(modelsStepReady({}), false);
});

test('wizard shows unless setup completed or explicitly dismissed', () => {
  assert.equal(shouldShowOnboarding(null), true);
  assert.equal(shouldShowOnboarding({}), true);
  assert.equal(shouldShowOnboarding({ onboardingCompleted: false }), true);
  assert.equal(
    shouldShowOnboarding({ onboardingCompleted: false, onboarding: { step: 2, dismissed: false } }),
    true,
  );
  assert.equal(shouldShowOnboarding({ onboardingCompleted: true }), false);
  assert.equal(
    shouldShowOnboarding({ onboardingCompleted: true, onboarding: { dismissed: true } }),
    false,
  );
  assert.equal(
    shouldShowOnboarding({ onboardingCompleted: false, onboarding: { step: 2, dismissed: true } }),
    false,
    'dismissal hides the wizard without completing setup',
  );
  // A truthy-but-malformed dismissed flag never hides the wizard.
  assert.equal(shouldShowOnboarding({ onboardingCompleted: false, onboarding: { dismissed: 'yes' } }), true);
});

test('dismissal persists step and credential without completing setup', async () => {
  const seen = [];
  const api = {
    saveSettings: async (value) => {
      seen.push(value);
      return { ok: true, settings: { ...value, onboardingCompleted: false } };
    },
  };
  const settings = await persistOnboardingDismissal(api, { onboardingCompleted: false }, 2, 'cred-9');
  assert.deepEqual(settings.onboarding, { step: 2, credentialId: 'cred-9', dismissed: true });
  assert.equal(settings.onboardingCompleted, false, 'provider/model stay unconfigured');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].onboarding.dismissed, true);
});

test('dismissal clamps steps and rejects failed saves', async () => {
  const api = {
    saveSettings: async (value) => ({ ok: true, settings: value }),
  };
  const settings = await persistOnboardingDismissal(api, {}, 99, null);
  assert.equal(settings.onboarding.step, 3, 'clamped into wizard range');
  await assert.rejects(() => persistOnboardingDismissal(null, {}, 1, null), /Settings bridge unavailable/);
  await assert.rejects(
    () => persistOnboardingDismissal({ saveSettings: async () => ({ ok: false }) }, {}, 1, null),
    /Could not save setup progress/,
  );
});

test('setup toggle replays from completed or dismissed, completes from pending', () => {
  assert.deepEqual(setupTogglePayload({ onboardingCompleted: false }), { onboardingCompleted: true });
  assert.deepEqual(
    setupTogglePayload({ onboardingCompleted: false, onboarding: { step: 2, credentialId: 'c', dismissed: false } }),
    { onboardingCompleted: true },
  );
  assert.deepEqual(
    setupTogglePayload({ onboardingCompleted: true, onboarding: { step: 3, credentialId: 'c', dismissed: false } }),
    { onboardingCompleted: false, onboarding: { step: 0, credentialId: 'c', dismissed: false } },
  );
  assert.deepEqual(
    setupTogglePayload({ onboardingCompleted: false, onboarding: { step: 2, credentialId: null, dismissed: true } }),
    { onboardingCompleted: false, onboarding: { step: 0, credentialId: null, dismissed: false } },
  );
});

test('readiness names gaps in wizard order', () => {
  const ready = onboardingReadiness({
    credentialId: 'c', visionVerified: true, model: 'm',
  });
  assert.deepEqual(ready, { ready: true, missing: [] });
  // Saved-but-unverified credentials do not complete setup.
  assert.deepEqual(
    onboardingReadiness({ credentialId: 'c' }).missing,
    ['Verified vision model'],
  );
  assert.deepEqual(onboardingReadiness({}).missing, ['AI provider']);
});
