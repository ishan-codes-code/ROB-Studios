import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Static guards for the shared game metadata form (editor Configure
// tab): suggestion selects compose the shared Select primitive,
// legacy values still render, and clearing keeps working. There is
// no JSX harness in this repo, so these tests verify the source
// keeps its contracts.
const here = path.dirname(fileURLToPath(import.meta.url));
const gameForm = fs.readFileSync(
  path.join(here, '../src/components/GameMetadataForm.jsx'),
  'utf8',
);

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
