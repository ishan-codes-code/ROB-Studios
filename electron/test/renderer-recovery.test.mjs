import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANUAL_RETRY_URL, WINDOW_CRASH_MAX_RELOADS, createMainWindow } from '../src/main/window.js';
import { describeChildProcessGone, handleChildProcessGone } from '../src/main/process-events.js';

// Behavioral recovery tests with realistic Electron event mocks:
// crash handling, duplicate suppression, destroy-during-retry,
// single-window guarantee, and diagnostics-only paths.
const here = path.dirname(fileURLToPath(import.meta.url));

function makeRecoveryWorld() {
  const calls = {
    windows: 0,
    loads: [],
    reloads: 0,
    errorPage: null,
    closes: 0,
    destroys: 0,
    events: [],
    scheduled: [],
    handlers: {},
    windowHandlers: {},
  };
  let destroyed = false;
  const window = {
    isDestroyed() { return destroyed; },
    destroy() { destroyed = true; calls.destroys += 1; },
    close() { calls.closes += 1; },
    maximize() {},
    show() {},
    once() {},
    on(event, handler) { calls.windowHandlers[event] = handler; },
    loadURL(url) {
      if (destroyed) throw new Error('Object has been destroyed');
      calls.loads.push(['url', url]);
    },
    loadFile(file) {
      if (destroyed) throw new Error('Object has been destroyed');
      calls.loads.push(['file', file]);
    },
    webContents: {
      on(event, handler) { calls.handlers[event] = handler; },
      loadURL(url) { calls.errorPage = url; },
      reload() {
        if (destroyed) throw new Error('Object has been destroyed');
        calls.reloads += 1;
      },
    },
  };
  class BrowserWindow {
    constructor() {
      calls.windows += 1;
      return window;
    }
  }
  const api = {
    calls,
    BrowserWindow,
    scheduleRetry: (fn, ms) => { calls.scheduled.push({ fn, ms }); },
    onEvent: (event) => { calls.events.push(event); },
    create(extra = {}) {
      return createMainWindow({
        BrowserWindow,
        preloadPath: '/preload.js',
        devServerUrl: 'http://localhost:5173',
        rendererPath: '/index.html',
        platform: 'linux',
        scheduleRetry: api.scheduleRetry,
        onEvent: api.onEvent,
        ...extra,
      });
    },
    crash(details = { reason: 'crashed', exitCode: 1 }) {
      assert.equal(typeof calls.handlers['render-process-gone'], 'function', 'crash handler registered');
      calls.handlers['render-process-gone']({}, details);
    },
    finishLoad() {
      calls.handlers['did-finish-load']?.();
    },
  };
  return { api, window };
}

test('a renderer crash reloads the same window and logs reason and exit code', () => {
  const { api } = makeRecoveryWorld();
  api.create();

  api.crash({ reason: 'oom', exitCode: -536870904 });

  assert.equal(api.calls.windows, 1, 'no second window created');
  assert.equal(api.calls.reloads, 1, 'same window reloaded in place');
  assert.equal(api.calls.errorPage, null);
  assert.deepEqual(api.calls.events, [
    { type: 'render-process-gone', reason: 'oom', exitCode: -536870904, recovered: true, attempt: 1 },
  ]);
});

test('duplicate crash events during one incident recover only once', () => {
  const { api } = makeRecoveryWorld();
  api.create();

  api.crash({ reason: 'crashed', exitCode: 1 });
  api.crash({ reason: 'crashed', exitCode: 1 });
  api.crash({ reason: 'killed', exitCode: 9 });

  assert.equal(api.calls.reloads, 1, 'single reload for the incident');
  assert.equal(api.calls.events.length, 1, 'single diagnostic entry');
});

test('later crashes recover again but a boot-looping renderer lands on an error page', () => {
  const { api } = makeRecoveryWorld();
  api.create();
  assert.equal(WINDOW_CRASH_MAX_RELOADS, 3);

  for (let incident = 1; incident <= WINDOW_CRASH_MAX_RELOADS; incident += 1) {
    api.crash({ reason: 'crashed', exitCode: 1 });
    api.finishLoad();
  }
  assert.equal(api.calls.reloads, WINDOW_CRASH_MAX_RELOADS);
  assert.equal(api.calls.errorPage, null);

  api.crash({ reason: 'crashed', exitCode: 1 });
  assert.equal(api.calls.reloads, WINDOW_CRASH_MAX_RELOADS, 'no reload past the lifetime cap');
  assert.equal(api.calls.windows, 1);
  assert.ok(String(api.calls.errorPage).startsWith('data:text/html'), 'visible crash page');
  assert.match(decodeURIComponent(api.calls.errorPage), /renderer process ended/);
  assert.match(decodeURIComponent(api.calls.errorPage), /crashed/);
  const last = api.calls.events.at(-1);
  assert.equal(last.recovered, false);
  assert.equal(last.reason, 'crashed');
});

test('a destroyed window ignores crash events', () => {
  const { api, window } = makeRecoveryWorld();
  api.create();
  window.destroy();
  const eventCount = api.calls.events.length;

  api.crash({ reason: 'crashed', exitCode: 1 });

  assert.equal(api.calls.reloads, 0);
  assert.equal(api.calls.errorPage, null);
  assert.equal(api.calls.events.length, eventCount, 'no diagnostics for a gone window');
});

test('a window destroyed during a scheduled retry is never loaded into', () => {
  const { api, window } = makeRecoveryWorld();
  api.create();

  api.calls.handlers['did-fail-load']({}, -102, 'ERR_CONNECTION_REFUSED', 'http://localhost:5173/', true);
  assert.equal(api.calls.scheduled.length, 1, 'retry scheduled');
  assert.equal(api.calls.loads.length, 1, 'initial load only');
  window.destroy();
  api.calls.scheduled[0].fn();

  assert.equal(api.calls.loads.length, 1, 'scheduled retry skipped after destroy');
});

test('unresponsive renderers emit diagnostics and are never destroyed', () => {
  const { api } = makeRecoveryWorld();
  const win = api.create();

  assert.equal(typeof api.calls.windowHandlers.unresponsive, 'function');
  assert.equal(typeof api.calls.windowHandlers.responsive, 'function');
  api.calls.windowHandlers.unresponsive();
  api.calls.windowHandlers.unresponsive();
  api.calls.windowHandlers.responsive();

  assert.deepEqual(api.calls.events, [
    { type: 'renderer-unresponsive' },
    { type: 'renderer-unresponsive' },
    { type: 'renderer-responsive' },
  ]);
  assert.equal(api.calls.reloads, 0, 'no automatic reload for a busy renderer');
  assert.equal(api.calls.closes, 0, 'never closed for being busy');
  assert.equal(api.calls.destroys, 0, 'never destroyed for being busy');
  assert.equal(win.isDestroyed(), false);
});

test('malformed crash details never throw and still recover', () => {
  const { api } = makeRecoveryWorld();
  api.create();

  assert.doesNotThrow(() => api.calls.handlers['render-process-gone']({}, undefined));
  assert.equal(api.calls.reloads, 1);
  assert.deepEqual(api.calls.events, [
    { type: 'render-process-gone', reason: 'unknown', exitCode: null, recovered: true, attempt: 1 },
  ]);
});

test('recovery never closes or destroys the window', () => {
  const { api } = makeRecoveryWorld();
  api.create();

  api.crash({ reason: 'killed', exitCode: 9 });
  api.finishLoad();
  api.crash({ reason: 'killed', exitCode: 9 });
  api.finishLoad();
  api.crash({ reason: 'killed', exitCode: 9 });
  api.finishLoad();
  api.crash({ reason: 'killed', exitCode: 9 });

  assert.equal(api.calls.closes, 0);
  assert.equal(api.calls.destroys, 0);
  assert.equal(api.calls.windows, 1);
});

test('child process diagnostics describe GPU termination without acting', () => {
  const event = describeChildProcessGone({ type: 'GPU', reason: 'crashed', exitCode: 512 });
  assert.deepEqual(event, {
    type: 'child-process-gone',
    processType: 'GPU',
    reason: 'crashed',
    exitCode: 512,
  });
  assert.ok(!('action' in event), 'diagnostics carry no recovery action');
});

test('child process diagnostics tolerate malformed input and notify once', () => {
  for (const details of [undefined, null, {}, { type: 42 }]) {
    const seen = [];
    const event = handleChildProcessGone(details, { onEvent: (entry) => seen.push(entry) });
    assert.equal(event.processType, 'unknown', JSON.stringify(details));
    assert.equal(event.reason, 'unknown');
    assert.equal(event.exitCode, null);
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], event);
  }
  assert.doesNotThrow(() => handleChildProcessGone({ type: 'GPU' }));
});

test('explicit manual retry resets budgets and reloads the target', () => {
  const { api } = makeRecoveryWorld();
  api.create();
  for (let incident = 0; incident < WINDOW_CRASH_MAX_RELOADS; incident += 1) {
    api.crash({ reason: 'crashed', exitCode: 133 });
    api.finishLoad();
  }
  api.crash({ reason: 'crashed', exitCode: 133 });
  assert.equal(api.calls.reloads, WINDOW_CRASH_MAX_RELOADS);
  assert.ok(String(api.calls.errorPage).startsWith('data:text/html'));
  assert.match(decodeURIComponent(api.calls.errorPage), /The renderer crashed/);

  let prevented = 0;
  const loadsBefore = api.calls.loads.length;
  api.calls.handlers['will-navigate']({ preventDefault: () => { prevented += 1; } }, MANUAL_RETRY_URL);

  assert.equal(prevented, 1, 'retry navigation intercepted, never leaves the app');
  assert.equal(api.calls.loads.length, loadsBefore + 1, 'real target reloaded');
  assert.deepEqual(api.calls.events.at(-1), { type: 'manual-retry', manualRetries: 1 });

  api.crash({ reason: 'crashed', exitCode: 133 });
  assert.equal(api.calls.reloads, WINDOW_CRASH_MAX_RELOADS + 1, 'fresh budget after explicit retry');
});

test('second exhaustion names the diagnostics log for the operator', () => {
  const { api } = makeRecoveryWorld();
  api.create({ diagnosticsPath: '/home/op/.config/ROB Studio/diagnostics.log' });
  const exhaust = () => {
    for (let incident = 0; incident < WINDOW_CRASH_MAX_RELOADS; incident += 1) {
      api.crash({ reason: 'crashed', exitCode: 133 });
      api.finishLoad();
    }
    api.crash({ reason: 'crashed', exitCode: 133 });
  };
  exhaust();
  assert.match(decodeURIComponent(api.calls.errorPage), /The renderer crashed/);
  assert.doesNotMatch(decodeURIComponent(api.calls.errorPage), /Diagnostics were saved/);

  api.calls.handlers['will-navigate']({ preventDefault: () => {} }, MANUAL_RETRY_URL);
  exhaust();
  const page = decodeURIComponent(api.calls.errorPage);
  assert.match(page, /Automatic recovery was exhausted/);
  assert.match(page, /Diagnostics were saved to/);
  assert.match(page, /diagnostics\.log/);
});

test('ordinary navigations never reset recovery budgets', () => {
  const { api } = makeRecoveryWorld();
  api.create();
  api.crash({ reason: 'crashed', exitCode: 133 });
  api.finishLoad();
  const reloadsBefore = api.calls.reloads;

  api.calls.handlers['will-navigate']({ preventDefault: () => {} }, 'https://example.invalid/');
  api.calls.handlers['will-navigate']({ preventDefault: () => {} }, 'data:text/html,hello');

  assert.equal(api.calls.reloads, reloadsBefore, 'no reload from foreign navigation');
  assert.equal(api.calls.loads.length, 1, 'no target load from foreign navigation');
  assert.ok(api.calls.events.every((entry) => entry.type !== 'manual-retry'));
});

test('manual retry on a destroyed window is a safe no-op', () => {
  const { api, window } = makeRecoveryWorld();
  api.create();
  window.destroy();

  assert.doesNotThrow(() => {
    api.calls.handlers['will-navigate']({ preventDefault: () => {} }, MANUAL_RETRY_URL);
  });
  assert.equal(api.calls.loads.length, 1, 'initial load only');
});

test('recovery operates only through the window surface, never the worker', () => {
  const { api, window } = makeRecoveryWorld();
  api.create();
  // Full incident lifecycle: crashes to exhaustion, manual retry,
  // a load failure, responsiveness noise.
  for (let incident = 0; incident < WINDOW_CRASH_MAX_RELOADS; incident += 1) {
    api.crash({ reason: 'oom', exitCode: 133 });
    api.finishLoad();
  }
  api.crash({ reason: 'oom', exitCode: 133 });
  api.calls.handlers['will-navigate']({ preventDefault: () => {} }, MANUAL_RETRY_URL);
  api.calls.handlers['did-fail-load']({}, -102, 'ERR_ABORTED', 'http://localhost:5173/', true);
  api.calls.windowHandlers.unresponsive();
  api.calls.windowHandlers.responsive();

  // Behavioral confinement: the only side effects recovery can
  // produce are window loads, in-place reloads, the error page, and
  // diagnostics events — createMainWindow receives no worker handle
  // and the factory exposes none.
  assert.equal(api.calls.windows, 1, 'no duplicate windows');
  assert.equal(api.calls.closes, 0, 'never closed');
  assert.equal(api.calls.destroys, 0, 'never destroyed');
  assert.equal(window.isDestroyed(), false);
  assert.ok(api.calls.reloads >= 1, 'recovery reloaded in place');
  for (const entry of api.calls.events) {
    assert.ok(
      ['render-process-gone', 'manual-retry', 'load-failed', 'renderer-unresponsive', 'renderer-responsive'].includes(entry.type),
      `diagnostics-only event ${entry.type}`,
    );
  }
  // Supplemental static guard: recovery modules must not reference
  // worker control surfaces at all.
  for (const relative of ['../src/main/window.js', '../src/main/process-events.js', '../src/main/diagnostics-log.mjs']) {
    const source = fs.readFileSync(path.join(here, relative), 'utf8');
    assert.doesNotMatch(source, /workerManager/, relative);
    assert.doesNotMatch(source, /cancelProcessing/, relative);
    assert.doesNotMatch(source, /request-stop/, relative);
  }
});

test('main process wires diagnostics into window creation and app events', () => {
  const source = fs.readFileSync(path.join(here, '../src/main.js'), 'utf8');
  assert.match(source, /onEvent: logWindowEvent/);
  assert.match(source, /app\.on\('child-process-gone'/);
  assert.match(source, /handleChildProcessGone\(details, \{ onEvent: logWindowEvent \}\)/);
});
