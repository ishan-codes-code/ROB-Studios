import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Static wiring guards for the Finish-later dismissal flow. There is
// no JSX harness in this repo, so these pin the integration points
// the behavioral lib tests cannot see: the wizard exits through the
// persisting handler, the app routes on the shared predicate, the
// dashboard reports its mount milestones, and the diagnostics bridge
// is exposed and registered. Behavioral logic lives in
// onboarding.test.mjs, settings-store.test.mjs, and
// diagnostics-ipc.test.mjs.
const here = path.dirname(fileURLToPath(import.meta.url));

function readSource(relative) {
  return fs.readFileSync(path.join(here, relative), 'utf8');
}

const wizard = readSource('../src/app/sections/OnboardingWizard.jsx');
const app = readSource('../src/app/App.jsx');
const dashboard = readSource('../src/app/sections/DashboardSection.jsx');
const preferences = readSource('../src/app/sections/PreferencesSection.jsx');
const preload = readSource('../src/preload.js');
const main = readSource('../src/main.js');
const processing = readSource('../src/main/ipc/processing.js');

test('finish-later buttons exit through the persisting handler', () => {
  const exits = wizard.match(/onClick=\{exitSetup\}/g) ?? [];
  assert.equal(exits.length, 2, 'both Finish later buttons persist first');
  assert.doesNotMatch(wizard, /onClick=\{onExit\}/, 'no bare navigation exit remains');
  assert.match(wizard, /persistOnboardingDismissal\(\s*window\.api/);
  assert.match(wizard, /onboarding\.finish_later\.clicked/);
  assert.match(wizard, /onboarding\.completion\.persist\.finished/);
});

test('app routes startup on the shared onboarding predicate', () => {
  assert.match(app, /shouldShowOnboarding\(result\.settings\)/);
  assert.match(app, /onboarding\.navigation\.dashboard/);
  assert.match(app, /onExit=\{handleOnboardingExit\}/);
});

test('dashboard reports mount and hydration milestones', () => {
  assert.match(dashboard, /dashboard\.mount\.started/);
  assert.match(dashboard, /dashboard\.mount\.completed/);
  assert.match(dashboard, /dashboard\.hydration\.started/);
  assert.match(dashboard, /dashboard\.hydration\.completed/);
  assert.match(dashboard, /projectCount: list\.length/);
});

test('preferences replay clears dismissal via the shared payload', () => {
  assert.match(preferences, /setupTogglePayload\(settings\)/);
  assert.match(preferences, /Setup deferred \(Finish later\)/);
});

test('diagnostics bridge is exposed, registered, and milestone-wired', () => {
  assert.match(preload, /reportRendererEvent: \(name, meta\) => ipcRenderer\.invoke\('diagnostics-report'/);
  assert.match(main, /registerDiagnosticsIpc\(\{ ipcMain, app \}\)/);
  assert.match(main, /cpuModel/);
  assert.match(main, /cpuFlags/);
  assert.match(main, /\/proc\/cpuinfo/);
  assert.match(processing, /recordDiagnosticsEvent\(app\.getPath\('userData'\), \{ type: 'worker\.start' \}\)/);
});
