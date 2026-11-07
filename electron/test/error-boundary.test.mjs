import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Static guards for the root render boundary. There is no JSX harness
// in this repo, so these tests pin the wiring the same way the
// navigation and brand suites do: the boundary exists, it catches
// render errors, its fallback offers recovery, and the renderer root
// actually mounts the app inside it.
const here = path.dirname(fileURLToPath(import.meta.url));

function readSource(relative) {
  return fs.readFileSync(path.join(here, relative), 'utf8');
}

const boundary = readSource('../src/app/ErrorBoundary.jsx');
const renderer = readSource('../src/renderer.jsx');

test('boundary catches render errors via the class lifecycle', () => {
  assert.match(boundary, /class ErrorBoundary extends Component/);
  assert.match(boundary, /static getDerivedStateFromError/);
  assert.match(boundary, /componentDidCatch/);
});

test('fallback names the failure and offers one-click recovery', () => {
  assert.match(boundary, /Something went wrong/);
  assert.match(boundary, /window\.location\.reload\(\)/);
  assert.match(boundary, /Reload/);
});

test('fallback uses semantic Obsidian tokens, never hardcoded colors', () => {
  assert.match(boundary, /bg-background/);
  assert.match(boundary, /text-foreground/);
  assert.match(boundary, /text-muted-foreground/);
  assert.doesNotMatch(boundary, /#[0-9a-fA-F]{3,8}/);
});

test('renderer root mounts the app inside the boundary', () => {
  assert.match(renderer, /import ErrorBoundary from '@\/app\/ErrorBoundary\.jsx'/);
  assert.match(renderer, /<ErrorBoundary>\s*<App \/>\s*<\/ErrorBoundary>/);
});

test('boundary underneath MotionConfig preserves reduced-motion behavior', () => {
  const motionIndex = renderer.indexOf('<MotionConfig');
  const boundaryIndex = renderer.indexOf('<ErrorBoundary>');
  assert.ok(motionIndex !== -1 && boundaryIndex !== -1 && motionIndex < boundaryIndex);
});
