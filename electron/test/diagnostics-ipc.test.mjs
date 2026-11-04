import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RENDERER_DIAGNOSTIC_EVENTS, registerDiagnosticsIpc } from '../src/main/ipc/diagnostics.js';
import { diagnosticsLogPath } from '../src/main/diagnostics-log.mjs';

function setup() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'rob-diag-ipc-'));
  const handlers = {};
  registerDiagnosticsIpc({
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
    app: { getPath: (name) => { assert.equal(name, 'userData'); return userData; } },
  });
  const report = (name, meta) => handlers['diagnostics-report']({}, name, meta);
  const lines = () => fs.readFileSync(diagnosticsLogPath(userData), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line));
  return { userData, report, lines };
}

test('allowlisted lifecycle events persist with metadata', async () => {
  const { report, lines } = setup();
  assert.deepEqual(RENDERER_DIAGNOSTIC_EVENTS, [
    'onboarding.finish_later.clicked',
    'onboarding.completion.persist.started',
    'onboarding.completion.persist.finished',
    'onboarding.navigation.dashboard',
    'dashboard.mount.started',
    'dashboard.mount.completed',
    'dashboard.hydration.started',
    'dashboard.hydration.completed',
  ]);
  const result = await report('dashboard.hydration.completed', { ok: true, projectCount: 3 });
  assert.deepEqual(result, { ok: true });
  const [entry] = lines();
  assert.equal(entry.type, 'dashboard.hydration.completed');
  assert.equal(entry.ok, true);
  assert.equal(entry.projectCount, 3);
  assert.ok(!Number.isNaN(Date.parse(entry.ts)));
});

test('unknown event names are rejected and never persisted', async () => {
  const { userData, report } = setup();
  for (const name of ['window.api.eval', 'diagnostics-report', '', null, 42]) {
    const result = await report(name, {});
    assert.equal(result.ok, false, JSON.stringify(name));
  }
  assert.ok(!fs.existsSync(diagnosticsLogPath(userData)), 'no log file for rejected events');
});

test('malformed metadata is rejected', async () => {
  const { report } = setup();
  assert.equal((await report('dashboard.mount.started', 'x')).ok, false);
  assert.equal((await report('dashboard.mount.started', [1])).ok, false);
  assert.equal((await report('dashboard.mount.started', { ok: { deep: true } })).ok, false);
  assert.equal((await report('dashboard.mount.started', { ok: true, big: 'x'.repeat(600) })).ok, false);
  const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i]));
  assert.equal((await report('dashboard.mount.started', many)).ok, false);
  assert.equal((await report('dashboard.mount.started')).ok, true, 'absent meta is fine');
});

test('secret-shaped metadata never reaches the log', async () => {
  const { userData, report, lines } = setup();
  await report('dashboard.mount.started', { apiKey: 'sk-SECRET-1', ok: true });
  const raw = fs.readFileSync(diagnosticsLogPath(userData), 'utf8');
  assert.doesNotMatch(raw, /sk-SECRET-1/);
  assert.equal(lines()[0].apiKey, '[REDACTED]');
  assert.equal(lines()[0].ok, true);
});

test('handler never throws on broken inputs', async () => {
  const { report } = setup();
  await assert.doesNotReject(report(undefined, undefined));
  await assert.doesNotReject(report('dashboard.mount.started', null));
});
