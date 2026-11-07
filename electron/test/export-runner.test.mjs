import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createExportManager } from '../src/export-runner.mjs';

const PROBE_STDERR = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'src.mp4':
  Duration: 00:00:06.00, start: 0.000000, bitrate: 369 kb/s
  Stream #0:0[0x1](und): Video: h264 (High), yuv420p, 320x240, 30 fps
  Stream #0:1[0x2](und): Audio: aac (LC), 44100 Hz, mono, fltp
At least one output file must be specified
`;

const tick = () => new Promise((resolve) => setImmediate(resolve));

function makeFakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killCalls = [];
  child.kill = (signal) => {
    child.killCalls.push(signal ?? null);
  };
  return child;
}

function makeSpawn() {
  const calls = [];
  const children = [];
  const spawnFn = (executable, argv) => {
    calls.push({ executable, argv });
    const child = makeFakeChild();
    children.push(child);
    return child;
  };
  return { calls, children, spawnFn };
}

function tempOutput(t) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-export-')), 'out.mp4');
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  return file;
}

const PLAN = {
  wavPaths: ['/audio/u-0001.wav'],
  segments: [{ startMs: 3000 }],
  hasGameAudio: true,
};

async function startThroughProbe(t, manager, spawn, outputPath, overrides = {}) {
  const events = [];
  const startedPromise = manager.start({
    executable: '/bin/ffmpeg',
    sourcePath: '/video/src.mp4',
    outputPath,
    resolvePlan: async () => PLAN,
    onEvent: (event) => events.push(event),
    ...overrides,
  });
  await tick();
  assert.equal(spawn.calls.length, 1);
  assert.deepEqual(spawn.calls[0].argv, ['-hide_banner', '-i', '/video/src.mp4']);
  spawn.children[0].stderr.emit('data', PROBE_STDERR);
  spawn.children[0].emit('close', 1);
  const started = await startedPromise;
  return { started, events };
}

test('successful export streams progress then reports done', async (t) => {
  const spawn = makeSpawn();
  const manager = createExportManager({ spawnFn: spawn.spawnFn });
  const outputPath = tempOutput(t);
  fs.writeFileSync(outputPath, Buffer.alloc(16));
  const { started, events } = await startThroughProbe(t, manager, spawn, outputPath);
  assert.equal(started.started, true);
  assert.equal(spawn.calls.length, 2);
  const encodeArgv = spawn.calls[1].argv;
  assert.ok(encodeArgv.includes('-filter_complex'));
  assert.equal(encodeArgv[encodeArgv.length - 1], outputPath);

  const encode = spawn.children[1];
  encode.stdout.emit('data', 'out_time_ms=3000000\nprogress=continue\n');
  await tick();
  encode.stdout.emit('data', 'out_time_ms=99999999\nprogress=end\n');
  await tick();
  encode.emit('close', 0);
  await tick();

  const progress = events.filter((event) => event.phase === 'progress');
  assert.equal(progress.length, 2);
  assert.deepEqual(progress[0], { phase: 'progress', completedUs: 3000000, totalUs: 6000000 });
  assert.deepEqual(progress[1], { phase: 'progress', completedUs: 6000000, totalUs: 6000000 });
  assert.deepEqual(events[events.length - 1], { phase: 'done', outputPath });
  assert.equal(manager.isBusy(), false);
  assert.ok(fs.existsSync(outputPath), 'successful output survives');
});

test('probe failure aborts without spawning the encode', async (t) => {
  const spawn = makeSpawn();
  const manager = createExportManager({ spawnFn: spawn.spawnFn });
  const outputPath = tempOutput(t);
  const events = [];
  const startedPromise = manager.start({
    executable: '/bin/ffmpeg',
    sourcePath: '/video/src.mp4',
    outputPath,
    resolvePlan: async () => PLAN,
    onEvent: (event) => events.push(event),
  });
  await tick();
  spawn.children[0].stderr.emit('data', 'garbage: no header here\n');
  spawn.children[0].emit('close', 1);
  const started = await startedPromise;
  assert.deepEqual(started.reason, 'probe-failed');
  assert.equal(started.started, false);
  assert.equal(spawn.calls.length, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].phase, 'error');
  assert.match(events[0].error, /no video track/);
  assert.equal(manager.isBusy(), false);
});

test('plan failures surface the planner message', async (t) => {
  const spawn = makeSpawn();
  const manager = createExportManager({ spawnFn: spawn.spawnFn });
  const outputPath = tempOutput(t);
  const { started, events } = await startThroughProbe(t, manager, spawn, outputPath, {
    resolvePlan: async () => {
      throw new Error('No usable commentary audio.');
    },
  });
  assert.equal(started.started, false);
  assert.equal(started.reason, 'plan-failed');
  assert.equal(spawn.calls.length, 1);
  assert.deepEqual(events, [{ phase: 'error', error: 'No usable commentary audio.' }]);
});

test('encode failure deletes the partial output', async (t) => {
  const spawn = makeSpawn();
  const manager = createExportManager({ spawnFn: spawn.spawnFn });
  const outputPath = tempOutput(t);
  fs.writeFileSync(outputPath, Buffer.alloc(16));
  const events = [];
  const startedPromise = manager.start({
    executable: '/bin/ffmpeg',
    sourcePath: '/video/src.mp4',
    outputPath,
    resolvePlan: async () => PLAN,
    onEvent: (event) => events.push(event),
  });
  await tick();
  spawn.children[0].stderr.emit('data', PROBE_STDERR);
  spawn.children[0].emit('close', 1);
  await startedPromise;
  const encode = spawn.children[1];
  encode.stderr.emit('data', '[mp4 @ 0x1] Application provided invalid data\n');
  encode.emit('close', 1);
  await tick();
  assert.equal(events.length, 1);
  assert.equal(events[0].phase, 'error');
  assert.match(events[0].error, /Export failed/);
  assert.match(events[0].error, /invalid data/);
  assert.ok(!fs.existsSync(outputPath), 'partial output removed');
  assert.equal(manager.isBusy(), false);
});

test('cancel terminates the encode and cleans up', async (t) => {
  const spawn = makeSpawn();
  const manager = createExportManager({ spawnFn: spawn.spawnFn });
  const outputPath = tempOutput(t);
  fs.writeFileSync(outputPath, Buffer.alloc(16));
  const events = [];
  const startedPromise = manager.start({
    executable: '/bin/ffmpeg',
    sourcePath: '/video/src.mp4',
    outputPath,
    resolvePlan: async () => PLAN,
    onEvent: (event) => events.push(event),
  });
  await tick();
  spawn.children[0].stderr.emit('data', PROBE_STDERR);
  spawn.children[0].emit('close', 1);
  await startedPromise;
  const encode = spawn.children[1];
  const cancelled = manager.cancel({ killGraceMs: 50 });
  encode.emit('close', null);
  assert.equal(await cancelled, true);
  await tick();
  assert.deepEqual(encode.killCalls[0], 'SIGTERM');
  assert.deepEqual(events, [{ phase: 'cancelled' }]);
  assert.ok(!fs.existsSync(outputPath), 'partial output removed');
  assert.equal(manager.isBusy(), false);
});

test('cancel with no job resolves false and busy start is refused', async (t) => {
  const spawn = makeSpawn();
  const manager = createExportManager({ spawnFn: spawn.spawnFn });
  assert.equal(await manager.cancel(), false);
  const outputPath = tempOutput(t);
  const startedPromise = manager.start({
    executable: '/bin/ffmpeg',
    sourcePath: '/video/src.mp4',
    outputPath,
    resolvePlan: async () => PLAN,
    onEvent: () => {},
  });
  const second = await manager.start({
    executable: '/bin/ffmpeg',
    sourcePath: '/video/other.mp4',
    outputPath,
    resolvePlan: async () => PLAN,
    onEvent: () => {},
  });
  assert.deepEqual(second, { started: false, reason: 'busy' });
  await tick();
  spawn.children[0].stderr.emit('data', PROBE_STDERR);
  spawn.children[0].emit('close', 1);
  await startedPromise;
  const cancelPromise = manager.cancel({ killGraceMs: 20 });
  spawn.children[1].emit('close', null);
  await cancelPromise;
});

test('the active export reports its project id for the deletion guard', async (t) => {
  const spawn = makeSpawn();
  const manager = createExportManager({ spawnFn: spawn.spawnFn });
  assert.equal(manager.activeProjectId(), null);
  const outputPath = tempOutput(t);
  fs.writeFileSync(outputPath, Buffer.alloc(16));
  const { started } = await startThroughProbe(t, manager, spawn, outputPath, { projectId: 'proj-1' });
  assert.equal(started.started, true);
  assert.equal(manager.isBusy(), true);
  assert.equal(manager.activeProjectId(), 'proj-1');
  spawn.children[1].emit('close', 0);
  await tick();
  assert.equal(manager.isBusy(), false);
  assert.equal(manager.activeProjectId(), null);
});

test('spawn throw reports a spawn failure and frees the manager', async () => {
  const manager = createExportManager({
    spawnFn: () => {
      throw new Error('ENOENT');
    },
  });
  const events = [];
  const started = await manager.start({
    executable: '/bin/ffmpeg',
    sourcePath: '/video/src.mp4',
    outputPath: '/tmp/out.mp4',
    resolvePlan: async () => PLAN,
    onEvent: (event) => events.push(event),
  });
  assert.equal(started.started, false);
  assert.equal(started.reason, 'spawn-failed');
  assert.equal(events[0].phase, 'error');
  assert.equal(manager.isBusy(), false);
});
