import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INSPECTOR_DEFAULT_WIDTH,
  INSPECTOR_MAX_WIDTH,
  INSPECTOR_MIN_WIDTH,
  clampInspectorWidth,
  stepInspectorWidth,
} from '../src/lib/inspector-width.js';

test('inspector width bounds keep script text usable without crushing preview', () => {
  assert.ok(INSPECTOR_MIN_WIDTH >= 280);
  assert.ok(INSPECTOR_MAX_WIDTH <= 480);
  assert.ok(INSPECTOR_DEFAULT_WIDTH >= INSPECTOR_MIN_WIDTH);
  assert.ok(INSPECTOR_DEFAULT_WIDTH <= INSPECTOR_MAX_WIDTH);
});

test('clampInspectorWidth clamps into range and rounds', () => {
  assert.equal(clampInspectorWidth(0), INSPECTOR_MIN_WIDTH);
  assert.equal(clampInspectorWidth(10_000), INSPECTOR_MAX_WIDTH);
  assert.equal(clampInspectorWidth(333.6), 334);
  assert.equal(clampInspectorWidth(320), 320);
});

test('clampInspectorWidth falls back to default for non-numeric input', () => {
  assert.equal(clampInspectorWidth(NaN), INSPECTOR_DEFAULT_WIDTH);
  assert.equal(clampInspectorWidth(undefined), INSPECTOR_DEFAULT_WIDTH);
  assert.equal(clampInspectorWidth('wide'), INSPECTOR_DEFAULT_WIDTH);
});

test('stepInspectorWidth moves by keyboard strides and clamps at the ends', () => {
  assert.equal(stepInspectorWidth(340, 1), 356);
  assert.equal(stepInspectorWidth(340, -1), 324);
  assert.equal(stepInspectorWidth(340, 1, true), 404);
  assert.equal(stepInspectorWidth(340, -1, true), INSPECTOR_MIN_WIDTH);
  assert.equal(stepInspectorWidth(INSPECTOR_MAX_WIDTH, 1), INSPECTOR_MAX_WIDTH);
  assert.equal(stepInspectorWidth(INSPECTOR_MIN_WIDTH, -1), INSPECTOR_MIN_WIDTH);
  assert.equal(stepInspectorWidth(340, 0), 340);
});
