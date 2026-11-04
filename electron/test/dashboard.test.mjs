import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Static guards for the live-commentary dashboard redesign. There is no
// JSX harness in this repo, so these tests verify the dashboard source
// keeps its contracts: the exact Animate UI primitive reused from the
// editor, the preserved project IPC flow, the removed worker-status
// duplication, and the required hero/library copy and states.
const here = path.dirname(fileURLToPath(import.meta.url));
const dashboard = fs.readFileSync(
  path.join(here, '../src/app/sections/DashboardSection.jsx'),
  'utf8',
);
const hero = fs.readFileSync(
  path.join(here, '../src/app/sections/LiveCommentaryHero.jsx'),
  'utf8',
);
const inspector = fs.readFileSync(
  path.join(here, '../src/app/sections/workspace/ProcessingInspector.jsx'),
  'utf8',
);
const header = fs.readFileSync(
  path.join(here, '../src/layout/AppHeader.jsx'),
  'utf8',
);

test('dashboard reuses the editor AutoHeight primitive with the same props', () => {
  const importLine =
    'import { AutoHeight } from "@animate-ui/react/primitives/effects/auto-height";';
  assert.ok(
    inspector.includes(importLine),
    'editor still uses AutoHeight (the reuse source)',
  );
  assert.ok(dashboard.includes(importLine), 'dashboard reuses AutoHeight');
  assert.match(dashboard, /<AutoHeight\s+deps=\{/);
  assert.match(
    dashboard,
    /transition=\{\{ duration: MOTION\.standard, ease: EASING\.entrance \}\}/,
  );
});

test('dashboard has no worker-status card while the header keeps its own', () => {
  assert.doesNotMatch(dashboard, /WorkerStatus/);
  assert.doesNotMatch(dashboard, /useWorkerStatus/);
  assert.match(header, /useWorkerStatus/);
  assert.match(header, /<StatusIndicator status=\{status\}/);
});

test('hero announces the future capability without implying it works', () => {
  assert.match(hero, /Live AI commentary/);
  assert.match(hero, /Coming soon/);
  assert.match(hero, /Every moment\. Every play\. Live\./);
  assert.match(hero, /Live gameplay analysis/);
  assert.match(hero, /Context-aware match intelligence/);
  assert.match(hero, /Real-time AI voice commentary/);
  assert.doesNotMatch(hero, /<Button/);
  assert.doesNotMatch(hero, /Start Live/i);
  assert.doesNotMatch(hero, /motion\/react/);
});

test('Add Video actions use the Plus icon and stay outside the collapsible body', () => {
  const addButtons = dashboard.match(/<Plus data-icon="inline-start" \/>\s*Add Video/g) ?? [];
  assert.equal(addButtons.length, 2, 'header action plus empty-state action');
  const headerButton = dashboard.indexOf('Add Video');
  const autoHeight = dashboard.indexOf('<AutoHeight');
  assert.ok(
    headerButton !== -1 && autoHeight !== -1 && headerButton < autoHeight,
    'header Add Video renders before (outside) the collapsible body',
  );
});

test('project import flow keeps its IPC semantics and silent cancellation', () => {
  assert.match(dashboard, /window\.api\?\.selectVideo/);
  assert.match(dashboard, /window\.api\?\.createProject/);
  assert.match(dashboard, /window\.api\?\.deleteProject/);
  assert.match(dashboard, /onOpenProject\(res\.project\.id\)/);
  assert.match(dashboard, /if \(res\.cancelled\) \{\s*return;/);
  assert.match(dashboard, /submitBusyRef\.current/);
  assert.match(dashboard, /deleteBusyRef\.current/);
});

test('library collapse is an accessible toggle with a stable region id', () => {
  assert.match(dashboard, /aria-expanded=\{libraryOpen\}/);
  assert.match(dashboard, /aria-controls="project-library-body"/);
  assert.match(dashboard, /id="project-library-body"/);
  assert.match(dashboard, /aria-labelledby="recorded-library-heading"/);
  assert.match(dashboard, /id="recorded-library-heading"/);
});

test('loading uses skeletons and errors offer retry', () => {
  assert.match(dashboard, /<ProjectListSkeleton \/>/);
  assert.match(dashboard, /<Skeleton /);
  assert.match(dashboard, /role="status" aria-label="Loading projects"/);
  assert.match(dashboard, /onClick=\{handleRetry\}/);
  assert.match(dashboard, /<RotateCcw data-icon="inline-start" \/>\s*Retry/);
  assert.match(dashboard, /async function handleRetry\(\)/);
});

test('project toasts are stable single-slot success notifications', () => {
  assert.match(dashboard, /toast\.success\("Project created", \{\s*id: "project-created"/);
  assert.match(dashboard, /toast\.success\("Project deleted", \{\s*id: "project-deleted"/);
  assert.doesNotMatch(dashboard, /toast\.error/);
  assert.doesNotMatch(dashboard, /toast\.loading/);
});

test('dashboard transitions stay opacity-only on shared motion tokens', () => {
  assert.match(dashboard, /<AnimatePresence mode="wait" initial=\{false\}>/);
  assert.match(dashboard, /initial=\{\{ opacity: 0 \}\}/);
  assert.match(dashboard, /animate=\{\{ opacity: 1 \}\}/);
  assert.match(dashboard, /exit=\{\{ opacity: 0 \}\}/);
  assert.doesNotMatch(dashboard, /initial=\{\{[^}]*height/);
});
