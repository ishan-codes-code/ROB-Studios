import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ONBOARDING_STEP_COUNT,
  clampOnboardingStep,
  stepId,
  providerStepReady,
  modelsStepReady,
  onboardingReadiness,
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
