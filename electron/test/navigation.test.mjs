import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Static guards for the Dashboard/Editor navigation icons. There is no JSX
// harness in this repo, so these tests verify the sidebar source keeps two
// distinct, semantically appropriate icons with unchanged nav behavior.
const here = path.dirname(fileURLToPath(import.meta.url));
const sidebar = fs.readFileSync(
  path.join(here, '../src/layout/Sidebar.jsx'),
  'utf8',
);

function iconFor(entryId) {
  const match = sidebar.match(
    new RegExp(`\\{ id: "${entryId}", label: "[^"]+", icon: (\\w+) \\}`),
  );
  assert.ok(match, `nav entry "${entryId}" keeps its shape`);
  return match[1];
}

function editorIcon() {
  const block = sidebar.match(
    /<NavButton\s+id="editor"[\s\S]*?Icon=\{(\w+)\}/,
  );
  assert.ok(block, 'workspace Editor button keeps its shape');
  return block[1];
}

test('dashboard and editor use distinct navigation icons', () => {
  const dashboard = iconFor('dashboard');
  const editor = editorIcon();
  assert.equal(dashboard, 'LayoutDashboard');
  assert.equal(editor, 'Clapperboard');
  assert.notEqual(dashboard, editor);
});

test('navigation behavior is unchanged', () => {
  assert.match(sidebar, /label: "Dashboard"/);
  assert.match(sidebar, /label="Editor"/);
  assert.match(sidebar, /aria-current=\{selected \? "page" : undefined\}/);
  assert.match(sidebar, /title=\{collapsed \? label : undefined\}/);
  assert.match(sidebar, /onSelect\(id\)/);
  assert.match(sidebar, /import \{\s*AudioWaveform,/);
  assert.doesNotMatch(sidebar, /AudioLines/);
  assert.match(sidebar, /LayoutDashboard,/);
  assert.match(sidebar, /Clapperboard,/);
});
