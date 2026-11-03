import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Static guards for the guided-setup flow: the wizard owns the
// first-launch experience (the old settings-redirect is gone), persists
// resumable progress, never duplicates its credential, gates completion
// on verified vision, and never auto-runs paid verification.
const here = path.dirname(fileURLToPath(import.meta.url));
const wizard = fs.readFileSync(
  path.join(here, '../src/app/sections/OnboardingWizard.jsx'), 'utf8',
);
const app = fs.readFileSync(
  path.join(here, '../src/app/App.jsx'), 'utf8',
);

test('first launch renders the wizard instead of redirecting to settings', () => {
  assert.match(app, /import OnboardingWizard from/);
  assert.match(app, /<OnboardingWizard/);
  assert.match(app, /initialSettings=\{onboarding\.settings\}/);
  assert.match(app, /onboardingCompleted\) \{\s*\n?\s*setOnboarding/);
  assert.doesNotMatch(app, /setActiveSection\("api-keys"\)/);
});

test('wizard persists resumable progress on every transition', () => {
  assert.match(wizard, /onboarding: \{ step: clampOnboardingStep\(nextStep\), credentialId/);
  assert.match(wizard, /initialSettings\?\.onboarding\?\.credentialId/);
  assert.match(wizard, /clampOnboardingStep\(initialSettings\?\.onboarding\?\.step/);
});

test('wizard adopts its in-progress credential instead of duplicating it', () => {
  assert.match(wizard, /window\.api\.listCredentials\(\)/);
  assert.match(wizard, /find\(\(entry\) => entry\.id === savedId\)/);
  assert.match(wizard, /setCredential\(found\)/);
  assert.match(wizard, /is gone\. Enter the provider details again/);
});

test('wizard completion requires verified vision, never bare saving', () => {
  assert.match(wizard, /onboardingReadiness\(\{/);
  assert.match(wizard, /disabled=\{!!busy \|\| !readiness\.ready\}/);
  assert.match(wizard, /onboardingCompleted: true/);
  assert.match(wizard, /Still needed: \{readiness\.missing\.join/);
});

test('wizard never auto-runs paid verification or infers image support', () => {
  // Both checks fire only from explicit button handlers.
  assert.match(wizard, /onClick=\{testConnection\}/);
  assert.match(wizard, /onClick=\{verifyImage\}/);
  assert.match(wizard, /never by the model name/);
  assert.match(wizard, /never implies image support/);
  assert.doesNotMatch(wizard, /useEffect\(\(\) => \{\s*\n?\s*(testConnection|verifyImage)\(\)/);
});

test('wizard supports custom endpoints with discovery and manual fallback', () => {
  assert.match(wizard, /id: "custom"/);
  assert.match(wizard, /window\.api\.discoverCustomModels\(input\)/);
  assert.match(wizard, /discovery_unsupported/);
  assert.match(wizard, /Enter the model ID manually/);
  assert.match(wizard, /validateEndpointInput\(baseUrl\)/);
});

test('wizard completion offers an optional first project', () => {
  assert.match(wizard, /window\.api\.selectVideo\(\)/);
  assert.match(wizard, /window\.api\.createProject\(projectName/);
  assert.match(wizard, /window\.api\.setProjectConfig\(result\.project\.id/);
  assert.match(wizard, /Complete & open project/);
  assert.match(wizard, /Complete setup/);
});
