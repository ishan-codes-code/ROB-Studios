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
  '../src/app/sections/WorkspaceSection.jsx',
  '../src/app/sections/ApiKeysSection.jsx',
  '../src/app/sections/GamesPromptsSection.jsx',
  '../src/app/sections/PreferencesSection.jsx',
  '../src/app/sections/TtsStudioSection.jsx',
  '../src/app/sections/tts-studio/VoicePicker.jsx',
  '../src/app/sections/tts-studio/PreviewPlayer.jsx',
  '../src/app/sections/workspace/CommentaryTimeline.jsx',
  '../src/app/sections/workspace/EditorCenter.jsx',
  '../src/app/sections/workspace/ProcessingInspector.jsx',
  '../src/app/sections/workspace/ProjectConfiguration.jsx',
  '../src/app/sections/workspace/ProjectWorkspaceLayout.jsx',
  '../src/app/sections/workspace/ScriptPanel.jsx',
  '../src/app/sections/workspace/VideoPreview.jsx',
  '../src/layout/Sidebar.jsx',
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
    if (before !== '.' && before !== '$') calls.add(match[0]);
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

test('project configuration opens its relevant managers in a dialog', () => {
  const source = fs.readFileSync(
    path.join(here, '../src/app/sections/workspace/ProjectConfiguration.jsx'),
    'utf8',
  );
  assert.match(source, /import ApiKeysSection from/);
  assert.match(source, /import GamesPromptsSection from/);
  assert.match(source, /<Dialog\s+open=\{manager !== null\}/);
  assert.match(source, /<ApiKeysSection embedded \/>/);
  assert.match(source, /<GamesPromptsSection embedded \/>/);
  assert.match(source, /const closeManager = useCallback/);
  assert.match(source, /load\(\);/);
});

test('API configuration creation uses a dialog on its standalone page', () => {
  const source = fs.readFileSync(
    path.join(here, '../src/app/sections/ApiKeysSection.jsx'),
    'utf8',
  );
  assert.match(source, /open=\{adding\}/);
  assert.match(source, /embedded && adding \? addCard/);
  assert.match(source, /!embedded \? \(/);
  assert.match(source, /<DialogTitle className="text-\[15px\] tracking-tight">New API configuration/);
  assert.match(source, /<DialogFooter className="gap-2 sm:flex-row">/);
  assert.match(source, /aria-labelledby="provider-choice-label"/);
  assert.match(source, /Encrypted on this device/);
});

test('Gemini TTS wizard submits a model-free credential and checks it through verification', () => {
  const source = fs.readFileSync(
    path.join(here, '../src/app/sections/ApiKeysSection.jsx'),
    'utf8',
  );
  assert.match(source, /id: "google-gemini-tts"/);
  assert.match(source, /provider === "google-gemini-tts" \? null : form\.model/);
  assert.match(source, /key: form\.key/);
  assert.match(source, /const ttsCredential = selected\?\.purpose === "tts"/);
  assert.match(source, /: window\.api\.verifyCredential/);
  assert.match(source, /Verification failed/);
  assert.match(source, /busy === "connection" && selected\.purpose === "tts" \? "Verifying/);
  assert.match(source, /Saved, not tested/);
  assert.match(source, /TTS model metadata is available/);
});
