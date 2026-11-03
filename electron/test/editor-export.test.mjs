import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The toolbar owns Export: exactly one component renders the action,
// exactly one hook subscribes to export events, and exactly two modules
// (export controller + workspace run lifecycle) send toast
// notifications. These static guards keep that ownership from silently
// splitting again. There is no JSX harness in this repo, so the checks
// read source text.
const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, '../src');

function read(relative) {
  return fs.readFileSync(path.join(SRC, relative), 'utf8');
}

function jsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...jsFiles(full));
    } else if (/\.(jsx|js)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const RENDERER_DIRS = ['app', 'components', 'hooks', 'layout', 'lib', 'primitives'].map((dir) =>
  path.join(SRC, dir),
);

function rendererFilesWith(pattern) {
  return RENDERER_DIRS.flatMap((dir) => jsFiles(dir)).filter((file) =>
    pattern.test(fs.readFileSync(file, 'utf8')),
  );
}

test('only the export controller subscribes to export events', () => {
  const hits = rendererFilesWith(/onExportEvent/);
  assert.deepEqual(
    hits.map((file) => path.relative(SRC, file)),
    ['hooks/useVideoExport.js'],
  );
});

test('only the export controller invokes export IPC', () => {
  const callers = rendererFilesWith(/window\.api\.(exportVideo|cancelExport)\(/);
  assert.deepEqual(
    callers.map((file) => path.relative(SRC, file)),
    ['hooks/useVideoExport.js'],
  );
});

test('the timeline renders no export action', () => {
  const source = read('app/sections/workspace/CommentaryTimeline.jsx');
  assert.ok(!/Export/.test(source), 'timeline must not mention Export');
});

test('the toolbar renders the single Export action with full state coverage', () => {
  const source = read('app/sections/workspace/EditorCenter.jsx');
  assert.match(source, /useVideoExport/);
  assert.match(source, /Export/);
  assert.match(source, /status === "starting"/);
  assert.match(source, /status === "exporting"/);
  assert.match(source, /status === "done"/);
  assert.match(source, /status === "error"/);
  assert.match(source, /readyCount === 0/);
});

test('toast notifications have exactly two owners', () => {
  const owners = rendererFilesWith(/from ["']sonner["']/).filter(
    (file) => !path.relative(SRC, file).startsWith('components/ui/'),
  );
  assert.deepEqual(
    owners.map((file) => path.relative(SRC, file)).sort(),
    ['app/sections/WorkspaceSection.jsx', 'hooks/useVideoExport.js'],
  );
});

test('run toasts replace one loading toast instead of stacking', () => {
  const source = read('app/sections/WorkspaceSection.jsx');
  assert.match(source, /toast\.loading\("Processing video…", \{ id: runToastId \}\)/);
  assert.match(source, /toast\.success\("Processing complete", \{\s*id: runToastId,/);
  assert.match(source, /toast\.error\("Processing failed", \{\s*id: runToastId,/);
  assert.match(source, /lastTerminalNotified/);
});
