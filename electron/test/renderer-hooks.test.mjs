import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Regression guard for the "black screen on project open" failure:
// a React hook called in a renderer component but missing from its
// `from "react"` import throws a ReferenceError during render. There is
// no JSX harness in this repo, so this test statically verifies every
// hook call site against the file's own react import.
const here = path.dirname(fileURLToPath(import.meta.url));
const COMPONENTS = [
  '../src/app/App.jsx',
  '../src/app/sections/DashboardSection.jsx',
  '../src/app/sections/LiveCommentaryHero.jsx',
  '../src/app/sections/WorkspaceSection.jsx',
  '../src/app/sections/OnboardingWizard.jsx',
  '../src/app/sections/ApiKeysSection.jsx',
  '../src/components/GameMetadataForm.jsx',
  '../src/components/ProjectCreationDialog.jsx',
  '../src/components/kokonutui/file-upload.jsx',
  '../src/app/sections/OverviewSection.jsx',
  '../src/app/sections/providers/ModelPicker.jsx',
  '../src/app/sections/providers/ProviderStatusBadge.jsx',
  '../src/app/sections/PreferencesSection.jsx',
  '../src/app/sections/TtsStudioSection.jsx',
  '../src/app/sections/tts-studio/VoicePicker.jsx',
  '../src/app/sections/tts-studio/PreviewPlayer.jsx',
  '../src/app/sections/workspace/CommentaryTimeline.jsx',
  '../src/app/sections/workspace/EditorCenter.jsx',
  '../src/hooks/useCredentials.js',
  '../src/hooks/useVideoExport.js',
  '../src/app/sections/workspace/ProcessingInspector.jsx',
  '../src/app/sections/workspace/ProjectConfiguration.jsx',
  '../src/app/sections/workspace/ProjectWorkspaceLayout.jsx',
  '../src/app/sections/workspace/ScriptPanel.jsx',
  '../src/app/sections/workspace/VideoPreview.jsx',
  '../src/layout/Sidebar.jsx',
  '../src/layout/TitleBar.jsx',
];

function checkFile(relative) {
  const source = fs.readFileSync(path.join(here, relative), 'utf8');
  const importMatch = source.match(/import\s*\{([^}]*)\}\s*from\s*["']react["']/);
  const imported = new Set(
    importMatch ? importMatch[1].split(',').map((entry) => entry.trim()).filter(Boolean) : [],
  );
  // Project hooks (useProjectAudio, …) imported from app modules satisfy
  // the guard the same way react imports do; only a hook with no import
  // at all is still reported.
  const namedPattern = /import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  let named;
  while ((named = namedPattern.exec(source)) !== null) {
    if (named[2] === 'react') {
      continue;
    }
    for (const entry of named[1].split(',')) {
      const name = entry.trim().split(/\s+as\s+/).pop().trim();
      if (/^use[A-Z]/.test(name)) {
        imported.add(name);
      }
    }
  }
  const defaultPattern = /import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s*from\s*["']([^"']+)["']/g;
  let direct;
  while ((direct = defaultPattern.exec(source)) !== null) {
    if (direct[2] !== 'react' && /^use[A-Z]/.test(direct[1])) {
      imported.add(direct[1]);
    }
  }
  const namespaced = /import\s+React[,\s]/.test(source);
  const calls = new Set();
  const callPattern = /use[A-Z][A-Za-z]*(?=\s*\()/g;
  let match;
  while ((match = callPattern.exec(source)) !== null) {
    const before = source.slice(Math.max(0, match.index - 1), match.index);
    // A hook file defines its own `function useX(` — a definition, not a
    // call site, so it must never be reported as a missing import.
    const definition = /function\s+$/.test(source.slice(Math.max(0, match.index - 9), match.index));
    if (before !== '.' && before !== '$' && !definition) calls.add(match[0]);
  }
  return [...calls].filter((name) => !imported.has(name) && !namespaced);
}

for (const relative of COMPONENTS) {
  test(`react hooks are imported in ${relative}`, () => {
    assert.deepEqual(checkFile(relative), []);
  });
}

test('workspace project id reaches the project configuration selectors', () => {
  const source = fs.readFileSync(
    path.join(here, '../src/app/sections/workspace/ProcessingInspector.jsx'),
    'utf8',
  );
  const configCall = source.match(/<ConfigurationContent\s+([\s\S]*?)\/>/);
  assert.ok(configCall, 'ConfigurationContent is rendered');
  assert.match(configCall[1], /projectId=\{project\.id\}/);
});

test('project configuration links to managers instead of nesting dialogs', () => {
  const source = fs.readFileSync(
    path.join(here, '../src/app/sections/workspace/ProjectConfiguration.jsx'),
    'utf8',
  );
  assert.match(source, /onNavigate\?\.\("api-keys"\)/);
  assert.match(source, /onNavigate\?\.\("prompt-packs"\)/);
  assert.doesNotMatch(source, /game-profiles/);
  assert.doesNotMatch(source, /commentary-presets/);
  assert.match(source, /Manage providers/);
  assert.match(source, /aria-label="AI vision"/);
  assert.match(source, /aria-label="Game"/);
  assert.match(source, /GameMetadataForm/);
  assert.match(source, /save\("game", pendingGame\)/);
  assert.match(source, /isRunReady\(\{ credential, warnings \}\)/);
  assert.doesNotMatch(source, /import ApiKeysSection from/);
  assert.doesNotMatch(source, /import GamesPromptsSection from/);
  assert.doesNotMatch(source, /<Dialog/);
});

test('editor Configure tab groups processing after the project overview', () => {
  const source = fs.readFileSync(
    path.join(here, '../src/app/sections/workspace/ProcessingInspector.jsx'),
    'utf8',
  );
  assert.match(source, /<GroupTitle>Processing<\/GroupTitle>/);
  assert.match(source, /onNavigate=\{onNavigate\}/);
  const app = fs.readFileSync(
    path.join(here, '../src/app/App.jsx'),
    'utf8',
  );
  assert.match(app, /onNavigate=\{handleSelectSection\}/);
});

test('AI provider creation uses a dialog with inline validation', () => {
  const source = fs.readFileSync(
    path.join(here, '../src/app/sections/ApiKeysSection.jsx'),
    'utf8',
  );
  assert.match(source, /open=\{adding\}/);
  assert.match(source, /<DialogTitle className="text-\[15px\] tracking-tight">New AI provider/);
  assert.match(source, /<DialogFooter className="gap-2 sm:flex-row">/);
  assert.match(source, /aria-labelledby="provider-choice-label"/);
  assert.match(source, /Encrypted on this device/);
  assert.match(source, /validateName\(form\.name/);
  assert.match(source, /validateKeyInput\(form\.key\)/);
  assert.match(source, /Save provider/);
});

test('Gemini TTS submits a model-free credential and checks it through verification', () => {
  const source = fs.readFileSync(
    path.join(here, '../src/app/sections/ApiKeysSection.jsx'),
    'utf8',
  );
  assert.match(source, /id: "google-gemini-tts"/);
  assert.match(source, /provider === "google-gemini-tts" \? null/);
  assert.match(source, /key: form\.key/);
  assert.match(source, /const ttsCredential = selected\?\.purpose === "tts"/);
  assert.match(source, /: window\.api\.verifyCredential/);
  assert.match(source, /Test access/);
  assert.match(source, /TTS model metadata is available/);
});

test('provider list shares one status vocabulary and manages custom endpoints', () => {
  const source = fs.readFileSync(
    path.join(here, '../src/app/sections/ApiKeysSection.jsx'),
    'utf8',
  );
  assert.match(source, /import ProviderStatusBadge from/);
  assert.match(source, /<ProviderStatusBadge credential=\{entry\}/);
  assert.match(source, /import ModelPicker from/);
  assert.match(source, /id: "custom"/);
  assert.match(source, /window\.api\.setCredentialEndpoint\(selectedId/);
  assert.match(source, /validateEndpointInput\(/);
  assert.match(source, /discoveryInput=\{\{ credentialId: credential\.id \}\}/);
  assert.match(source, /Endpoint changed\. Image verification was reset/);
});
