import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Static guards for the Diagnostics dialog and Processing pipeline
// wiring. There is no JSX harness in this repo, so these tests verify
// the sources compose the shared activity surfaces without regressing
// the artifact browser, cancellation, or session behavior.
const here = path.dirname(fileURLToPath(import.meta.url));

function readSource(relative) {
  return fs.readFileSync(path.join(here, '..', relative), 'utf8');
}

const editorCenter = readSource('src/app/sections/workspace/EditorCenter.jsx');
const inspector = readSource('src/app/sections/workspace/ProcessingInspector.jsx');
const workspace = readSource('src/app/sections/WorkspaceSection.jsx');
const preload = readSource('src/preload.js');
const projectsIpc = readSource('src/main/ipc/projects.js');
const sessions = readSource('src/lib/workspace-sessions.js');

test('diagnostics dialog shows activity and artifacts side by side', () => {
  assert.match(editorCenter, /ApiActivityPanel/);
  assert.match(editorCenter, /<Tabs defaultValue="activity"/);
  assert.match(editorCenter, /<TabsTrigger value="activity"[^>]*>API Activity</);
  assert.match(editorCenter, /<TabsTrigger value="artifacts"[^>]*>Artifacts</);
  // The artifact browser keeps its project binding and refresh signal.
  assert.match(
    editorCenter,
    /<ArtifactBrowser projectId=\{project\.id\} refreshSignal=\{refreshSignal\} \/>/,
  );
});

test('processing tab renders the pipeline from session activity', () => {
  assert.match(inspector, /import PipelineStages from "@\/components\/PipelineStages\.jsx";/);
  assert.match(inspector, /<PipelineStages run=\{run\} apiActivity=\{apiActivity\} ttsRun=\{ttsRun\} \/>/);
  assert.match(inspector, /apiActivity = \[\]/);
  // The old standalone stages list and sampling section are gone: the
  // pipeline owns stage rows and vision details now.
  assert.doesNotMatch(inspector, /AILoadingState/);
  assert.doesNotMatch(inspector, /<SamplingActivity/);
  assert.doesNotMatch(inspector, /showStages=\{run\.status/);
  // Run outcome, cancellation, and advanced diagnostics survive.
  assert.match(inspector, /<RunPanel/);
  assert.match(inspector, /Cancel processing/);
  assert.match(inspector, /Request stop/);
  assert.match(inspector, /Advanced · Worker diagnostics/);
});

test('workspace feeds session activity into the inspector', () => {
  assert.match(workspace, /apiActivity=\{session\.apiActivity \?\? \[\]\}/);
});

test('activity history crosses the audited bridge', () => {
  assert.match(preload, /getApiActivity: \(id\) => ipcRenderer\.invoke\('get-api-activity', id \?\? null\)/);
  assert.match(projectsIpc, /ipcMain\.handle\('get-api-activity'/);
  assert.match(projectsIpc, /dropApiActivityScope\(app\.getPath\('userData'\), id\)/);
});

test('sessions pair live events and hydrate persisted history', () => {
  assert.match(sessions, /applyApiActivityEvent/);
  assert.match(sessions, /sanitizeActivityRecord/);
  assert.match(sessions, /api\.getApiActivity\(projectId\)/);
  assert.match(sessions, /apiActivity: session\.apiActivity/);
});
