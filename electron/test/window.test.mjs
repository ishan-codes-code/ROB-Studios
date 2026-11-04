import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TITLE_BAR_OVERLAY_HEIGHT, WINDOW_LOAD_MAX_ATTEMPTS, WINDOW_LOAD_RETRY_MS, createMainWindow, loadErrorHtml } from '../src/main/window.js';

function makeWindowFactory({ destroyed = false } = {}) {
  const calls = {
    options: null,
    order: [],
    loaded: null,
    handlers: {},
    fullscreenCalls: 0,
  };
  const window = {
    maximize() { calls.order.push('maximize'); },
    show() { calls.order.push('show'); },
    setFullScreen() { calls.fullscreenCalls += 1; },
    isDestroyed() { return destroyed; },
    once(event, handler) { calls.handlers[event] = handler; },
    loadURL(url) { calls.loaded = ['url', url]; },
    loadFile(file) { calls.loaded = ['file', file]; },
  };
  class BrowserWindow {
    constructor(options) {
      calls.options = options;
      return window;
    }
  }
  return { calls, BrowserWindow };
}

test('window starts hidden at the fallback size with secure webPreferences', () => {
  const { calls, BrowserWindow } = makeWindowFactory();
  const window = createMainWindow({ BrowserWindow, preloadPath: '/preload.js', rendererPath: '/index.html', platform: 'win32' });

  assert.ok(window);
  assert.equal(calls.options.width, 900);
  assert.equal(calls.options.height, 650);
  assert.equal(calls.options.show, false);
  assert.equal(calls.options.webPreferences.preload, '/preload.js');
  assert.equal(calls.options.webPreferences.nodeIntegration, false);
  assert.equal(calls.options.webPreferences.contextIsolation, true);
  assert.deepEqual(calls.order, [], 'nothing is shown or maximized before ready-to-show');
});

test('window paints the Obsidian canvas before first paint', () => {
  const { calls, BrowserWindow } = makeWindowFactory();
  createMainWindow({ BrowserWindow, preloadPath: '/preload.js', rendererPath: '/index.html', platform: 'win32' });

  assert.equal(calls.options.backgroundColor, '#09090a');
});

test('Windows uses the native title bar overlay in Obsidian colors', () => {
  const { calls, BrowserWindow } = makeWindowFactory();
  createMainWindow({ BrowserWindow, preloadPath: '/preload.js', rendererPath: '/index.html', platform: 'win32' });

  assert.equal(calls.options.titleBarStyle, 'hidden');
  assert.deepEqual(calls.options.titleBarOverlay, {
    color: '#101011',
    symbolColor: '#f1f1f1',
    height: TITLE_BAR_OVERLAY_HEIGHT,
  });
  assert.equal(TITLE_BAR_OVERLAY_HEIGHT, 36);
});

test('macOS and Linux keep the native frame without an overlay', () => {
  for (const platform of ['darwin', 'linux']) {
    const { calls, BrowserWindow } = makeWindowFactory();
    createMainWindow({ BrowserWindow, preloadPath: '/preload.js', rendererPath: '/index.html', platform });

    assert.ok(!('titleBarStyle' in calls.options), `${platform} keeps its frame`);
    assert.ok(!('titleBarOverlay' in calls.options), `${platform} has no overlay`);
    assert.equal(calls.options.backgroundColor, '#09090a');
    assert.equal(calls.options.webPreferences.nodeIntegration, false);
    assert.equal(calls.options.webPreferences.contextIsolation, true);
  }
});

test('window requests no fullscreen or kiosk behavior', () => {
  const { calls, BrowserWindow } = makeWindowFactory();
  createMainWindow({ BrowserWindow, preloadPath: '/preload.js', rendererPath: '/index.html', platform: 'win32' });

  assert.ok(!calls.options.fullscreen, 'no exclusive fullscreen option');
  assert.ok(!calls.options.kiosk, 'no kiosk option');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(here, '../src/main/window.js'), 'utf8');
  assert.doesNotMatch(source, /setFullScreen/);
  assert.doesNotMatch(source, /\bkiosk\b/i);
});

test('ready-to-show maximizes before showing', () => {
  const { calls, BrowserWindow } = makeWindowFactory();
  createMainWindow({ BrowserWindow, preloadPath: '/preload.js', rendererPath: '/index.html', platform: 'darwin' });

  assert.equal(typeof calls.handlers['ready-to-show'], 'function');
  calls.handlers['ready-to-show']();
  assert.deepEqual(calls.order, ['maximize', 'show']);
  assert.equal(calls.fullscreenCalls, 0);
});

test('a destroyed window is left alone at ready-to-show', () => {
  const { calls, BrowserWindow } = makeWindowFactory({ destroyed: true });
  createMainWindow({ BrowserWindow, preloadPath: '/preload.js', rendererPath: '/index.html', platform: 'win32' });

  calls.handlers['ready-to-show']();
  assert.deepEqual(calls.order, []);
});

test('preserves the selected renderer loading path', () => {
  const dev = makeWindowFactory();
  createMainWindow({ BrowserWindow: dev.BrowserWindow, preloadPath: '/preload.js', devServerUrl: 'http://localhost:5173', rendererPath: '/index.html', platform: 'win32' });
  assert.deepEqual(dev.calls.loaded, ['url', 'http://localhost:5173']);

  const packaged = makeWindowFactory();
  createMainWindow({ BrowserWindow: packaged.BrowserWindow, preloadPath: '/preload.js', rendererPath: '/index.html', platform: 'linux' });
  assert.deepEqual(packaged.calls.loaded, ['file', '/index.html']);
});

function makeRecoveryFactory() {
  const calls = { loads: [], scheduled: [], handlers: {}, errorPage: null };
  const window = {
    isDestroyed() { return false; },
    once() {},
    loadURL(url) {
      if (String(url).startsWith('data:text/html')) calls.errorPage = url;
      else calls.loads.push(['url', url]);
    },
    loadFile(file) { calls.loads.push(['file', file]); },
    webContents: {
      on(event, handler) { calls.handlers[event] = handler; },
      loadURL(url) { calls.errorPage = url; },
    },
  };
  class BrowserWindow {
    constructor() {
      return window;
    }
  }
  const scheduleRetry = (fn, ms) => {
    calls.scheduled.push(ms);
    fn();
  };
  return { calls, BrowserWindow, scheduleRetry };
}

function failMainFrame(calls, desc = 'ERR_CONNECTION_REFUSED') {
  assert.equal(typeof calls.handlers['did-fail-load'], 'function', 'recovery handler registered');
  calls.handlers['did-fail-load']({}, -102, desc, 'http://localhost:5173/', true);
}

test('a failed main-frame load retries instead of sitting blank', () => {
  const { calls, BrowserWindow, scheduleRetry } = makeRecoveryFactory();
  createMainWindow({
    BrowserWindow, preloadPath: '/preload.js', devServerUrl: 'http://localhost:5173',
    rendererPath: '/index.html', platform: 'win32', scheduleRetry,
  });

  assert.deepEqual(calls.loads, [['url', 'http://localhost:5173']]);
  failMainFrame(calls);
  assert.deepEqual(calls.loads, [['url', 'http://localhost:5173'], ['url', 'http://localhost:5173']]);
  assert.deepEqual(calls.scheduled, [WINDOW_LOAD_RETRY_MS * 2]);
  assert.equal(calls.errorPage, null, 'no error page while retries remain');
});

test('retries stop at the attempt budget and land on an error page', () => {
  const { calls, BrowserWindow, scheduleRetry } = makeRecoveryFactory();
  createMainWindow({
    BrowserWindow, preloadPath: '/preload.js', devServerUrl: 'http://localhost:5173',
    rendererPath: '/index.html', platform: 'linux', scheduleRetry,
  });

  assert.equal(WINDOW_LOAD_MAX_ATTEMPTS, 3);
  for (let attempt = 1; attempt < WINDOW_LOAD_MAX_ATTEMPTS; attempt += 1) {
    failMainFrame(calls);
  }
  assert.equal(calls.loads.length, WINDOW_LOAD_MAX_ATTEMPTS);
  assert.equal(calls.errorPage, null);
  failMainFrame(calls, 'ERR_FILE_NOT_FOUND');
  assert.equal(calls.loads.length, WINDOW_LOAD_MAX_ATTEMPTS, 'no further retries past the budget');
  assert.ok(String(calls.errorPage).startsWith('data:text/html'), 'visible error page instead of blank');
  assert.match(decodeURIComponent(calls.errorPage), /Could not reach the development server/);
  assert.match(decodeURIComponent(calls.errorPage), /ERR_FILE_NOT_FOUND/);
});

test('packaged load failures never blame a development server', () => {
  const { calls, BrowserWindow, scheduleRetry } = makeRecoveryFactory();
  createMainWindow({
    BrowserWindow, preloadPath: '/preload.js', devServerUrl: null,
    rendererPath: '/index.html', platform: 'win32', scheduleRetry,
  });

  for (let attempt = 1; attempt <= WINDOW_LOAD_MAX_ATTEMPTS; attempt += 1) {
    failMainFrame(calls, 'ERR_FILE_NOT_FOUND');
  }
  const page = decodeURIComponent(calls.errorPage);
  assert.match(page, /Could not load ROB Studio/);
  assert.match(page, /Reinstalling usually fixes this/);
  assert.doesNotMatch(page, /development server/);
});

test('subframe failures never disturb the main window', () => {
  const { calls, BrowserWindow, scheduleRetry } = makeRecoveryFactory();
  createMainWindow({
    BrowserWindow, preloadPath: '/preload.js', devServerUrl: 'http://localhost:5173',
    rendererPath: '/index.html', platform: 'darwin', scheduleRetry,
  });

  calls.handlers['did-fail-load']({}, -102, 'ERR_BLOCKED', 'http://localhost:5173/frame', false);
  assert.deepEqual(calls.loads, [['url', 'http://localhost:5173']]);
  assert.deepEqual(calls.scheduled, []);
  assert.equal(calls.errorPage, null);
});

test('load error page escapes untrusted detail', () => {
  const html = loadErrorHtml({ kind: 'dev-load', detail: '<script>alert(1)</script>' });
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
});

test('crash pages name the reason, exit code, and retry action', () => {
  const first = loadErrorHtml({ kind: 'renderer-crash', detail: 'The renderer process ended (crashed, exit code 133).' });
  assert.match(first, /The renderer crashed/);
  assert.match(first, /exit code 133/);
  assert.match(first, /Try again/);
  assert.match(first, /rob-retry:\/\/manual/);
  assert.doesNotMatch(first, /Diagnostics were saved/);

  const exhausted = loadErrorHtml({
    kind: 'crash-exhausted',
    detail: 'The renderer process ended (crashed, exit code 133).',
    diagnosticsPath: '/data/ROB Studio/diagnostics.log',
  });
  assert.match(exhausted, /Automatic recovery was exhausted/);
  assert.match(exhausted, /Diagnostics were saved to/);
  assert.match(exhausted, /\/data\/ROB Studio\/diagnostics\.log/);
  assert.doesNotMatch(exhausted, /development server/);
});

test('diagnostics path is escaped and omitted when unknown', () => {
  const evil = loadErrorHtml({
    kind: 'crash-exhausted',
    detail: 'crashed',
    diagnosticsPath: '</code><script>alert(1)</script>',
  });
  assert.doesNotMatch(evil, /<script>alert/);
  assert.match(evil, /&lt;\/code&gt;/);
  const missing = loadErrorHtml({ kind: 'crash-exhausted', detail: 'crashed' });
  assert.doesNotMatch(missing, /Diagnostics were saved/);
});
