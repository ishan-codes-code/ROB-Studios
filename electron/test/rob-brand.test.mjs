import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Static guards for the ROB rebrand (ROB = Real-time Observer &
// Broadcaster; ROB Studio where a longer descriptor fits). There is no
// JSX harness in this repo, so these tests verify the renderer sources
// and build metadata keep the brand contract: the obsolete names are
// gone from every touched user-facing surface, the new brand is
// present, and descriptions stay factual (evidence-aware; never
// claiming the app sees what the pipeline does not analyze).
//
// Logo audit outcome: no ROB logo/brand-mark asset exists in the repo,
// so this rebrand is copy-only by design. These tests pin that decision:
// the title bar keeps its existing generic icon mark unchanged, and no
// emoji or text glyph may stand in as a logo.
const here = path.dirname(fileURLToPath(import.meta.url));

function readSource(relative) {
  return fs.readFileSync(path.join(here, relative), 'utf8');
}

const indexHtml = readSource('../index.html');
const titlebar = readSource('../src/layout/TitleBar.jsx');
const dashboard = readSource('../src/app/sections/DashboardSection.jsx');
const onboarding = readSource('../src/app/sections/OnboardingWizard.jsx');
const manifest = readSource('../package.json');
const readme = readSource('../../README.md');
const designSystem = readSource('../../docs/ui/DESIGN_SYSTEM.md');
const uiRoadmap = readSource('../../docs/ui/UI_ROADMAP.md');

const USER_FACING_SOURCES = {
  '../index.html': indexHtml,
  '../src/layout/TitleBar.jsx': titlebar,
  '../src/app/sections/DashboardSection.jsx': dashboard,
  '../src/app/sections/OnboardingWizard.jsx': onboarding,
};

for (const [relative, source] of Object.entries(USER_FACING_SOURCES)) {
  test(`no obsolete product name remains in ${relative}`, () => {
    assert.doesNotMatch(source, /AI Commentator/);
    assert.doesNotMatch(source, /Commentary Studio/);
  });
}

test('window title carries the ROB Studio brand', () => {
  assert.match(indexHtml, /<title>ROB Studio<\/title>/);
});

test('title bar wordmark is ROB Studio with a matching accessible name', () => {
  assert.match(titlebar, /ROB Studio/);
  assert.match(titlebar, /aria-label="ROB Studio window title bar"/);
});

test('dashboard greeting names ROB as an evidence-aware companion', () => {
  assert.match(dashboard, /Welcome back/);
  assert.match(dashboard, /ROB, your evidence-aware live commentary companion\./);
});

test('onboarding introduces ROB with its full descriptor', () => {
  assert.match(onboarding, /ROB Studio/);
  assert.match(onboarding, /Real-time Observer & Broadcaster/);
  assert.match(onboarding, /evidence-grounded broadcast commentary/);
});

test('build metadata carries the ROB Studio brand', () => {
  const parsed = JSON.parse(manifest);
  assert.equal(parsed.name, 'rob-studio');
  assert.equal(parsed.productName, 'ROB Studios');
  assert.doesNotMatch(manifest, /electron-react/);
});

test('product docs carry the ROB Studio brand', () => {
  assert.match(readme, /# ROB Studio/);
  assert.match(readme, /ROB \(Real-time Observer & Broadcaster\)/);
  assert.match(designSystem, /ROB Studio desktop application/);
  assert.match(uiRoadmap, /ROB Studio Electron renderer/);
  assert.match(uiRoadmap, /ROB Studio shell/);
  for (const source of [readme, designSystem, uiRoadmap]) {
    assert.doesNotMatch(source, /AI Commentator/);
  }
});

test('copy-only rebrand invents no logo: no emoji or glyph mark', () => {
  assert.match(titlebar, /<AudioLines className="size-3" aria-hidden \/>/);
  assert.doesNotMatch(titlebar, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  assert.doesNotMatch(titlebar, /RobLogo/);
  assert.ok(
    !fs.existsSync(path.join(here, '../src/components/RobLogo.jsx')),
    'no invented logo component while no brand-mark asset exists',
  );
});
