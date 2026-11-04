import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Static guards for the Obsidian broadcast dashboard redesign. There is
// no JSX harness in this repo, so these tests verify the dashboard
// source keeps its contracts: the exact Animate UI primitive reused
// from the editor, the preserved project IPC flow, the removed
// worker-status duplication, honest statistics from persisted data,
// cards with real thumbnails, quick actions into existing workflows,
// and the required hero/banner states.
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
const creationDialog = fs.readFileSync(
  path.join(here, '../src/components/ProjectCreationDialog.jsx'),
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

test('dashboard opens with a workspace greeting', () => {
  assert.match(dashboard, /Welcome back/);
  assert.match(dashboard, /ROB, your evidence-aware live commentary companion\./);
});

test('statistics come from persisted data through shared selectors', () => {
  assert.match(dashboard, /from "@\/lib\/dashboard-stats\.js";/);
  assert.match(dashboard, /summarizeDashboard\(projects, listings\)/);
  assert.match(dashboard, /window\.api\?\.listArtifacts/);
  assert.match(dashboard, /label="Projects"/);
  assert.match(dashboard, /label="Analyses"/);
  assert.match(dashboard, /label="Commentaries"/);
});

test('project cards reuse extracted frames with an honest fallback', () => {
  assert.match(dashboard, /firstFrameName\(listing\)/);
  assert.match(dashboard, /projectMediaUrl\(project\.id, "frames", frame\)/);
  assert.match(dashboard, /loading="lazy"/);
  assert.match(dashboard, /describeArtifacts\(listing\)/);
  assert.match(dashboard, /<Film className="size-6 text-subtle" aria-hidden \/>/);
});

test('quick actions reuse the existing workflows without placeholders', () => {
  assert.match(dashboard, /Quick actions/);
  assert.match(dashboard, /<Upload data-icon="inline-start" \/>\s*Import gameplay/);
  assert.match(dashboard, /title="Run AI analysis"/);
  assert.match(dashboard, /title="Generate commentary"/);
  assert.match(dashboard, /onClick=\{handleAdd\}/);
  assert.match(dashboard, /onClick=\{handleRunAnalysis\}/);
  assert.match(dashboard, /onClick=\{handleGenerateCommentary\}/);
  assert.match(dashboard, /onOpenProject\(latestProjectId\)/);
  assert.doesNotMatch(dashboard, /TODO/);
  assert.doesNotMatch(dashboard, /not implemented/i);
});

test('hero is a monochrome cinematic banner without implying it works', () => {
  assert.match(hero, /Live commentary/);
  assert.match(hero, /Coming soon/);
  assert.match(hero, /Every moment\. Every play\. Live\./);
  assert.match(hero, /Real-time gameplay understanding, match memory and/);
  assert.match(hero, /broadcast-ready AI voice commentary\./);
  assert.match(hero, /assets\/images\/esports-setup\.webp/);
  assert.match(hero, /grayscale/);
  assert.match(hero, /object-cover/);
  assert.match(hero, /from-black/);
  assert.doesNotMatch(hero, /--live/);
  assert.doesNotMatch(hero, /text-live/);
  assert.doesNotMatch(hero, /radial-gradient/);
  assert.doesNotMatch(hero, /violet/i);
  assert.doesNotMatch(hero, /<Button/);
  assert.doesNotMatch(hero, /<a /);
  assert.doesNotMatch(hero, /onClick/);
  assert.doesNotMatch(hero, /motion\/react/);
  assert.doesNotMatch(hero, /https?:\/\//);
});

test('live banner renders below the greeting and above the stats and library', () => {
  const greeting = dashboard.indexOf('Welcome back');
  const banner = dashboard.indexOf('<LiveCommentaryHero />');
  const stats = dashboard.indexOf('Workspace statistics');
  const libraryHeading = dashboard.indexOf('Recent projects');
  assert.ok(
    greeting !== -1 && banner !== -1 && stats !== -1 && libraryHeading !== -1
      && greeting < banner && banner < stats && banner < libraryHeading,
    'banner renders between the greeting and the stats/library',
  );
});

test('large libraries page behind a View All toggle instead of a card wall', () => {
  assert.match(dashboard, /const RECENT_PROJECT_LIMIT = 6;/);
  assert.match(dashboard, /projects\.slice\(0, RECENT_PROJECT_LIMIT\)/);
  assert.match(dashboard, /\{visibleProjects\.map\(\(project\) => \(/);
  assert.match(dashboard, /View all \$\{projects\.length\} projects/);
  assert.match(dashboard, /aria-expanded=\{libraryExpanded\}/);
  assert.match(dashboard, /"Show less"/);
});

test('New project actions use the Plus icon and stay outside the collapsible body', () => {
  const addButtons = dashboard.match(/<Plus data-icon="inline-start" \/>\s*New project/g) ?? [];
  assert.equal(addButtons.length, 2, 'header action plus empty-state action');
  const headerButton = dashboard.indexOf('New project');
  const autoHeight = dashboard.indexOf('<AutoHeight');
  assert.ok(
    headerButton !== -1 && autoHeight !== -1 && headerButton < autoHeight,
    'header New project renders before (outside) the collapsible body',
  );
});

test('project import flow keeps its IPC semantics and silent cancellation', () => {
  assert.match(creationDialog, /window\.api\?\.selectVideo/);
  assert.match(creationDialog, /window\.api\?\.createProject/);
  assert.match(creationDialog, /if \(res\.cancelled\) \{\s*return;/);
  assert.match(creationDialog, /busyRef\.current/);
  assert.match(dashboard, /window\.api\?\.deleteProject/);
  assert.match(dashboard, /deleteBusyRef\.current/);
  assert.match(dashboard, /onOpenProject\(projectId\)/);
});

test('creation dialog attaches video through a single Add video picker', () => {
  assert.doesNotMatch(creationDialog, /kokonutui\/file-upload/);
  assert.doesNotMatch(creationDialog, /<FileUpload/);
  assert.doesNotMatch(creationDialog, /getPathForFile/);
  assert.match(creationDialog, /Add video/);
  assert.match(creationDialog, /Gameplay video/);
  assert.match(creationDialog, /window\.api\?\.selectVideo/);
  assert.match(creationDialog, /setRecording\(\{ path: res\.path, name: fileNameOf\(res\.path\) \}\)/);
  assert.match(creationDialog, /Replace/);
  assert.match(creationDialog, /Remove/);
  assert.match(creationDialog, /setRecording\(null\)/);
});

test('creation dialog gates submit on name plus recording and stays open on failure', () => {
  assert.match(creationDialog, /const canCreate = name\.trim\(\) !== "" && recording !== null/);
  assert.match(creationDialog, /disabled=\{\!canCreate\}/);
  assert.match(creationDialog, /window\.api\.createProject\(trimmed, recording\.path, game\)/);
  assert.match(creationDialog, /Could not create the project/);
  assert.match(creationDialog, /if \(!creating\) \{\s*onOpenChange\(next\);\s*\}/);
  assert.doesNotMatch(creationDialog, /toast\.success\("Project created"/);
  assert.match(creationDialog, /onCreated\?\.\(res\.project\.id\)/);
});

test('dashboard opens the dialog instead of an inline naming card', () => {
  assert.match(dashboard, /import ProjectCreationDialog from "@\/components\/ProjectCreationDialog\.jsx";/);
  assert.match(dashboard, /<ProjectCreationDialog/);
  assert.match(dashboard, /New project/);
  assert.doesNotMatch(dashboard, /pendingPath/);
  assert.doesNotMatch(dashboard, /Name your project/);
  assert.doesNotMatch(dashboard, /Match details \(optional\)/);
});

test('creation keeps a minimal game form with stable ids and no teams', () => {
  assert.match(creationDialog, /from "@\/components\/ui\/select\.jsx";/);
  assert.match(creationDialog, /<SelectTrigger aria-label="Game"/);
  assert.match(creationDialog, /\{GAMES\.map\(\(game\) => \(\s*<SelectItem key=\{game\.id\} value=\{game\.id\}>/);
  assert.match(creationDialog, /matchTypesFor\(gameId\)/);
  assert.match(creationDialog, /modesFor\(gameId, matchType \|\| null\)/);
  assert.match(creationDialog, /mapsFor\(gameId\)/);
  assert.match(creationDialog, /gameInputToRecord\(\{/);
  assert.doesNotMatch(creationDialog, /<GameMetadataForm/);
  assert.doesNotMatch(creationDialog, /Teams/);
  assert.doesNotMatch(dashboard, /GameMetadataForm/);
});

test('library collapse is an accessible toggle with a stable region id', () => {
  assert.match(dashboard, /aria-expanded=\{libraryOpen\}/);
  assert.match(dashboard, /aria-controls="project-library-body"/);
  assert.match(dashboard, /id="project-library-body"/);
  assert.match(dashboard, /aria-labelledby="recorded-library-heading"/);
  assert.match(dashboard, /id="recorded-library-heading"/);
});

test('loading uses skeletons and errors offer retry', () => {
  assert.match(dashboard, /<ProjectGridSkeleton \/>/);
  assert.match(dashboard, /<Skeleton /);
  assert.match(dashboard, /role="status" aria-label="Loading projects"/);
  assert.match(dashboard, /onClick=\{handleRetry\}/);
  assert.match(dashboard, /<RotateCcw data-icon="inline-start" \/>\s*Retry/);
  assert.match(dashboard, /async function handleRetry\(\)/);
});

test('project toasts are stable single-slot notifications', () => {
  assert.doesNotMatch(creationDialog, /toast\.success\("Project created"/);
  assert.match(dashboard, /toast\.success\("Project created", \{\s*id: "project-created"/);
  assert.match(dashboard, /toast\.success\("Project deleted", \{\s*id: "project-deleted"/);
  assert.match(dashboard, /toast\.error\("Could not delete project"/);
  assert.doesNotMatch(dashboard, /toast\.loading/);
  assert.doesNotMatch(creationDialog, /toast\.loading/);
});

test('dashboard transitions stay opacity-only on shared motion tokens', () => {
  assert.match(dashboard, /<AnimatePresence mode="wait" initial=\{false\}>/);
  assert.match(dashboard, /initial=\{\{ opacity: 0 \}\}/);
  assert.match(dashboard, /animate=\{\{ opacity: 1 \}\}/);
  assert.match(dashboard, /exit=\{\{ opacity: 0 \}\}/);
  assert.doesNotMatch(dashboard, /initial=\{\{[^}]*height/);
});

test('deletion opens a typed-name dialog instead of the two-click arm', () => {
  assert.match(dashboard, /<DialogTitle[^>]*>Delete project\?<\/DialogTitle>/);
  assert.match(dashboard, /This will permanently delete this project and its associated data\. This action cannot be undone\./);
  assert.match(dashboard, /placeholder="Enter project name"/);
  assert.match(dashboard, /to confirm/);
  assert.match(dashboard, /Deleting…/);
  assert.doesNotMatch(dashboard, /armedDelete/);
  assert.doesNotMatch(dashboard, /onArmDelete/);
  assert.doesNotMatch(dashboard, /Confirm delete /);
});

test('deletion dialog composes the shared Dialog primitives', () => {
  assert.match(dashboard, /import \{\s*Dialog,\s*DialogContent,\s*DialogDescription,\s*DialogFooter,\s*DialogHeader,\s*DialogTitle,\s*\} from "@\/components\/ui\/dialog\.jsx";/);
  assert.match(dashboard, /<Dialog open=\{/);
  assert.match(dashboard, /<DialogContent/);
  assert.match(dashboard, /<DialogHeader/);
  assert.match(dashboard, /<DialogFooter/);
  assert.match(dashboard, /<DialogDescription/);
  assert.match(dashboard, /variant="destructive"/);
  assert.match(dashboard, /showCloseButton=\{/);
});

test('typed-name matching requires the complete name, case-insensitive', () => {
  assert.match(dashboard, /typedName\.trim\(\)\.toLocaleLowerCase\(\) === deleteTarget\.name\.trim\(\)\.toLocaleLowerCase\(\)/);
  assert.match(dashboard, /htmlFor="delete-confirm-name"/);
  assert.match(dashboard, /id="delete-confirm-name"/);
  assert.match(dashboard, /setTypedName\(""\)/);
});

test('deletion stays single-flight through the existing IPC call', () => {
  assert.match(dashboard, /window\.api\.deleteProject\(deleteTarget\.id\)/);
  assert.match(dashboard, /deleteBusyRef\.current = true/);
  assert.match(dashboard, /disabled=\{[^}]*!nameMatches[^}]*\}/);
});

test('successful deletion removes locally before reconciling with the backend', () => {
  assert.match(dashboard, /setProjects\(\(prev\) => prev\.filter\(\(project\) => project\.id !== deleteTarget\.id\)\)/);
  assert.match(dashboard, /refresh\(\)\.then\(setProjects,\s*\(\) => \{\}\)/);
});

test('deleted cards exit with a restrained shared-token transition', () => {
  assert.match(dashboard, /exit=\{\{ opacity: 0, x: 12 \}\}/);
  assert.match(dashboard, /transition=\{\{ duration: MOTION\.fast, ease: EASING\.entrance \}\}/);
  assert.doesNotMatch(dashboard, /exit=\{\{[^}]*blur/);
  assert.doesNotMatch(dashboard, /exit=\{\{[^}]*box-shadow/);
  assert.doesNotMatch(dashboard, /stagger/);
});

test('the delete action stays separate from opening the project', () => {
  assert.match(dashboard, /aria-label=\{`Delete \$\{project\.name\}`\}/);
  assert.match(dashboard, /title=\{`Delete \$\{project\.name\}`\}/);
  assert.match(dashboard, /onClick=\{\(\) => onRequestDelete\(project\)\}/);
  assert.doesNotMatch(dashboard, /onDelete=\{handleDelete\}/);
});

test('successful deletion notifies the shell to clear stale workspace state', () => {
  assert.match(dashboard, /export default function DashboardSection\(\{ onOpenProject, onProjectDeleted, activeProjectId/);
  assert.match(dashboard, /onProjectDeleted\?\.\(deletedId\)/);
  const app = fs.readFileSync(path.join(here, '../src/app/App.jsx'), 'utf8');
  assert.match(app, /onProjectDeleted: handleProjectDeleted/);
  assert.match(app, /activeProjectId: workspaceId/);
  assert.match(app, /if \(workspaceId !== null && id === workspaceId\)/);
});
