import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Static guards for the AI Providers redesign. There is no JSX harness
// in this repo, so these checks read source text: inline-expanding
// rows, single-slot toast feedback, border-light chrome, and honest
// Baseten pinned-model communication.
const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, '../src');

function read(relative) {
  return fs.readFileSync(path.join(SRC, relative), 'utf8');
}

test('provider rows expand through the Base UI accordion primitive', () => {
  const source = read('app/sections/ApiKeysSection.jsx');
  assert.match(source, /from "@animate-ui\/react\/primitives\/base-ui\/accordion"/);
  assert.match(source, /<Accordion\.Root/);
  assert.match(source, /multiple=\{false\}/);
  assert.match(source, /onValueChange=\{\(next\) => setSelectedId\(next\[0\] \?\? null\)\}/);
  assert.match(source, /<Accordion\.Item/);
  assert.match(source, /value=\{entry\.id\}/);
  assert.match(source, /<Accordion\.Header>/);
  assert.match(source, /<Accordion\.Trigger/);
  assert.match(source, /<Accordion\.Panel/);
  assert.doesNotMatch(source, /AutoHeight/);
  assert.doesNotMatch(source, /aria-controls=\{`provider-detail-/);
});

test('provider feedback is a single-slot toast; errors stay inline', () => {
  const source = read('app/sections/ApiKeysSection.jsx');
  assert.match(source, /from "sonner"/);
  assert.match(source, /const PROVIDER_TOAST_ID = "provider-status"/);
  assert.ok(!/toast\.success\([^)]*\{[^}]*id: (?!PROVIDER_TOAST_ID)/.test(source),
    'every provider toast must reuse the single stable id');
  assert.doesNotMatch(source, /setNotice/);
  assert.match(source, /Something went wrong/);
});

test('the providers page stays border-light', () => {
  const source = read('app/sections/ApiKeysSection.jsx');
  assert.doesNotMatch(source, /from "@\/components\/ui\/card\.jsx"/);
  assert.doesNotMatch(source, /<Card[ >]/);
});

test('the Baseten pinned model display matches what creation saves', () => {
  const page = read('app/sections/ApiKeysSection.jsx');
  const picker = read('app/sections/providers/ModelPicker.jsx');
  const created = page.match(/provider === "baseten" \? "(meta-models\/[^"]+)"/);
  assert.ok(created, 'creation pins a Baseten model literal');
  assert.ok(picker.includes(`>${created[1]}<`),
    'ModelPicker must display the exact pinned model creation saves');
  assert.match(picker, /always uses this exact model/);
  assert.match(picker, /OpenAI-compatible inference/);
});

test('saved rows disclose capabilities, not technical strings', () => {
  const source = read('app/sections/ApiKeysSection.jsx');
  assert.match(source, /\{providerLabel\(entry\.provider\)\} · \{capabilityLabel\(entry\)\}/);
  assert.doesNotMatch(source, /entry\.model\}/);
  assert.doesNotMatch(source, /entry\.baseUrl\}/);
});
