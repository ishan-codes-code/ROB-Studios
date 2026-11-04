import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Static guards for the integrated window title bar. There is no JSX
// harness in this repo, so these tests verify the renderer sources keep
// the chrome contract: one brand mark, a full-width drag region with no
// interactive elements, reserved caption-button space on Windows, and no
// duplicate header in the sidebar.
const here = path.dirname(fileURLToPath(import.meta.url));
const titlebar = fs.readFileSync(
  path.join(here, '../src/layout/TitleBar.jsx'),
  'utf8',
);
const layout = fs.readFileSync(
  path.join(here, '../src/layout/AppLayout.jsx'),
  'utf8',
);
const sidebar = fs.readFileSync(
  path.join(here, '../src/layout/Sidebar.jsx'),
  'utf8',
);
const app = fs.readFileSync(
  path.join(here, '../src/app/App.jsx'),
  'utf8',
);
const windowMain = fs.readFileSync(
  path.join(here, '../src/main/window.js'),
  'utf8',
);

test('title bar carries the studio mark with semantic tokens only', () => {
  assert.match(titlebar, /<AudioLines className="size-3" aria-hidden \/>/);
  assert.match(titlebar, /ROB Studio/);
  assert.match(titlebar, /\{context \? \(/);
  assert.match(titlebar, /aria-label="ROB Studio window title bar"/);
  assert.match(titlebar, /bg-surface/);
  assert.match(titlebar, /border-b border-border/);
  assert.match(titlebar, /text-subtle/);
  assert.doesNotMatch(titlebar, /#[0-9a-fA-F]{3,8}/);
});

test('title bar is a drag region with no interactive elements', () => {
  assert.match(titlebar, /WebkitAppRegion: "drag"/);
  assert.match(titlebar, /select-none/);
  assert.doesNotMatch(titlebar, /<Button/);
  assert.doesNotMatch(titlebar, /<button/);
  assert.doesNotMatch(titlebar, /<input/);
  assert.doesNotMatch(titlebar, /onClick/);
});

test('title bar reserves caption-button space on Windows only', () => {
  assert.match(titlebar, /navigator\.userAgentData\?\.platform/);
  assert.match(titlebar, /navigator\.platform/);
  assert.match(titlebar, /w-\[140px\]/);
  assert.match(titlebar, /\{isWindowsChrome\(\) \? <span className="w-\[140px\] shrink-0" aria-hidden \/> : null\}/);
});

test('title bar height matches the native overlay height', () => {
  assert.match(titlebar, /flex h-9 shrink-0/);
  assert.match(windowMain, /TITLE_BAR_OVERLAY_HEIGHT = 36/);
});

test('app layout renders the title bar above the shell', () => {
  assert.match(layout, /\{ sidebar, header, titlebar, children, className \}/);
  assert.match(layout, /flex h-full min-h-0 min-w-0 flex-col/);
  const bar = layout.indexOf('{titlebar}');
  const row = layout.indexOf('{sidebar}');
  assert.ok(bar !== -1 && row !== -1 && bar < row, 'title bar precedes the sidebar row');
});

test('sidebar keeps no duplicate brand header', () => {
  assert.doesNotMatch(sidebar, /Commentary Studio/);
  assert.doesNotMatch(sidebar, /AudioLines/);
  assert.match(sidebar, /aria-label="Application navigation"/);
  assert.match(sidebar, /id="studio-navigation"/);
});

test('app shell wires the title bar into every window state', () => {
  assert.match(app, /import TitleBar from "@\/layout\/TitleBar\.jsx";/);
  assert.match(app, /titlebar=\{<TitleBar context=\{meta\.title\} \/>\}/);
  assert.match(app, /<TitleBar context="Setup" \/>/);
});
