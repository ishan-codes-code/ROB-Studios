import test from 'node:test';
import assert from 'node:assert/strict';
import {
  presetsForProfile,
  isRunReady,
  credentialLabel,
  presetLabel,
} from '../src/lib/config-display.js';

const presets = [
  { id: 'default-energetic', profileId: 'free-fire-default', name: 'Default', tone: 'energetic', language: 'English' },
  { id: 'p1', profileId: 'custom', name: 'Caster', tone: 'hype', language: 'English' },
  { id: 'p2', profileId: 'other', name: 'Calm', tone: '', language: '' },
];

test('presets filter to the profile plus the built-in default', () => {
  assert.deepEqual(
    presetsForProfile(presets, 'custom').map((entry) => entry.id),
    ['default-energetic', 'p1'],
  );
  assert.deepEqual(
    presetsForProfile(presets, 'free-fire-default').map((entry) => entry.id),
    ['default-energetic'],
  );
  assert.deepEqual(presetsForProfile(null, 'custom'), []);
});

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
  assert.equal(presetLabel(presets[0]), 'Default · energetic · English');
  assert.equal(presetLabel(presets[2]), 'Calm');
});
