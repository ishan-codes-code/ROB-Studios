import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  VOICE_CONFIG_VERSION,
  createVoiceConfig,
  deleteVoiceConfig,
  getVoiceConfig,
  listVoiceConfigs,
  updateVoiceConfig,
  voiceConfigLibraryPath,
} from '../src/voice-config-store.mjs';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-voice-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const TRIPLE = {
  model: 'gemini-3.8-flash-tts',
  voice: 'Kore',
  voiceDirection: 'Energetic esports commentator.',
};

test('an empty library lists nothing and writes on first create', async (t) => {
  const dir = tempDir(t);
  assert.deepEqual(listVoiceConfigs(dir), []);
  assert.equal(fs.existsSync(voiceConfigLibraryPath(dir)), false);
  const created = createVoiceConfig(dir, { name: 'Ranked grind', ...TRIPLE });
  assert.match(created.id, /^voice-[0-9a-f]{12}$/);
  assert.equal(created.providerId, 'google-gemini-tts');
  assert.equal(created.credentialId, null);
  assert.equal(listVoiceConfigs(dir).length, 1);
  const stored = JSON.parse(fs.readFileSync(voiceConfigLibraryPath(dir), 'utf8'));
  assert.equal(stored.version, VOICE_CONFIG_VERSION);
  assert.equal(stored.configs.length, 1);
  // No temp files survive the atomic write.
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);
});

test('entries round-trip with trims, credential refs, and timestamps', async (t) => {
  const dir = tempDir(t);
  const created = createVoiceConfig(dir, {
    name: '  Chill cast  ',
    credentialId: 'cred-abc123',
    model: TRIPLE.model,
    voice: '  Fenrir  ',
    voiceDirection: '  Calm analyst.  ',
  });
  assert.equal(created.name, 'Chill cast');
  assert.equal(created.voice, 'Fenrir');
  assert.equal(created.voiceDirection, 'Calm analyst.');
  assert.equal(created.credentialId, 'cred-abc123');
  assert.ok(!Number.isNaN(Date.parse(created.createdAt)));
  assert.ok(!Number.isNaN(Date.parse(created.updatedAt)));
  const fetched = getVoiceConfig(dir, created.id);
  assert.deepEqual(fetched, created);
  // Stored entries carry ids and timestamps only — no secrets, no audio.
  assert.deepEqual(Object.keys(fetched).sort(), [
    'createdAt', 'credentialId', 'id', 'model', 'name',
    'providerId', 'updatedAt', 'voice', 'voiceDirection',
  ]);
});

test('names are unique case-insensitively', async (t) => {
  const dir = tempDir(t);
  createVoiceConfig(dir, { name: 'Ranked grind', ...TRIPLE });
  assert.throws(
    () => createVoiceConfig(dir, { name: 'ranked GRIND', ...TRIPLE }),
    /already exists/,
  );
  const other = createVoiceConfig(dir, { name: 'Chill cast', ...TRIPLE });
  assert.throws(() => updateVoiceConfig(dir, other.id, { name: 'RANKED grind' }), /already exists/);
  const renamed = updateVoiceConfig(dir, other.id, { name: 'Chill cast 2' });
  assert.equal(renamed.name, 'Chill cast 2');
});

test('create rejects incomplete triples, bad shapes, and non-TTS providers', async (t) => {
  const dir = tempDir(t);
  assert.throws(() => createVoiceConfig(dir, { name: '' }), /must not be empty/);
  assert.throws(() => createVoiceConfig(dir, { name: 'x'.repeat(81), ...TRIPLE }), /too long/);
  assert.throws(() => createVoiceConfig(dir, { name: 'A' }), /needs a model, voice/);
  assert.throws(() => createVoiceConfig(dir, { name: 'A', ...TRIPLE, voice: '  ' }), /Invalid TTS configuration field/);
  assert.throws(() => createVoiceConfig(dir, { name: 'A', ...TRIPLE, voice: 'v'.repeat(65) }), /Invalid TTS configuration field/);
  assert.throws(
    () => createVoiceConfig(dir, { name: 'A', ...TRIPLE, voiceDirection: 'd'.repeat(501) }),
    /Invalid TTS configuration field/,
  );
  assert.throws(
    () => createVoiceConfig(dir, { name: 'A', ...TRIPLE, apiKey: 'sk-secret' }),
    /Unknown voice configuration field/,
  );
  assert.throws(
    () => createVoiceConfig(dir, { name: 'A', ...TRIPLE, providerId: 'nope' }),
    /Unsupported TTS provider/,
  );
  assert.throws(
    () => createVoiceConfig(dir, { name: 'A', ...TRIPLE, providerId: 'baseten' }),
    /does not support TTS/,
  );
  // Nothing persisted after the rejected writes.
  assert.deepEqual(listVoiceConfigs(dir), []);
});

test('update patches settings, clears credentials, and guards ids', async (t) => {
  const dir = tempDir(t);
  const created = createVoiceConfig(dir, { name: 'Ranked', ...TRIPLE, credentialId: 'cred-1' });
  const updated = updateVoiceConfig(dir, created.id, { voice: 'Fenrir', credentialId: null });
  assert.equal(updated.voice, 'Fenrir');
  assert.equal(updated.credentialId, null);
  assert.equal(updated.model, TRIPLE.model);
  assert.ok(Date.parse(updated.updatedAt) >= Date.parse(created.updatedAt));
  assert.throws(() => updateVoiceConfig(dir, created.id, { model: null }), /needs a model, voice/);
  assert.throws(() => updateVoiceConfig(dir, created.id, { bogus: 1 }), /Unknown voice configuration field/);
  assert.throws(() => updateVoiceConfig(dir, 'not-an-id!', { name: 'x' }), /Invalid voice configuration id/);
  assert.throws(() => updateVoiceConfig(dir, 'voice-abcdefabcdef', { name: 'x' }), /not found/);
  assert.throws(() => getVoiceConfig(dir, 'voice-abcdefabcdef'), /not found/);
  // The failed updates left the stored entry untouched.
  assert.equal(getVoiceConfig(dir, created.id).voice, 'Fenrir');
});

test('delete removes entries and reports unknown ids', async (t) => {
  const dir = tempDir(t);
  const created = createVoiceConfig(dir, { name: 'Ranked', ...TRIPLE });
  assert.deepEqual(deleteVoiceConfig(dir, created.id), { deleted: true, id: created.id });
  assert.deepEqual(listVoiceConfigs(dir), []);
  assert.throws(() => deleteVoiceConfig(dir, created.id), /not found/);
  assert.throws(() => deleteVoiceConfig(dir, ''), /Invalid voice configuration id/);
});

test('corrupted libraries fail closed with nothing silently dropped', async (t) => {
  const dir = tempDir(t);
  const file = voiceConfigLibraryPath(dir);
  fs.writeFileSync(file, 'not json{');
  assert.throws(() => listVoiceConfigs(dir), /corrupted/);
  fs.writeFileSync(file, JSON.stringify({ version: 999, configs: [] }));
  assert.throws(() => listVoiceConfigs(dir), /corrupted/);
  const dupe = {
    version: 1,
    configs: [
      { id: 'voice-aaaaaaaaaaaa', name: 'Same', providerId: 'google-gemini-tts', credentialId: null, ...TRIPLE, createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' },
      { id: 'voice-bbbbbbbbbbbb', name: 'same', providerId: 'google-gemini-tts', credentialId: null, ...TRIPLE, createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' },
    ],
  };
  fs.writeFileSync(file, JSON.stringify(dupe));
  assert.throws(() => listVoiceConfigs(dir), /corrupted/);
});
