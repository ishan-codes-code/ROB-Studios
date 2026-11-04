import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Static guards for the file-path bridge (Electron 32 removed
// File.path from the renderer) and the shared-Select migration of
// the game metadata form. There is no JSX harness in this repo, so
// these tests verify the source keeps its contracts.
const here = path.dirname(fileURLToPath(import.meta.url));
const preload = fs.readFileSync(
  path.join(here, '../src/preload.js'),
  'utf8',
);
const creationDialog = fs.readFileSync(
  path.join(here, '../src/components/ProjectCreationDialog.jsx'),
  'utf8',
);
const gameForm = fs.readFileSync(
  path.join(here, '../src/components/GameMetadataForm.jsx'),
  'utf8',
);

test('preload resolves dropped-file paths through webUtils', () => {
  assert.match(preload, /import \{ contextBridge, ipcRenderer, webUtils \} from 'electron';/);
  assert.match(preload, /getPathForFile: \(file\) => webUtils\.getPathForFile\(file\),/);
});

test('creation dialog resolves the path the same way on accept and success', () => {
  assert.match(creationDialog, /const resolveRecordingPath = \(file\) => \{/);
  assert.match(creationDialog, /window\.api\?\.getPathForFile/);
  assert.match(creationDialog, /if \(resolveRecordingPath\(file\) === ""\) \{/);
  assert.match(creationDialog, /path: resolveRecordingPath\(file\)/);
});

test('game form suggestion selects compose the shared Select primitive', () => {
  assert.match(gameForm, /from "@\/components\/ui\/select\.jsx";/);
  assert.match(gameForm, /<Select\b/);
  assert.match(gameForm, /<SelectTrigger/);
  assert.match(gameForm, /<SelectValue placeholder=\{placeholder\} \/>/);
  assert.match(gameForm, /<SelectContent>/);
  assert.match(gameForm, /<SelectItem/);
  assert.doesNotMatch(gameForm, /<select/);
});

test('game form keeps legacy values and clearing through the sentinel', () => {
  assert.match(gameForm, /const CLEAR_VALUE = "__clear__";/);
  assert.match(gameForm, /onSelect\(next === CLEAR_VALUE \? "" : next\)/);
  assert.match(gameForm, /<SelectItem value=\{CLEAR_VALUE\}>None<\/SelectItem>/);
  assert.match(gameForm, /!\s*known && value !== "" \? \(\s*<SelectItem value=\{value\}>/);
});
