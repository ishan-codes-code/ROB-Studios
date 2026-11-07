import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createMainWindow } from '../src/main/window.js';

// ROB application icon integration: the supplied waveform assets ship
// as the executable, installer, and window icons on every platform.
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const forgeConfig = require('../forge.config.js');

const ICONS_DIR = path.join(here, '../src/assets/icons');

function makeWindowFactory() {
  const calls = { options: null, handlers: {} };
  const window = {
    maximize() {},
    show() {},
    isDestroyed() { return false; },
    once(event, handler) { calls.handlers[event] = handler; },
    loadURL() {},
    loadFile() {},
  };
  class BrowserWindow {
    constructor(options) {
      calls.options = options;
      return window;
    }
  }
  return { calls, BrowserWindow };
}

test('icon assets exist at the canonical paths', () => {
  for (const file of ['icon.png', 'icon.ico', 'icon.icns', 'icon.svg']) {
    const full = path.join(ICONS_DIR, file);
    assert.ok(fs.existsSync(full), `${file} exists`);
    assert.ok(fs.statSync(full).size > 0, `${file} is non-empty`);
  }
});

test('old svgviewer-output filenames are gone', () => {
  const entries = fs.readdirSync(ICONS_DIR);
  assert.ok(!entries.some((name) => name.startsWith('svgviewer-output')));
  for (const config of ['../forge.config.js', '../src/main/window.js', '../src/main.js', '../package.json']) {
    const source = fs.readFileSync(path.join(here, config), 'utf8');
    assert.doesNotMatch(source, /svgviewer-output/, config);
  }
});

test('Forge packager references the platform icon base', () => {
  const { icon } = forgeConfig.packagerConfig;
  assert.equal(typeof icon, 'string');
  assert.ok(path.isAbsolute(icon), 'icon path is absolute (config-relative, not cwd-relative)');
  assert.ok(icon.endsWith(path.join('src', 'assets', 'icons', 'icon')), 'icon base points at the assets dir');
  // The packager resolves per-platform extensions from the base.
  assert.ok(fs.existsSync(`${icon}.ico`), 'Windows icon exists');
  assert.ok(fs.existsSync(`${icon}.icns`), 'macOS icon exists');
  assert.ok(fs.existsSync(`${icon}.png`), 'Linux icon exists');
});

test('Forge makers brand installers with the supplied icons', () => {
  const byName = Object.fromEntries(forgeConfig.makers.map((maker) => [maker.name, maker.config ?? {}]));
  const squirrelIcon = byName['@electron-forge/maker-squirrel'].setupIcon;
  assert.ok(squirrelIcon.endsWith('icon.ico'), 'squirrel setup uses icon.ico');
  assert.ok(fs.existsSync(squirrelIcon));
  for (const maker of ['@electron-forge/maker-deb', '@electron-forge/maker-rpm']) {
    const linuxIcon = byName[maker].options?.icon;
    assert.ok(linuxIcon.endsWith('icon.png'), `${maker} uses icon.png`);
    assert.ok(fs.existsSync(linuxIcon));
  }
});

test('packaged window icon ships as an extra resource', () => {
  const resources = forgeConfig.packagerConfig.extraResource;
  assert.ok(resources.some((entry) => entry.endsWith('src/assets/icons/icon.png')));
});

test('window uses the icon path where supported', () => {
  const { calls, BrowserWindow } = makeWindowFactory();
  createMainWindow({
    BrowserWindow,
    preloadPath: '/preload.js',
    rendererPath: '/index.html',
    iconPath: '/icons/icon.png',
    platform: 'linux',
  });
  assert.equal(calls.options.icon, '/icons/icon.png');
});

test('window omits the icon key when no icon resolved', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const { calls, BrowserWindow } = makeWindowFactory();
    createMainWindow({ BrowserWindow, preloadPath: '/preload.js', rendererPath: '/index.html', platform });
    assert.ok(!('icon' in calls.options), `${platform} stays icon-free without a path`);
  }
});

test('window icon never disturbs the Windows title-bar overlay', () => {
  const { calls, BrowserWindow } = makeWindowFactory();
  createMainWindow({
    BrowserWindow,
    preloadPath: '/preload.js',
    rendererPath: '/index.html',
    iconPath: '/icons/icon.png',
    platform: 'win32',
  });
  assert.equal(calls.options.icon, '/icons/icon.png');
  assert.equal(calls.options.titleBarStyle, 'hidden');
  assert.deepEqual(calls.options.titleBarOverlay, {
    color: '#101011',
    symbolColor: '#f1f1f1',
    height: 36,
  });
  assert.equal(calls.options.width, 900);
  assert.equal(calls.options.height, 650);
});

test('main process resolves dev and packaged icon locations', () => {
  const source = fs.readFileSync(path.join(here, '../src/main.js'), 'utf8');
  assert.match(source, /process\.resourcesPath, 'icon\.png'/, 'packaged build reads extraResource');
  assert.match(source, /src', 'assets', 'icons', 'icon\.png'/, 'dev build reads the source tree');
  assert.match(source, /iconPath: windowIconPath\(\)/, 'resolved path reaches window creation');
});
