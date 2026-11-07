import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Static guards for the editor Voice tab. There is no JSX harness in
// this repo, so these checks read source text: the tab wiring, the
// narrow IPC surface the panel may use, project-scope-only writes
// (no scope selector in the new workflow), and the untouched
// standalone Voice Providers page.
const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, '../src');

function read(relative) {
  return fs.readFileSync(path.join(SRC, relative), 'utf8');
}

function apiCalls(source) {
  return [...source.matchAll(/window\.api\.(\w+)\(/g)].map((match) => match[1]);
}

test('the inspector renders a Voice tab bound to the open project', () => {
  const source = read('app/sections/workspace/ProcessingInspector.jsx');
  assert.match(source, /<TabsTrigger value="voice" title="Voice"/);
  assert.match(
    source,
    /<TabsContent value="voice"[^>]*>\s*<VoicePanel projectId=\{project\.id\} onNavigate=\{onNavigate\} \/>\s*<\/TabsContent>/,
  );
});

test('the Voice panel uses only its narrow audited IPC surface', () => {
  const allowed = new Set([
    'getTtsCatalog', 'getTtsConfig', 'setTtsConfig', 'previewTts', 'listCredentials',
  ]);
  for (const call of apiCalls(read('app/sections/workspace/VoicePanel.jsx'))) {
    assert.ok(allowed.has(call), `VoicePanel must not call window.api.${call}`);
  }
  const hookAllowed = new Set([
    'listVoiceConfigs', 'createVoiceConfig', 'updateVoiceConfig', 'deleteVoiceConfig',
  ]);
  for (const call of apiCalls(read('hooks/useVoiceConfigs.js'))) {
    assert.ok(hookAllowed.has(call), `useVoiceConfigs must not call window.api.${call}`);
  }
});

test('the Voice panel writes project scope only and carries no scope selector', () => {
  const source = read('app/sections/workspace/VoicePanel.jsx');
  assert.match(source, /scope: "project"/);
  assert.doesNotMatch(source, /scope: "global"/);
  assert.doesNotMatch(source, /[Ss]cope selector/);
  assert.doesNotMatch(source, /scopeProjectId/);
  assert.doesNotMatch(source, /Global defaults/);
});

test('voice preview reuses the shared synthesis path and player', () => {
  const source = read('app/sections/workspace/VoicePanel.jsx');
  assert.match(source, /from "\.\.\/tts-studio\/PreviewPlayer\.jsx"/);
  assert.match(source, /window\.api\.previewTts\(\{/);
  assert.match(source, /<PreviewPlayer/);
  assert.doesNotMatch(source, /tts_say|spawn/);
});

test('the Voice panel reports inline and never splits toast ownership', () => {
  for (const relative of ['app/sections/workspace/VoicePanel.jsx', 'hooks/useVoiceConfigs.js']) {
    assert.doesNotMatch(read(relative), /from ["']sonner["']/);
  }
  assert.match(read('app/sections/workspace/VoicePanel.jsx'), /role="status"/);
});

test('react hooks are imported in the new voice files', () => {
  for (const relative of ['app/sections/workspace/VoicePanel.jsx', 'hooks/useVoiceConfigs.js']) {
    const source = read(relative);
    const importMatch = source.match(/import\s*\{([^}]*)\}\s*from\s*["']react["']/);
    const imported = new Set(
      importMatch ? importMatch[1].split(',').map((entry) => entry.trim()).filter(Boolean) : [],
    );
    for (const match of source.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from\s*["']([^"']+)["']/g)) {
      if (match[2] !== 'react' && /^use[A-Z]/.test(match[1])) imported.add(match[1]);
    }
    const missing = new Set();
    for (const match of source.matchAll(/use[A-Z][A-Za-z]*(?=\s*\()/g)) {
      const before = source.slice(Math.max(0, match.index - 1), match.index);
      const definition = /function\s+$/.test(source.slice(Math.max(0, match.index - 9), match.index));
      if (before !== '.' && before !== '$' && !definition && !imported.has(match[0])) {
        missing.add(match[0]);
      }
    }
    assert.deepEqual([...missing], [], relative);
  }
});

test('the standalone Voice Providers page keeps its scope workflow untouched', () => {
  const source = read('app/sections/TtsStudioSection.jsx');
  assert.match(source, /Configuration scope/);
  assert.match(source, /scopeProjectId/);
});

test('the preload bridge and main process expose the voice library', () => {
  const preload = read('preload.js');
  for (const method of ['listVoiceConfigs', 'createVoiceConfig', 'updateVoiceConfig', 'deleteVoiceConfig']) {
    assert.match(preload, new RegExp(`\\b${method}\\b`));
  }
  assert.match(preload, /ipcRenderer\.invoke\('voice-config-list'\)/);
  assert.match(preload, /ipcRenderer\.invoke\('voice-config-create', input\)/);
  assert.match(preload, /ipcRenderer\.invoke\('voice-config-update', id, patch\)/);
  assert.match(preload, /ipcRenderer\.invoke\('voice-config-delete', id\)/);
  const main = read('main.js');
  assert.match(main, /import \{ registerVoiceConfigIpc \} from '\.\/main\/ipc\/voice-configs\.js';/);
  assert.match(main, /registerVoiceConfigIpc\(\{ ipcMain, app, safeStorage \}\);/);
});
