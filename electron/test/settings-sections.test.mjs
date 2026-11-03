import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Static guards for the C4/C5 settings organization: game profiles and
// commentary presets are separate libraries over one shared hook, the
// overview is read-only status with navigation, and the sidebar groups
// every configuration surface exactly once.
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (relative) => fs.readFileSync(path.join(here, relative), 'utf8');

test('game profiles and presets share one library hook', () => {
  const profiles = read('../src/app/sections/GameProfilesSection.jsx');
  const presets = read('../src/app/sections/CommentaryPresetsSection.jsx');
  assert.match(profiles, /import useGameLibrary from "@\/hooks\/useGameLibrary\.js";/);
  assert.match(presets, /import useGameLibrary from "@\/hooks\/useGameLibrary\.js";/);
  assert.match(profiles, /library\.duplicateProfile\(profile\)/);
  assert.match(presets, /library\.duplicatePreset\(preset\.id, null\)/);
  assert.match(profiles, /library\.deleteProfile\(selected\.id\)/);
  assert.match(presets, /library\.deletePreset\(selected\.id\)/);
});

test('libraries keep built-ins immutable with guarded deletes', () => {
  const profiles = read('../src/app/sections/GameProfilesSection.jsx');
  const presets = read('../src/app/sections/CommentaryPresetsSection.jsx');
  assert.match(profiles, /Built-in default profile\. It always exists and cannot be edited or deleted/);
  assert.match(presets, /Built-in preset\. It always exists and cannot be edited or deleted/);
  assert.match(profiles, /Projects and presets using it must change first/);
  assert.match(presets, /Projects using it must choose another preset first/);
  assert.match(presets, /The built-in preset cannot be edited\. Saving creates a new custom preset/);
});

test('preset editing uses a sized dialog with an honest preview', () => {
  const presets = read('../src/app/sections/CommentaryPresetsSection.jsx');
  assert.match(presets, /<DialogContent className="max-h-\[calc\(100vh-2rem\)\] overflow-y-auto sm:max-w-\[32rem\]">/);
  assert.match(presets, /Commentary preview/);
  assert.match(presets, /Style illustration \(template, not generated\)/);
  assert.match(presets, /Only gated evidence may be stated/);
});

test('overview is read-only status with section navigation', () => {
  const overview = read('../src/app/sections/OverviewSection.jsx');
  assert.match(overview, /summarizeCredentials\(credentials\)/);
  assert.match(overview, /onNavigate\(sectionId\)/);
  assert.match(overview, /sectionId="api-keys"/);
  assert.match(overview, /sectionId="tts-studio"/);
  assert.match(overview, /sectionId="game-profiles"/);
  assert.match(overview, /sectionId="commentary-presets"/);
  assert.doesNotMatch(overview, /window\.api\.(create|update|delete|set|remove|save)/);
});

test('sidebar groups every configuration surface once', () => {
  const sidebar = read('../src/layout/Sidebar.jsx');
  for (const id of ['overview', 'api-keys', 'tts-studio', 'game-profiles', 'commentary-presets', 'prompt-packs', 'preferences']) {
    assert.match(sidebar, new RegExp(`\\{ id: "${id}"`));
  }
  assert.match(sidebar, /label: "AI Providers"/);
  assert.match(sidebar, /label: "Voice Providers"/);
  assert.match(sidebar, /label: "General"/);
  assert.doesNotMatch(sidebar, /games-prompts/);
});

test('app shell maps the new sections with editor return links', () => {
  const app = read('../src/app/App.jsx');
  assert.match(app, /"game-profiles": GameProfilesSection/);
  assert.match(app, /"commentary-presets": CommentaryPresetsSection/);
  assert.match(app, /overview: OverviewSection/);
  assert.match(app, /activeSection === "game-profiles"/);
  assert.match(app, /activeSection === "commentary-presets"/);
  assert.doesNotMatch(app, /GamesPromptsSection/);
});
