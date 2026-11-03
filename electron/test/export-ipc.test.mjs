import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { registerExportIpc, resolveExportPlan } from '../src/main/ipc/export.js';
import { createProject, getProjectOutputDir } from '../src/project-store.mjs';

let rootCounter = 0;

function makeUserData() {
  rootCounter += 1;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `ai-export-ipc-${process.pid}-${rootCounter}-`));
  return { base, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

function wavBytes(seconds = 2) {
  const sampleRate = 24000;
  const byteRate = sampleRate * 2;
  const dataSize = byteRate * seconds;
  const file = Buffer.alloc(44 + dataSize);
  file.write('RIFF', 0);
  file.writeUInt32LE(file.length - 8, 4);
  file.write('WAVE', 8);
  file.write('fmt ', 12);
  file.writeUInt32LE(16, 16);
  file.writeUInt16LE(1, 20);
  file.writeUInt16LE(1, 22);
  file.writeUInt32LE(sampleRate, 24);
  file.writeUInt32LE(byteRate, 28);
  file.writeUInt16LE(2, 32);
  file.writeUInt16LE(16, 34);
  file.write('data', 36);
  file.writeUInt32LE(dataSize, 40);
  return file;
}

function seedProject(base) {
  const incoming = path.join(base, 'incoming');
  fs.mkdirSync(incoming, { recursive: true });
  const video = path.join(incoming, 'match.mp4');
  fs.writeFileSync(video, Buffer.alloc(1024, 7));
  const created = createProject(base, { name: 'Semi Final', sourcePath: video });
  const segmentsDir = path.join(getProjectOutputDir(base, created.id), 'audio', 'segments');
  fs.mkdirSync(segmentsDir, { recursive: true });
  fs.writeFileSync(path.join(segmentsDir, 'u-0001.wav'), wavBytes(2));
  fs.writeFileSync(path.join(segmentsDir, 'u-0002.wav'), wavBytes(3));
  return { created, segmentsDir };
}

function makeHarness(base, overrides = {}) {
  const handlers = {};
  const dialogs = [];
  const sent = [];
  const starts = [];
  const harness = {
    handlers,
    dialogs,
    sent,
    starts,
    ipcMain: { handle: (channel, fn) => { handlers[channel] = fn; } },
    app: {
      isPackaged: false,
      getPath: (name) => {
        if (name === 'userData') {
          return base;
        }
        return path.join(base, name);
      },
    },
    dialog: {
      showSaveDialog: async (_window, options) => {
        dialogs.push(options);
        return { canceled: false, filePath: path.join(base, 'exports', 'custom.mov') };
      },
    },
    exportManager: {
      start: async (args) => {
        starts.push(args);
        return { started: true };
      },
      cancel: async () => true,
    },
    sendExportEvent: (message) => sent.push(message),
    getMainWindow: () => null,
    resolveFfmpeg: () => '/bin/ffmpeg',
    fs,
    ...overrides,
  };
  registerExportIpc(harness);
  return harness;
}

function readyRow(overrides = {}) {
  return {
    key: 'u-0001',
    title: 'u-0001',
    timestamp: 3,
    text: 'Line one.',
    state: 'ready',
    error: null,
    scope: 'audio/segments',
    name: 'u-0001.wav',
    ...overrides,
  };
}

test('export-video validates, asks, and starts with a resolved plan', async (t) => {
  const { base, cleanup } = makeUserData();
  t.after(cleanup);
  const { created } = seedProject(base);
  const harness = makeHarness(base);
  const res = await harness.handlers['export-video']({}, created.id, [
    readyRow(),
    readyRow({ key: 'u-0002', title: 'u-0002', timestamp: 10, name: 'u-0002.wav' }),
  ]);
  assert.equal(res.ok, true);
  assert.equal(res.outputPath, path.join(base, 'exports', 'custom.mp4'));
  assert.equal(harness.dialogs.length, 1);
  assert.deepEqual(harness.dialogs[0].filters, [{ name: 'MP4 Video', extensions: ['mp4'] }]);
  assert.ok(harness.dialogs[0].defaultPath.endsWith('Semi Final-commentary.mp4'));
  assert.equal(harness.starts.length, 1);
  const start = harness.starts[0];
  assert.equal(start.executable, '/bin/ffmpeg');
  assert.ok(start.sourcePath.endsWith('gameplay.mp4'));
  const plan = await start.resolvePlan({ duration: 30, hasVideo: true, hasAudio: true });
  assert.equal(plan.hasGameAudio, true);
  assert.deepEqual(
    plan.segments.map((segment) => segment.startMs),
    [3000, 10000],
  );
  assert.equal(plan.wavPaths.length, 2);
  assert.ok(plan.wavPaths[0].endsWith('u-0001.wav'));
});

test('export-video preflight rejects missing inputs before the dialog', async (t) => {
  const { base, cleanup } = makeUserData();
  t.after(cleanup);
  const { created } = seedProject(base);
  const harness = makeHarness(base);

  const missing = await harness.handlers['export-video']({}, 'no-such-id', [readyRow()]);
  assert.deepEqual(missing, { ok: false, error: 'Project not found.' });

  const noRows = await harness.handlers['export-video']({}, created.id, []);
  assert.equal(noRows.ok, false);
  assert.match(noRows.error, /No usable commentary audio/);

  const junkRows = await harness.handlers['export-video']({}, created.id, [
    readyRow({ state: 'failed' }),
    readyRow({ key: 'evil', timestamp: 1, scope: 'audio/segments', name: '../tts.json' }),
    readyRow({ key: 'ghost', timestamp: 2, name: 'absent.wav' }),
    readyRow({ key: 'badtime', timestamp: -5 }),
    'not-an-object',
  ]);
  assert.equal(junkRows.ok, false);
  assert.match(junkRows.error, /No usable commentary audio/);
  assert.equal(harness.dialogs.length, 0, 'no dialog before validation passes');
  assert.equal(harness.starts.length, 0);
});

test('export-video reports missing ffmpeg and source video', async (t) => {
  const { base, cleanup } = makeUserData();
  t.after(cleanup);
  const { created } = seedProject(base);
  const noFfmpeg = makeHarness(base, { resolveFfmpeg: () => null });
  const ffmpegRes = await noFfmpeg.handlers['export-video']({}, created.id, [readyRow()]);
  assert.equal(ffmpegRes.ok, false);
  assert.match(ffmpegRes.error, /FFmpeg is unavailable/);

  fs.rmSync(path.join(base, 'projects', created.id, 'source', 'gameplay.mp4'));
  const harness = makeHarness(base);
  const sourceRes = await harness.handlers['export-video']({}, created.id, [readyRow()]);
  assert.deepEqual(sourceRes, { ok: false, error: 'The source video file is missing.' });
});

test('export-video honors dialog cancellation and busy exports', async (t) => {
  const { base, cleanup } = makeUserData();
  t.after(cleanup);
  const { created } = seedProject(base);
  const cancelled = makeHarness(base, {
    dialog: { showSaveDialog: async () => ({ canceled: true }) },
  });
  assert.deepEqual(
    await cancelled.handlers['export-video']({}, created.id, [readyRow()]),
    { ok: true, canceled: true },
  );
  assert.equal(cancelled.starts.length, 0);

  const busy = makeHarness(base, {
    exportManager: { start: async () => ({ started: false, reason: 'busy' }), cancel: async () => true },
  });
  assert.deepEqual(await busy.handlers['export-video']({}, created.id, [readyRow()]), {
    ok: false,
    error: 'An export is already running.',
  });
});

test('cancel-export forwards to the manager safely', async (t) => {
  const { base, cleanup } = makeUserData();
  t.after(cleanup);
  const harness = makeHarness(base);
  assert.deepEqual(await harness.handlers['cancel-export']({}), { ok: true, stopped: true });
  const failing = makeHarness(base, {
    exportManager: {
      start: async () => ({ started: true }),
      cancel: async () => { throw new Error('boom'); },
    },
  });
  assert.deepEqual(await failing.handlers['cancel-export']({}), {
    ok: false,
    error: 'Could not cancel the export.',
  });
});

test('resolveExportPlan drops overlaps and out-of-range segments', () => {
  const plan = resolveExportPlan(
    [
      { wavPath: '/a/u-0001.wav', timestamp: 3, duration: 4 },
      { wavPath: '/a/u-0002.wav', timestamp: 5, duration: 2 },
      { wavPath: '/a/u-0003.wav', timestamp: 40, duration: 2 },
      { wavPath: '/a/u-0004.wav', timestamp: 10, duration: 2 },
    ],
    { duration: 30 },
  );
  assert.deepEqual(
    plan.wavPaths.map((file) => path.basename(file)),
    ['u-0001.wav', 'u-0004.wav'],
  );
  assert.deepEqual(
    plan.segments.map((segment) => segment.startMs),
    [3000, 10000],
  );
  assert.throws(() => resolveExportPlan([], { duration: 30 }), /within the video duration/);
  assert.throws(
    () => resolveExportPlan([{ wavPath: '/a/x.wav', timestamp: 99, duration: 1 }], { duration: 30 }),
    /within the video duration/,
  );
});
