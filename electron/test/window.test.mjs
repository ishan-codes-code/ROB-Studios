import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TITLE_BAR_OVERLAY_HEIGHT, createMainWindow } from '../src/main/window.js';

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
