import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DELETION_QUARANTINE_DIR_NAME,
  createProject,
  deleteProject,
  getProject,
  getProjectsRoot,
  isProjectDeletionLocked,
  listProjects,
  sweepDeletionQuarantine,
} from '../src/project-store.mjs';
import { registerProjectIpc } from '../src/main/ipc/projects.js';

let rootCounter = 0;

function makeUserData() {
  rootCounter += 1;
  const base = fs.mkdtempSync(
    path.join(os.tmpdir(), `ai-deletion-${process.pid}-${rootCounter}-`),
  );
  return { base, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

function makeSourceVideo(dir, name = 'match.mp4', bytes = 1024) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.alloc(bytes, 7));
  return file;
}

function seedProject(base, name = 'Doomed') {
  const video = makeSourceVideo(path.join(base, 'incoming'));
  return createProject(base, { name, sourcePath: video });
}

function fsError(code, op) {
  return Object.assign(new Error(`${code}: simulated ${op} failure`), { code });
}

// Real filesystem with scripted transient failures: each entry in
// `failures[op]` throws once (in order) before delegating to node:fs.
function flakyFs(failures = {}) {
  const calls = { renameSync: 0, rmSync: 0 };
  const queues = {
    renameSync: [...(failures.renameSync ?? [])],
    rmSync: [...(failures.rmSync ?? [])],
  };
  return {
    calls,
    fs: {
      ...fs,
      renameSync(...args) {
        calls.renameSync += 1;
        if (queues.renameSync.length > 0) throw fsError(queues.renameSync.shift(), 'renameSync');
        return fs.renameSync(...args);
      },
      rmSync(...args) {
        calls.rmSync += 1;
        if (queues.rmSync.length > 0) throw fsError(queues.rmSync.shift(), 'rmSync');
        return fs.rmSync(...args);
      },
    },
  };
}

// Always-failing removal: models a permanently locked file.
function lockedFs(code = 'EBUSY') {
  return {
    ...fs,
    rmSync() {
      throw fsError(code, 'rmSync');
    },
  };
}

function testHarness({ failures = {}, background = null } = {}) {
  const flaky = flakyFs(failures);
  const delays = [];
  const scheduled = [];
  const logs = [];
  return {
    calls: flaky.calls,
    delays,
    scheduled,
    logs,
    options: {
      fs: flaky.fs,
      sleep: async (ms) => { delays.push(ms); },
      logger: {
        error: (message) => logs.push(['error', String(message)]),
        info: (message) => logs.push(['info', String(message)]),
      },
      scheduleBackground: background ?? ((task, ms) => { scheduled.push({ task, ms }); }),
    },
  };
}

function quarantineEntries(base) {
  const root = path.join(getProjectsRoot(base), DELETION_QUARANTINE_DIR_NAME);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root);
}

test('successful deletion removes the tree with no quarantine residue', async (t) => {
  const { base, cleanup } = makeUserData();
  t.after(cleanup);
  const keep = seedProject(base, 'Keep');
  const drop = seedProject(base, 'Drop');
  const harness = testHarness();

  const result = await deleteProject(base, drop.id, harness.options);

  assert.deepEqual(result, { deleted: true, id: drop.id, cleanup: 'complete' });
  assert.ok(!fs.existsSync(path.join(getProjectsRoot(base), drop.id)));
  assert.deepEqual(quarantineEntries(base), []);
  assert.equal(getProject(base, keep.id).name, 'Keep');
  assert.deepEqual(listProjects(base).map((p) => p.id), [keep.id]);
  assert.equal(isProjectDeletionLocked(drop.id), false);
});

test('EBUSY during quarantine rename retries and then succeeds', async (t) => {
  const { base, cleanup } = makeUserData();
  t.after(cleanup);
  const drop = seedProject(base);
  const harness = testHarness({ failures: { renameSync: ['EBUSY'] } });

  const result = await deleteProject(base, drop.id, harness.options);

  assert.deepEqual(result, { deleted: true, id: drop.id, cleanup: 'complete' });
  assert.equal(harness.calls.renameSync, 2);
  assert.deepEqual(harness.delays.slice(0, 1), [50]);
  assert.deepEqual(quarantineEntries(base), []);
});

test('transient removal failures use exponential backoff, then succeed', async (t) => {
  const { base, cleanup } = makeUserData();
  t.after(cleanup);
  const drop = seedProject(base);
  const harness = testHarness({ failures: { rmSync: ['EBUSY', 'EPERM', 'ENOTEMPTY'] } });

  const result = await deleteProject(base, drop.id, harness.options);

  assert.deepEqual(result, { deleted: true, id: drop.id, cleanup: 'complete' });
  assert.equal(harness.calls.rmSync, 4);
  assert.deepEqual(harness.delays, [50, 100, 200]);
  assert.deepEqual(quarantineEntries(base), []);
});

test('permanent lock keeps the project intact with an actionable error', async (t) => {
  const { base, cleanup } = makeUserData();
  t.after(cleanup);
  const drop = seedProject(base);
  const harness = testHarness({ failures: { renameSync: ['EBUSY', 'EBUSY', 'EBUSY', 'EBUSY', 'EBUSY', 'EBUSY', 'EBUSY'] } });

  await assert.rejects(deleteProject(base, drop.id, harness.options), /still in use/);
  // Six bounded attempts, then the project is untouched: no partial delete.
  assert.equal(harness.calls.renameSync, 6);
  assert.deepEqual(harness.delays, [50, 100, 200, 400, 800]);
  const dir = path.join(getProjectsRoot(base), drop.id);
  assert.ok(fs.existsSync(path.join(dir, 'project.json')));
  assert.ok(fs.existsSync(path.join(dir, 'source', 'gameplay.mp4')));
  assert.deepEqual(listProjects(base).map((p) => p.id), [drop.id]);
  assert.equal(isProjectDeletionLocked(drop.id), false);
  // A later retry with the lock released succeeds.
  const retry = await deleteProject(base, drop.id, testHarness().options);
  assert.deepEqual(retry, { deleted: true, id: drop.id, cleanup: 'complete' });
});

test('non-retryable errors fail fast without retries', async (t) => {
  const { base, cleanup } = makeUserData();
  t.after(cleanup);
  const drop = seedProject(base);
  const harness = testHarness({ failures: { renameSync: ['EIO'] } });

  await assert.rejects(deleteProject(base, drop.id, harness.options), /still in use/);
  assert.equal(harness.calls.renameSync, 1);
  assert.deepEqual(harness.delays, []);
  assert.deepEqual(listProjects(base).map((p) => p.id), [drop.id]);
});

test('cleanup failure after quarantine reports logical success with a tombstone', async (t) => {
  const { base, cleanup } = makeUserData();
  t.after(cleanup);
  const drop = seedProject(base);
  const harness = testHarness();
  harness.options.fs = lockedFs('EBUSY');

  const result = await deleteProject(base, drop.id, harness.options);

  assert.deepEqual(result, { deleted: true, id: drop.id, cleanup: 'pending' });
  // Logically gone from the library, physically retained as one tombstone.
  assert.deepEqual(listProjects(base).map((p) => p.id), []);
  assert.ok(!fs.existsSync(path.join(getProjectsRoot(base), drop.id)));
  const entries = quarantineEntries(base);
  assert.equal(entries.length, 1);
  const tomb = JSON.parse(fs.readFileSync(
    path.join(getProjectsRoot(base), DELETION_QUARANTINE_DIR_NAME, entries[0], 'tombstone.json'),
    'utf8',
  ));
  assert.equal(tomb.id, drop.id);
  assert.equal(tomb.lastCode, 'EBUSY');
  assert.ok(typeof tomb.lastError === 'string' && tomb.lastError.length > 0);
  assert.equal(harness.scheduled.length, 1);
  assert.equal(isProjectDeletionLocked(drop.id), false);
});

test('retry after quarantine never reports Project not found', async (t) => {
  const { base, cleanup } = makeUserData();
  t.after(cleanup);
  const drop = seedProject(base);
  const harness = testHarness();
  harness.options.fs = lockedFs('EPERM');
  const first = await deleteProject(base, drop.id, harness.options);
  assert.equal(first.cleanup, 'pending');

  const second = await deleteProject(base, drop.id, harness.options);

  assert.deepEqual(second, { deleted: true, id: drop.id, alreadyDeleted: true, cleanup: 'pending' });
  assert.equal(harness.scheduled.length, 2);
});

test('background cleanup finishes once the lock is released', async (t) => {
  const { base, cleanup } = makeUserData();
  t.after(cleanup);
  const drop = seedProject(base);
  let locked = true;
  const harness = testHarness();
  harness.options.fs = {
    ...fs,
    rmSync(...args) {
      if (locked) throw fsError('EBUSY', 'rmSync');
      return fs.rmSync(...args);
    },
  };
  const tasks = [];
  harness.options.scheduleBackground = (task, ms) => { tasks.push({ task, ms }); };

  const result = await deleteProject(base, drop.id, harness.options);
  assert.equal(result.cleanup, 'pending');
  assert.equal(tasks.length, 1);

  locked = false;
  await tasks[0].task();

  assert.deepEqual(quarantineEntries(base), []);
  assert.ok(harness.logs.some(([level, message]) => level === 'info' && message.includes(drop.id)));
});

test('duplicate concurrent deletions are rejected while one is in flight', async (t) => {
  const { base, cleanup } = makeUserData();
  t.after(cleanup);
  const drop = seedProject(base);
  const harness = testHarness({ failures: { renameSync: ['EBUSY'] } });
  let releaseSleep;
  const gate = new Promise((resolve) => { releaseSleep = resolve; });
  harness.options.sleep = async (ms) => {
    harness.delays.push(ms);
    await gate;
  };

  const first = deleteProject(base, drop.id, harness.options);
  // Let the first deletion reach its backoff sleep (lock held).
  for (let i = 0; i < 50 && harness.delays.length === 0; i += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
  assert.ok(isProjectDeletionLocked(drop.id));
  await assert.rejects(deleteProject(base, drop.id, harness.options), /already in progress/);
  releaseSleep();
  const result = await first;
  assert.deepEqual(result, { deleted: true, id: drop.id, cleanup: 'complete' });
});

test('startup sweep removes abandoned tombstones and keeps failures', async (t) => {
  const { base, cleanup } = makeUserData();
  t.after(cleanup);
  const swept = seedProject(base, 'Swept');
  const stuck = seedProject(base, 'Stuck');
  // Quarantine both by hand: one healthy tombstone, one bare directory
  // (crash between rename and tombstone write), plus junk files.
  const projectsRoot = getProjectsRoot(base);
  const quarantineRoot = path.join(projectsRoot, DELETION_QUARANTINE_DIR_NAME);
  fs.mkdirSync(quarantineRoot, { recursive: true });
  const sweptTomb = path.join(quarantineRoot, `${swept.id}.1.aaa`);
  const stuckTomb = path.join(quarantineRoot, `${stuck.id}.1.bbb`);
  fs.renameSync(path.join(projectsRoot, swept.id), sweptTomb);
  fs.renameSync(path.join(projectsRoot, stuck.id), stuckTomb);
  fs.writeFileSync(
    path.join(sweptTomb, 'tombstone.json'),
    JSON.stringify({ id: swept.id, deletedAt: new Date(0).toISOString(), attempts: 6, lastError: 'EBUSY', lastCode: 'EBUSY' }),
  );
  // Partial content (crashed mid-cleanup) still sweeps by directory.
  fs.rmSync(path.join(sweptTomb, 'output'), { recursive: true, force: true });
  fs.writeFileSync(path.join(quarantineRoot, 'stray.txt'), 'ignored');

  const harness = testHarness();
  const failing = harness.options.fs;
  harness.options.fs = {
    ...failing,
    rmSync(target, options) {
      if (String(target) === stuckTomb) throw fsError('EBUSY', 'rmSync');
      return failing.rmSync(target, options);
    },
  };

  const result = await sweepDeletionQuarantine(base, harness.options);

  assert.deepEqual(result.swept, [swept.id]);
  assert.deepEqual(result.pending, [stuck.id]);
  assert.ok(!fs.existsSync(sweptTomb));
  assert.ok(fs.existsSync(stuckTomb));
  const stuckRecord = JSON.parse(fs.readFileSync(path.join(stuckTomb, 'tombstone.json'), 'utf8'));
  assert.equal(stuckRecord.id, stuck.id);
  assert.equal(stuckRecord.lastCode, 'EBUSY');
  assert.ok(stuckRecord.attempts >= 6);
  // Neither the tombstone project.json copies nor the quarantine root
  // itself ever appear in the library.
  assert.deepEqual(listProjects(base).map((p) => p.id), []);
});

test('sweep with no quarantine directory succeeds quietly', async (t) => {
  const { base, cleanup } = makeUserData();
  t.after(cleanup);
  const harness = testHarness();
  assert.deepEqual(await sweepDeletionQuarantine(base, harness.options), { swept: [], pending: [] });
});

test('deleting a nonexistent project reports not found', async (t) => {
  const { base, cleanup } = makeUserData();
  t.after(cleanup);
  await assert.rejects(deleteProject(base, 'no-such-project', testHarness().options), /not found/i);
});

function projectIpcHarness(base, { workerBusy = false, exportBusy = false, exportProjectId = null } = {}) {
  const handlers = {};
  registerProjectIpc({
    ipcMain: { handle: (channel, fn) => { handlers[channel] = fn; } },
    app: { getPath: (name) => (name === 'userData' ? base : path.join(base, name)) },
    workerManager: { isBusy: () => workerBusy },
    exportManager: { isBusy: () => exportBusy, activeProjectId: () => exportProjectId },
  });
  return handlers;
}

test('IPC delete-project keeps its response contract', async (t) => {
  const { base, cleanup } = makeUserData();
  t.after(cleanup);
  const drop = seedProject(base);
  const handlers = projectIpcHarness(base);

  const result = await handlers['delete-project']({}, drop.id);

  assert.deepEqual(result, { ok: true, deleted: true, id: drop.id, cleanup: 'complete' });
  assert.deepEqual(listProjects(base).map((p) => p.id), []);
});

test('IPC delete-project refuses while processing or exporting', async (t) => {
  const { base, cleanup } = makeUserData();
  t.after(cleanup);
  const drop = seedProject(base);
  const other = seedProject(base, 'Other');

  const busyWorker = projectIpcHarness(base, { workerBusy: true });
  assert.deepEqual(await busyWorker['delete-project']({}, drop.id), {
    ok: false, error: 'Stop the active processing job first.',
  });

  const busyExport = projectIpcHarness(base, { exportBusy: true, exportProjectId: drop.id });
  assert.deepEqual(await busyExport['delete-project']({}, drop.id), {
    ok: false, error: 'An export is running for this project. Cancel it before deleting.',
  });

  // An export of another project does not block this deletion.
  const otherExport = projectIpcHarness(base, { exportBusy: true, exportProjectId: other.id });
  const allowed = await otherExport['delete-project']({}, drop.id);
  assert.equal(allowed.ok, true);
  assert.deepEqual(listProjects(base).map((p) => p.id), [other.id]);

  // An untagged export blocks conservatively.
  const unknownExport = projectIpcHarness(base, { exportBusy: true, exportProjectId: null });
  assert.deepEqual(await unknownExport['delete-project']({}, other.id), {
    ok: false, error: 'An export is running for this project. Cancel it before deleting.',
  });
});

test('IPC delete-project surfaces store failures without success flags', async (t) => {
  const { base, cleanup } = makeUserData();
  t.after(cleanup);
  const handlers = projectIpcHarness(base);
  assert.deepEqual(await handlers['delete-project']({}, 'no-such-project'), {
    ok: false, error: 'Project not found.',
  });
});

test('IPC open and update refuse a project being deleted', async (t) => {
  const { base, cleanup } = makeUserData();
  t.after(cleanup);
  const drop = seedProject(base);
  const handlers = projectIpcHarness(base);
  const harness = testHarness({ failures: { renameSync: ['EBUSY'] } });
  let releaseSleep;
  const gate = new Promise((resolve) => { releaseSleep = resolve; });
  harness.options.sleep = async () => { await gate; };

  const deletion = deleteProject(base, drop.id, harness.options);
  for (let i = 0; i < 50 && !isProjectDeletionLocked(drop.id); i += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
  assert.deepEqual(await handlers['open-project']({}, drop.id), {
    ok: false, error: 'Project is being deleted.',
  });
  assert.deepEqual(await handlers['update-project']({}, drop.id, { processingStatus: 'done' }), {
    ok: false, error: 'Project is being deleted.',
  });
  releaseSleep();
  await deletion;
});
