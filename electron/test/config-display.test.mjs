import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isRunReady,
  credentialLabel,
} from '../src/lib/config-display.js';

test('run readiness requires a verified credential and no warnings', () => {
  assert.equal(isRunReady({ credential: { verified: true }, warnings: [] }), true);
  assert.equal(isRunReady({ credential: { verified: false }, warnings: [] }), false);
  assert.equal(isRunReady({ credential: { verified: true }, warnings: ['stale'] }), false);
  assert.equal(isRunReady({ credential: null, warnings: [] }), false);
  assert.equal(isRunReady(null), false);
});

test('labels never expose key material', () => {
  const credential = {
    name: 'Meta', model: 'muse-spark-1.3', verification: { status: 'verified' }, apiKey: 'shh',
  };
  assert.equal(credentialLabel(credential), 'Meta · muse-spark-1.3 · verified');
  assert.equal(credentialLabel(null), 'No configuration');
});
