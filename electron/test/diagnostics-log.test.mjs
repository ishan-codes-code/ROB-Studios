import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DIAGNOSTICS_FILE_NAME,
  DIAGNOSTICS_MAX_BYTES,
  diagnosticsEnvironment,
  diagnosticsLogPath,
  recordDiagnosticsEvent,
} from '../src/main/diagnostics-log.mjs';

function tempUserData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rob-diag-'));
}

function readLines(userData) {
  const raw = fs.readFileSync(diagnosticsLogPath(userData), 'utf8');
  return raw.trim().split('\n').map((line) => JSON.parse(line));
}

test('diagnostics log lives under userData', () => {
  assert.equal(diagnosticsLogPath('/ud'), path.join('/ud', DIAGNOSTICS_FILE_NAME));
});

test('events persist as timestamped JSONL', () => {
  const userData = tempUserData();
  assert.equal(
    recordDiagnosticsEvent(userData, { type: 'render-process-gone', reason: 'crashed', exitCode: 133 }),
    true,
  );
  const [entry] = readLines(userData);
  assert.equal(entry.type, 'render-process-gone');
  assert.equal(entry.reason, 'crashed');
  assert.equal(entry.exitCode, 133);
  assert.ok(!Number.isNaN(Date.parse(entry.ts)), 'ts parses as a timestamp');
});

test('environment snapshot carries versions, platform, CPU, and GPU status', () => {
  const snapshot = diagnosticsEnvironment({
    appVersion: '1.0.0',
    electronVersion: '36.9.5',
    chromiumVersion: '136.0.7103.177',
    nodeVersion: '22.19.0',
    platform: 'linux',
    arch: 'x64',
    cpuModel: 'AMD EPYC 7763',
    cpuFlags: 'fpu avx avx2',
    packaged: false,
    gpuFeatureStatus: { gpu_compositing: 'enabled', canvas: 'software' },
    crashDumpsPath: '/tmp/dumps',
  });
  assert.equal(snapshot.appVersion, '1.0.0');
  assert.equal(snapshot.electronVersion, '36.9.5');
  assert.equal(snapshot.chromiumVersion, '136.0.7103.177');
  assert.equal(snapshot.nodeVersion, '22.19.0');
  assert.equal(snapshot.platform, 'linux');
  assert.equal(snapshot.arch, 'x64');
  assert.equal(snapshot.cpuModel, 'AMD EPYC 7763');
  assert.equal(snapshot.cpuFlags, 'fpu avx avx2');
  assert.equal(snapshot.packaged, false);
  assert.deepEqual(snapshot.gpuFeatureStatus, { gpu_compositing: 'enabled', canvas: 'software' });
  assert.equal(snapshot.crashDumpsPath, '/tmp/dumps');
});

test('secret-shaped keys are redacted, never persisted', () => {
  const userData = tempUserData();
  recordDiagnosticsEvent(userData, {
    type: 'probe',
    apiKey: 'sk-live-SECRET-VALUE-12345',
    nested: { accessToken: 'tok-SECRET-67890', reason: 'crashed' },
    authorization: 'Bearer SECRET-ABCDE',
    password: 'hunter2-secret',
    credential: 'cred-SECRET',
    exitCode: 133,
  });
  const raw = fs.readFileSync(diagnosticsLogPath(userData), 'utf8');
  for (const secret of ['sk-live-SECRET-VALUE-12345', 'tok-SECRET-67890', 'SECRET-ABCDE', 'hunter2-secret', 'cred-SECRET']) {
    assert.doesNotMatch(raw, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'secret value absent');
  }
  const [entry] = readLines(userData);
  assert.equal(entry.apiKey, '[REDACTED]');
  assert.equal(entry.nested.accessToken, '[REDACTED]');
  assert.equal(entry.nested.reason, 'crashed', 'non-secret fields survive');
  assert.equal(entry.exitCode, 133);
});

test('log rotation bounds total size and keeps the newest event', () => {
  const userData = tempUserData();
  const maxBytes = 1024;
  for (let index = 0; index < 60; index += 1) {
    recordDiagnosticsEvent(userData, { type: 'noise', index, pad: 'x'.repeat(120) }, { maxBytes });
  }
  recordDiagnosticsEvent(userData, { type: 'render-process-gone', reason: 'crashed', exitCode: 133 }, { maxBytes });
  const logPath = diagnosticsLogPath(userData);
  const backupPath = `${logPath}.1`;
  assert.ok(fs.existsSync(backupPath), 'rotation produced a backup');
  const total = fs.statSync(logPath).size + fs.statSync(backupPath).size;
  assert.ok(total <= maxBytes * 2 + 512, `bounded at ${total} bytes`);
  const lines = readLines(userData);
  assert.equal(lines.at(-1).type, 'render-process-gone', 'newest event retained');
  assert.ok(lines.every((entry) => typeof entry.ts === 'string'), 'every line stays valid JSONL');
});

test('default budget is a sane bound', () => {
  assert.ok(DIAGNOSTICS_MAX_BYTES >= 64 * 1024 && DIAGNOSTICS_MAX_BYTES <= 1024 * 1024);
});

test('write failures never throw and report false', () => {
  const blocker = path.join(tempUserData(), 'file-not-dir');
  fs.writeFileSync(blocker, 'x');
  assert.equal(recordDiagnosticsEvent(path.join(blocker, 'sub'), { type: 'x' }), false);
  assert.equal(recordDiagnosticsEvent('', { type: 'x' }), false);
  assert.equal(recordDiagnosticsEvent(tempUserData(), null), false);
  assert.equal(recordDiagnosticsEvent(tempUserData(), 'not-an-object'), false);
});

test('oversized strings are truncated to bound line size', () => {
  const userData = tempUserData();
  recordDiagnosticsEvent(userData, { type: 'x', detail: 'y'.repeat(9000) });
  const [entry] = readLines(userData);
  assert.ok(entry.detail.length < 9000);
  assert.match(entry.detail, /\(truncated\)$/);
});
