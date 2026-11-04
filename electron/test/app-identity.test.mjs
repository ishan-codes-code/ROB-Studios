import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  PRODUCT_NAME,
  WINDOWS_APP_USER_MODEL_ID,
  resolveUserDataPath,
} from '../src/main/app-identity.mjs';

test('new installs use the branded user-data directory', () => {
  const appData = path.join(path.sep, 'users', 'test user', 'appdata');
  assert.equal(PRODUCT_NAME, 'ROB Studios');
  assert.equal(
    resolveUserDataPath(appData, () => false),
    path.join(appData, 'ROB Studios'),
  );
});

test('existing ROB Studio data remains the persistent user-data directory', () => {
  const appData = path.join(path.sep, 'users', 'test user', 'appdata');
  const legacy = path.join(appData, 'ROB Studio');
  assert.equal(resolveUserDataPath(appData, (candidate) => candidate === legacy), legacy);
});

test('Windows taskbar identity remains stable', () => {
  assert.equal(WINDOWS_APP_USER_MODEL_ID, 'com.robstudios.app');
});