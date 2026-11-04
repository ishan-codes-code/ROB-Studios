import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Static guards for the settings organization after the game
// simplification: game metadata is project-owned (no library pages),
// the overview is read-only status with navigation, and the sidebar
// groups every remaining configuration surface exactly once.
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (relative) => fs.readFileSync(path.join(here, relative), 'utf8');

test('retired library pages and hook are gone', () => {
  for (const relative of [
    '../src/app/sections/GameProfilesSection.jsx',
    '../src/app/sections/CommentaryPresetsSection.jsx',
    '../src/hooks/useGameLibrary.js',
    '../src/game-store.mjs',
  ]) {
    assert.equal(fs.existsSync(path.join(here, relative)), false, `${relative} is removed`);
  }
  for (const relative of [
    '../src/app/App.jsx',
    '../src/layout/Sidebar.jsx',
    '../src/app/sections/OverviewSection.jsx',
    '../src/app/sections/OnboardingWizard.jsx',
    '../src/preload.js',
    '../src/main/ipc/settings.js',
  ]) {
    const source = read(relative);
    assert.doesNotMatch(source, /game-profiles/, `${relative} has no game-profiles reference`);
    assert.doesNotMatch(source, /commentary-presets/, `${relative} has no commentary-presets reference`);
    assert.doesNotMatch(source, /useGameLibrary/, `${relative} has no library hook reference`);
  }
});

test('overview is read-only status with section navigation', () => {
  const overview = read('../src/app/sections/OverviewSection.jsx');
  assert.match(overview, /summarizeCredentials\(credentials\)/);
  assert.match(overview, /onNavigate\(sectionId\)/);
  assert.match(overview, /sectionId="api-keys"/);
  assert.match(overview, /sectionId="tts-studio"/);
  assert.match(overview, /sectionId="prompt-packs"/);
  assert.doesNotMatch(overview, /window\.api\.(create|update|delete|set|remove|save)/);
});

test('sidebar groups every configuration surface once', () => {
  const sidebar = read('../src/layout/Sidebar.jsx');
  for (const id of ['overview', 'api-keys', 'tts-studio', 'prompt-packs', 'preferences']) {
    assert.match(sidebar, new RegExp(`\\{ id: "${id}"`));
  }
  assert.match(sidebar, /label: "AI Providers"/);
  assert.match(sidebar, /label: "Voice Providers"/);
  assert.match(sidebar, /label: "General"/);
  assert.doesNotMatch(sidebar, /games-prompts/);
});

test('app shell maps the sections with editor return links', () => {
  const app = read('../src/app/App.jsx');
  assert.match(app, /overview: OverviewSection/);
  assert.match(app, /"api-keys": ApiKeysSection/);
  assert.match(app, /"prompt-packs": PromptPacksSection/);
  assert.match(app, /activeSection === "api-keys"/);
  assert.doesNotMatch(app, /GamesPromptsSection/);
});
