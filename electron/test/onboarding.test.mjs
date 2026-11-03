import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ONBOARDING_STEP_COUNT,
  clampOnboardingStep,
  stepId,
  providerStepReady,
  modelsStepReady,
  commentatorStepReady,
  onboardingReadiness,
} from '../src/lib/onboarding.js';

test('steps clamp into the wizard range', () => {
  assert.equal(ONBOARDING_STEP_COUNT, 5);
  assert.equal(clampOnboardingStep(2), 2);
  assert.equal(clampOnboardingStep(-1), 0);
  assert.equal(clampOnboardingStep(99), 4);
  assert.equal(clampOnboardingStep('3'), 0);
  assert.equal(clampOnboardingStep(null), 0);
  assert.equal(stepId(0), 'welcome');
  assert.equal(stepId(4), 'done');
  assert.equal(stepId(99), 'done');
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

test('commentator step needs a profile and a preset', () => {
  assert.equal(commentatorStepReady({ gameProfileId: 'p', commentaryPresetId: 'c' }), true);
  assert.equal(commentatorStepReady({ gameProfileId: 'p' }), false);
  assert.equal(commentatorStepReady({}), false);
});

test('readiness names gaps in wizard order', () => {
  const ready = onboardingReadiness({
    credentialId: 'c', visionVerified: true, model: 'm',
    gameProfileId: 'p', commentaryPresetId: 's',
  });
  assert.deepEqual(ready, { ready: true, missing: [] });
  // Saved-but-unverified credentials do not complete setup.
  assert.deepEqual(
    onboardingReadiness({ credentialId: 'c', gameProfileId: 'p', commentaryPresetId: 's' }).missing,
    ['Verified vision model'],
  );
  assert.deepEqual(onboardingReadiness({}).missing, ['AI provider', 'Commentator setup']);
});
