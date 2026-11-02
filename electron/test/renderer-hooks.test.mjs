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
  '../src/app/sections/workspace/ProcessingInspector.jsx',
  '../src/app/sections/workspace/ProjectConfiguration.jsx',
  '../src/layout/Sidebar.jsx',
];

function checkFile(relative) {
  const source = fs.readFileSync(path.join(here, relative), 'utf8');
  const importMatch = source.match(/import\s*\{([^}]*)\}\s*from\s*["']react["']/);
  const imported = new Set(
    importMatch ? importMatch[1].split(',').map((entry) => entry.trim()).filter(Boolean) : [],
  );
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
