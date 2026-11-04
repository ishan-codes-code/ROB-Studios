import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createProject,
  getProject,
  updateProject,
  defaultProjectConfiguration,
} from '../src/project-store.mjs';
import {
  createCredential,
  markCredentialVerified,
} from '../src/credentials-store.mjs';
import { resolveProjectRunConfig, resolveTtsRunConfig, stripHostSecrets } from '../src/main/run-config.mjs';

const storage = () => ({
  isEncryptionAvailable: () => true,
  encryptString: (v) => Buffer.from(`enc:${Buffer.from(String(v), 'utf8').toString('base64')}`, 'utf8'),
  decryptString: (buf) => Buffer.from(String(buf == null ? '' : buf).replace(/^enc:/, ''), 'base64').toString('utf8'),
});

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-projcfg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seedVideo(t) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-vid-')), 'clip.mp4');
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  fs.writeFileSync(file, Buffer.alloc(16, 0));
  return file;
}

test('new projects carry default configuration; legacy projects default on read', async (t) => {
  const dir = tempDir(t);
  const project = createProject(dir, { name: 'Fresh', sourcePath: seedVideo(t) });
  assert.deepEqual(project.configuration, defaultProjectConfiguration());
  assert.equal(project.configuration.credentialId, null);
  assert.deepEqual(project.configuration.game, {
    id: 'free-fire', matchType: null, mode: null, map: null, category: null,
    teams: [], tournament: null, stage: null,
    language: 'English', additionalContext: '',
  });
  // Simulate a pre-migration project.json without configuration.
  const rawPath = path.join(dir, 'projects', project.id, 'project.json');
  const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  delete raw.configuration;
  fs.writeFileSync(rawPath, JSON.stringify(raw, null, 2));
  const reread = getProject(dir, project.id);
  assert.equal(reread.configuration.game.id, 'free-fire');
});

test('partial stored configuration defaults on read without rewriting', async (t) => {
  const dir = tempDir(t);
  const project = createProject(dir, { name: 'Legacy', sourcePath: seedVideo(t) });
  // Simulate an older project.json carrying only a credential reference.
  const rawPath = path.join(dir, 'projects', project.id, 'project.json');
  const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  raw.configuration = { credentialId: null };
  fs.writeFileSync(rawPath, JSON.stringify(raw, null, 2));
  const reread = getProject(dir, project.id);
  assert.equal(reread.configuration.credentialId, null);
  assert.equal(reread.configuration.game.id, 'free-fire');
  assert.equal(reread.configuration.game.language, 'English');
  // Loading must not silently overwrite the stored selections.
  const stored = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  assert.deepEqual(stored.configuration, { credentialId: null });
});

test('creation persists project-owned game metadata', async (t) => {
  const dir = tempDir(t);
  const project = createProject(dir, {
    name: 'Match',
    sourcePath: seedVideo(t),
    game: {
      id: 'free-fire', mode: 'battle-royale', matchType: 'Ranked', map: 'Bermuda',
      language: 'English', teams: ['Team A', 'Team B'], additionalContext: 'Semifinal.',
    },
  });
  assert.deepEqual(project.configuration.game, {
    id: 'free-fire', mode: 'battle-royale', matchType: 'Ranked', map: 'Bermuda', category: null,
    language: 'English', teams: ['Team A', 'Team B'], tournament: null, stage: null,
    additionalContext: 'Semifinal.',
  });
  // A fresh read (application restart) returns the same metadata.
  assert.deepEqual(getProject(dir, project.id).configuration.game, project.configuration.game);
  // Partial input fills defaults; blanks normalize to null.
  const partial = createProject(dir, {
    name: 'Partial', sourcePath: seedVideo(t), game: { map: '  Purgatory ' },
  });
  assert.deepEqual(partial.configuration.game, {
    id: 'free-fire', mode: null, matchType: null, map: 'Purgatory', category: null,
    language: 'English', teams: [], tournament: null, stage: null, additionalContext: '',
  });
});

test('game metadata validation rejects unsupported games and oversize fields', async (t) => {
  const dir = tempDir(t);
  const video = seedVideo(t);
  assert.throws(
    () => createProject(dir, { name: 'Bad', sourcePath: video, game: { id: 'unknown-game' } }),
    /Invalid game metadata/,
  );
  assert.throws(
    () => createProject(dir, { name: 'Bad', sourcePath: video, game: { map: 'm'.repeat(81) } }),
    /Invalid game metadata/,
  );
  assert.throws(
    () => createProject(dir, { name: 'Bad', sourcePath: video, game: { teams: 'not-an-array' } }),
    /Invalid game metadata/,
  );
  const project = createProject(dir, { name: 'P', sourcePath: video });
  assert.throws(
    () => updateProject(dir, project.id, { configuration: { game: { id: 'unknown-game' } } }),
    /Invalid game metadata/,
  );
  const updated = updateProject(dir, project.id, { configuration: { game: { map: 'Bermuda' } } });
  assert.equal(updated.configuration.game.map, 'Bermuda');
  assert.equal(updated.configuration.game.id, 'free-fire');
});

function writeLegacyConfig(dir, projectId, configuration) {
  const rawPath = path.join(dir, 'projects', projectId, 'project.json');
  const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  raw.configuration = configuration;
  fs.writeFileSync(rawPath, JSON.stringify(raw, null, 2));
  return rawPath;
}

test('legacy profile/preset references migrate to owned metadata without rewriting', async (t) => {
  const dir = tempDir(t);
  const project = createProject(dir, { name: 'Old', sourcePath: seedVideo(t) });
  fs.writeFileSync(path.join(dir, 'game-library.json'), JSON.stringify({
    version: 1,
    profiles: [{ id: 'custom-room', name: 'Custom', gameId: 'free-fire', context: 'Night tournament.' }],
    presets: [{ id: 'custom-calm', profileId: 'custom-room', name: 'Calm', personality: 'Caster', tone: 'calm', language: 'Hindi', instructions: '' }],
  }));
  const rawPath = writeLegacyConfig(dir, project.id, {
    credentialId: null, gameProfileId: 'custom-room', commentaryPresetId: 'custom-calm', promptPackId: null,
  });
  const reread = getProject(dir, project.id);
  assert.deepEqual(reread.configuration.game, {
    id: 'free-fire', mode: null, matchType: null, map: null, category: null,
    language: 'Hindi', teams: [], tournament: null, stage: null,
    additionalContext: 'Night tournament.',
  });
  // Loading migrates in memory only; the stored file keeps the legacy
  // references until the next explicit save.
  assert.deepEqual(JSON.parse(fs.readFileSync(rawPath, 'utf8')).configuration, {
    credentialId: null, gameProfileId: 'custom-room', commentaryPresetId: 'custom-calm', promptPackId: null,
  });
  // An explicit save persists the migrated shape (idempotent: rereads equal).
  const updated = updateProject(dir, project.id, { configuration: { credentialId: null } });
  assert.equal(updated.configuration.game.additionalContext, 'Night tournament.');
  assert.equal(updated.configuration.gameProfileId, undefined);
  assert.deepEqual(getProject(dir, project.id).configuration, updated.configuration);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(rawPath, 'utf8')).configuration.game.additionalContext,
    'Night tournament.',
  );
});

test('unresolvable legacy references fall back to defaults and never break loading', async (t) => {
  const dir = tempDir(t);
  const project = createProject(dir, { name: 'Orphan', sourcePath: seedVideo(t) });
  // No game-library.json on disk at all, plus garbage ids.
  writeLegacyConfig(dir, project.id, {
    credentialId: null, gameProfileId: 'gone!', commentaryPresetId: 'also-gone',
  });
  const reread = getProject(dir, project.id);
  assert.equal(reread.configuration.game.id, 'free-fire');
  assert.equal(reread.configuration.game.language, 'English');
});

test('project TTS overrides default to inherit and persist explicitly', async (t) => {
  const dir = tempDir(t);
  const project = createProject(dir, { name: 'TTS', sourcePath: seedVideo(t) });
  assert.deepEqual(project.configuration.tts, {
    model: null, voice: null, voiceDirection: null, credentialId: null,
  });
  const updated = updateProject(dir, project.id, {
    configuration: { tts: { voice: 'Fenrir', credentialId: null } },
  });
  assert.deepEqual(updated.configuration.tts, {
    model: null, voice: 'Fenrir', voiceDirection: null, credentialId: null,
  });
  // A fresh read (application restart) returns the same override.
  assert.deepEqual(getProject(dir, project.id).configuration.tts, updated.configuration.tts);
  assert.throws(
    () => updateProject(dir, project.id, { configuration: { tts: { voice: 'v'.repeat(65) } } }),
    /Invalid TTS configuration field 'voice'/,
  );
});

test('legacy project configuration without TTS inherits without rewriting', async (t) => {
  const dir = tempDir(t);
  const project = createProject(dir, { name: 'LegacyTTS', sourcePath: seedVideo(t) });
  const rawPath = path.join(dir, 'projects', project.id, 'project.json');
  const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  raw.configuration = { credentialId: null };
  fs.writeFileSync(rawPath, JSON.stringify(raw, null, 2));
  const reread = getProject(dir, project.id);
  assert.deepEqual(reread.configuration.tts, {
    model: null, voice: null, voiceDirection: null, credentialId: null,
  });
  const stored = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  assert.deepEqual(stored.configuration, { credentialId: null });
});

test('TTS run resolution merges config and gates the credential', async (t) => {
  const dir = tempDir(t);
  const catalog = {
    models: [{ id: 'gemini-3.8-flash-tts', description: '' }],
    voices: [{ id: 'Kore', character: '' }],
    defaults: { model: 'gemini-3.8-flash-tts', voice: 'Kore', voiceDirection: 'Default style.' },
    limits: { voiceMaxLength: 64, voiceDirectionMaxLength: 500 },
  };
  const project = createProject(dir, { name: 'TTS Run', sourcePath: seedVideo(t) });
  assert.throws(
    () => resolveTtsRunConfig(dir, storage(), project.id, catalog),
    /no TTS credential selected/,
  );
  const tts = createCredential(dir, storage(), {
    name: 'TTS', provider: 'google-gemini-tts', model: null, key: 'run-tts-key',
  });
  updateProject(dir, project.id, {
    configuration: { tts: { voice: 'Kore', credentialId: tts.id } },
  });
  assert.throws(
    () => resolveTtsRunConfig(dir, storage(), project.id, catalog),
    /not verified/,
  );
  markCredentialVerified(dir, storage(), tts.id, null);
  const resolved = resolveTtsRunConfig(dir, storage(), project.id, catalog);
  assert.deepEqual(resolved.config, {
    model: 'gemini-3.8-flash-tts',
    voice: 'Kore',
    voiceDirection: 'Default style.',
  });
  assert.equal(resolved.apiKey, 'run-tts-key');
  assert.equal(resolved.credentialName, 'TTS');
  const vision = createCredential(dir, storage(), {
    name: 'Vision', provider: 'meta', model: 'muse-spark-1.3', key: 'vision-key',
  });
  updateProject(dir, project.id, { configuration: { tts: { credentialId: vision.id } } });
  assert.throws(
    () => resolveTtsRunConfig(dir, storage(), project.id, catalog),
    /not a TTS credential/,
  );
});

test('configuration patches merge and validate fields', async (t) => {
  const dir = tempDir(t);
  const project = createProject(dir, { name: 'P', sourcePath: seedVideo(t) });
  const updated = updateProject(dir, project.id, {
    configuration: { game: { map: 'Bermuda' } },
  });
  assert.equal(updated.configuration.game.map, 'Bermuda');
  assert.throws(() => updateProject(dir, project.id, { configuration: { game: 'nope!' } }), /Invalid game metadata/);
  assert.throws(() => updateProject(dir, project.id, { configuration: { gameProfileId: 'free-fire-default' } }), /cannot be updated/);
  assert.throws(() => updateProject(dir, project.id, { configuration: { unknown: 'x' } }), /cannot be updated/);
  assert.throws(() => updateProject(dir, project.id, { name: 'New name' }), /cannot be updated/);
});

test('run resolution returns provider runtime without leaking other keys', async (t) => {
  const dir = tempDir(t);
  const credential = createCredential(dir, storage(), {
    name: 'Meta', provider: 'meta', model: 'muse-spark-1.3', key: 'run-key',
  });
  markCredentialVerified(dir, storage(), credential.id, credential.model);
  const project = createProject(dir, { name: 'P', sourcePath: seedVideo(t) });
  updateProject(dir, project.id, { configuration: { credentialId: credential.id } });
  const resolved = resolveProjectRunConfig(dir, storage(), project.id);
  assert.equal(resolved.provider, 'meta');
  assert.equal(resolved.model, 'muse-spark-1.3');
  assert.equal(resolved.apiKey, 'run-key');
  assert.equal(resolved.baseUrl, 'https://api.meta.ai/v1');
  assert.equal(resolved.verified, true);
  assert.equal(resolved.preferences.game.id, 'free-fire');
  assert.equal(resolved.preferences.game.context, '');
  assert.deepEqual(resolved.preferences.prompt, {
    personality: 'Esports commentator',
    tone: 'energetic',
    language: 'English',
    instructions: '',
  });
});

test('all three catalog games persist with their metadata', async (t) => {
  const dir = tempDir(t);
  const video = seedVideo(t);
  const cod = createProject(dir, {
    name: 'CoD', sourcePath: video,
    game: { id: 'cod', matchType: 'Multiplayer', mode: 'Domination', map: 'Shoot House', category: 'Casual' },
  });
  assert.equal(cod.configuration.game.id, 'cod');
  assert.equal(cod.configuration.game.mode, 'Domination');
  const bgmi = createProject(dir, {
    name: 'BGMI', sourcePath: video,
    game: { id: 'bgmi', matchType: 'Battle Royale', mode: 'Squad', map: 'Erangel', category: 'Ranked' },
  });
  assert.equal(bgmi.configuration.game.id, 'bgmi');
  assert.deepEqual(getProject(dir, bgmi.id).configuration.game.map, 'Erangel');
});

test('tournament, stage, and category validate like other short fields', async (t) => {
  const dir = tempDir(t);
  const project = createProject(dir, {
    name: 'T', sourcePath: seedVideo(t),
    game: { category: 'Tournament', tournament: 'City Finals', stage: 'Semifinal' },
  });
  assert.equal(project.configuration.game.tournament, 'City Finals');
  assert.equal(project.configuration.game.stage, 'Semifinal');
  assert.throws(
    () => createProject(dir, { name: 'Bad', sourcePath: seedVideo(t), game: { tournament: 't'.repeat(81) } }),
    /Invalid game metadata/,
  );
  assert.throws(
    () => updateProject(dir, project.id, { configuration: { game: { stage: 42 } } }),
    /Invalid game metadata/,
  );
});

test('legacy free-text mode and match type pass through new validation', async (t) => {
  const dir = tempDir(t);
  const project = createProject(dir, { name: 'Legacy', sourcePath: seedVideo(t) });
  const rawPath = path.join(dir, 'projects', project.id, 'project.json');
  const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  // A custom entry from before the per-game suggestion lists.
  raw.configuration.game.mode = 'Lone Wolf';
  raw.configuration.game.matchType = 'Room card';
  fs.writeFileSync(rawPath, JSON.stringify(raw, null, 2));
  const reread = getProject(dir, project.id);
  assert.equal(reread.configuration.game.mode, 'Lone Wolf');
  assert.equal(reread.configuration.game.matchType, 'Room card');
});

test('worker context excludes not-yet-integrated fields', async (t) => {
  const dir = tempDir(t);
  const credential = createCredential(dir, storage(), {
    name: 'Meta', provider: 'meta', model: 'muse-spark-1.3', key: 'run-key',
  });
  markCredentialVerified(dir, storage(), credential.id, credential.model);
  const project = createProject(dir, {
    name: 'P', sourcePath: seedVideo(t),
    game: { map: 'Bermuda', category: 'Tournament', tournament: 'City Finals', stage: 'Semifinal' },
  });
  updateProject(dir, project.id, { configuration: { credentialId: credential.id } });
  const resolved = resolveProjectRunConfig(dir, storage(), project.id);
  assert.equal(resolved.preferences.game.context, 'Map: Bermuda.');
});

test('run resolution composes worker context from owned game metadata', async (t) => {
  const dir = tempDir(t);
  const credential = createCredential(dir, storage(), {
    name: 'Meta', provider: 'meta', model: 'muse-spark-1.3', key: 'run-key',
  });
  markCredentialVerified(dir, storage(), credential.id, credential.model);
  const project = createProject(dir, {
    name: 'P',
    sourcePath: seedVideo(t),
    game: {
      mode: 'battle-royale', map: 'Bermuda', language: 'Hindi',
      teams: ['Team A', 'Team B'], additionalContext: 'Semifinal.',
    },
  });
  updateProject(dir, project.id, { configuration: { credentialId: credential.id } });
  const resolved = resolveProjectRunConfig(dir, storage(), project.id);
  assert.equal(
    resolved.preferences.game.context,
    'Mode: battle-royale. Map: Bermuda. Teams: Team A vs Team B. Semifinal.',
  );
  assert.equal(resolved.preferences.prompt.language, 'Hindi');
  assert.equal(resolved.preferences.prompt.personality, 'Esports commentator');
});

test('run resolution never substitutes another key and flags unverified', async (t) => {
  const dir = tempDir(t);
  const project = createProject(dir, { name: 'P', sourcePath: seedVideo(t) });
  assert.throws(() => resolveProjectRunConfig(dir, storage(), project.id), /no API configuration/);
  updateProject(dir, project.id, { configuration: { credentialId: 'cred-does-not-exist' } });
  assert.throws(() => resolveProjectRunConfig(dir, storage(), project.id), /missing or unreadable/);
  const credential = createCredential(dir, storage(), {
    name: 'B', provider: 'baseten', model: 'meta-models/muse-spark-open', key: 'k',
  });
  updateProject(dir, project.id, { configuration: { credentialId: credential.id } });
  const resolved = resolveProjectRunConfig(dir, storage(), project.id);
  assert.equal(resolved.verified, false);
});

test('prompt pack selection defaults to null and stays patchable', async (t) => {
  const dir = tempDir(t);
  const project = createProject(dir, { name: 'P', sourcePath: seedVideo(t) });
  assert.equal(project.configuration.promptPackId, null);
  // Legacy files without the field read as null (application default).
  const rawPath = path.join(dir, 'projects', project.id, 'project.json');
  const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  delete raw.configuration.promptPackId;
  fs.writeFileSync(rawPath, JSON.stringify(raw, null, 2));
  assert.equal(getProject(dir, project.id).configuration.promptPackId, null);
  const updated = updateProject(dir, project.id, { configuration: { promptPackId: 'cod' } });
  assert.equal(updated.configuration.promptPackId, 'cod');
  assert.throws(() => updateProject(dir, project.id, { configuration: { promptPackId: 'bad id!' } }), /Invalid project configuration/);
});

test('run resolution snapshots the prompt pack with customs', async (t) => {
  const dir = tempDir(t);
  const credential = createCredential(dir, storage(), {
    name: 'Meta', provider: 'meta', model: 'muse-spark-1.3', key: 'run-key',
  });
  markCredentialVerified(dir, storage(), credential.id, credential.model);
  const project = createProject(dir, { name: 'P', sourcePath: seedVideo(t) });
  updateProject(dir, project.id, { configuration: { credentialId: credential.id, promptPackId: 'cod' } });
  fs.writeFileSync(
    path.join(dir, 'prompt-packs.json'),
    JSON.stringify({ version: 1, custom: { cod: { script_closing: 'Custom.' } } }),
  );
  const resolved = resolveProjectRunConfig(dir, storage(), project.id);
  assert.deepEqual(resolved.preferences.promptPack, { packId: 'cod', custom: { script_closing: 'Custom.' } });
  const fresh = createProject(dir, { name: 'Q', sourcePath: seedVideo(t) });
  updateProject(dir, fresh.id, { configuration: { credentialId: credential.id } });
  const fallback = resolveProjectRunConfig(dir, storage(), fresh.id);
  assert.deepEqual(fallback.preferences.promptPack, { packId: 'free-fire', custom: {} });
});

test('run resolution snapshots the custom endpoint from the record', async (t) => {
  const dir = tempDir(t);
  const credential = createCredential(dir, storage(), {
    name: 'Gateway', provider: 'custom', model: 'qwen-vl', key: 'run-key',
    baseUrl: 'https://llm.example.com/v1',
  });
  markCredentialVerified(dir, storage(), credential.id, credential.model, credential.baseUrl);
  const project = createProject(dir, { name: 'P', sourcePath: seedVideo(t) });
  updateProject(dir, project.id, { configuration: { credentialId: credential.id } });
  const resolved = resolveProjectRunConfig(dir, storage(), project.id);
  assert.equal(resolved.provider, 'custom');
  assert.equal(resolved.baseUrl, 'https://llm.example.com/v1');
  assert.equal(resolved.verified, true);
});

test('host secrets are stripped from the worker environment', async () => {
  const clean = stripHostSecrets({
    PATH: '/usr/bin', BASETEN_API_KEY: 'x', AI_COMMENTATOR_API_KEY: 'y',
    GITHUB_TOKEN: 'z', DB_PASSWORD: 'w', KEEP_ME: '1',
  });
  assert.deepEqual(clean, { PATH: '/usr/bin', KEEP_ME: '1' });
});
