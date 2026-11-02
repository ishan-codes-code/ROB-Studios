import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  listGameProfiles,
  listCommentaryPresets,
  getGameProfile,
  getCommentaryPreset,
  createGameProfile,
  updateGameProfile,
  deleteGameProfile,
  createCommentaryPreset,
  updateCommentaryPreset,
  duplicateCommentaryPreset,
  deleteCommentaryPreset,
  buildWorkerPreferences,
  DEFAULT_GAME_PROFILE_ID,
  DEFAULT_COMMENTARY_PRESET_ID,
  BUILT_IN_GAME_PROFILE,
  BUILT_IN_COMMENTARY_PRESET,
} from '../src/game-store.mjs';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-game-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('built-in defaults always exist and are immutable', async (t) => {
  const dir = tempDir(t);
  const profiles = listGameProfiles(dir);
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].id, DEFAULT_GAME_PROFILE_ID);
  assert.equal(profiles[0].builtIn, true);
  const presets = listCommentaryPresets(dir);
  assert.equal(presets.length, 1);
  assert.equal(presets[0].id, DEFAULT_COMMENTARY_PRESET_ID);
  assert.throws(() => updateGameProfile(dir, DEFAULT_GAME_PROFILE_ID, { name: 'X' }), /built-in/i);
  assert.throws(() => deleteGameProfile(dir, DEFAULT_GAME_PROFILE_ID), /built-in/i);
  assert.throws(() => updateCommentaryPreset(dir, DEFAULT_COMMENTARY_PRESET_ID, { tone: 'x' }), /built-in/i);
  assert.throws(() => deleteCommentaryPreset(dir, DEFAULT_COMMENTARY_PRESET_ID), /built-in/i);
  assert.deepEqual(BUILT_IN_GAME_PROFILE.gameId, 'free-fire');
});

test('custom profiles round-trip with validation', async (t) => {
  const dir = tempDir(t);
  const profile = createGameProfile(dir, { name: 'Free Fire — Ranked', context: 'Ranked grind.' });
  assert.equal(profile.gameId, 'free-fire');
  assert.equal(profile.builtIn, false);
  assert.equal(listGameProfiles(dir).length, 2);
  assert.equal(getGameProfile(dir, profile.id).context, 'Ranked grind.');
  assert.throws(() => createGameProfile(dir, { name: 'Free Fire — Ranked' }), /already exists/);
  assert.throws(() => createGameProfile(dir, { name: '' }), /must not be empty/);
  assert.throws(() => createGameProfile(dir, { name: 'Other', context: 'x'.repeat(2001) }), /Invalid context/);
  const updated = updateGameProfile(dir, profile.id, { name: 'Free Fire — Competitive' });
  assert.equal(updated.name, 'Free Fire — Competitive');
});

test('presets belong to profiles and duplicate cleanly', async (t) => {
  const dir = tempDir(t);
  const profile = createGameProfile(dir, { name: 'Custom' });
  const preset = createCommentaryPreset(dir, {
    profileId: profile.id, name: 'Tournament Caster',
    personality: 'Caster', tone: 'hype', language: 'English', instructions: 'Short calls.',
  });
  assert.equal(listCommentaryPresets(dir, profile.id).length, 1);
  assert.equal(listCommentaryPresets(dir, DEFAULT_GAME_PROFILE_ID).length, 1);
  assert.throws(() => createCommentaryPreset(dir, { profileId: 'missing', name: 'X' }), /known game profile/);
  const copy = duplicateCommentaryPreset(dir, preset.id);
  assert.ok(copy.name.includes('copy'));
  assert.equal(copy.personality, 'Caster');
  assert.equal(getCommentaryPreset(dir, copy.id).tone, 'hype');
  const renamed = updateCommentaryPreset(dir, preset.id, { tone: 'measured' });
  assert.equal(renamed.tone, 'measured');
});

test('profile with presets cannot be deleted; preset delete works', async (t) => {
  const dir = tempDir(t);
  const profile = createGameProfile(dir, { name: 'Temp' });
  const preset = createCommentaryPreset(dir, { profileId: profile.id, name: 'P1' });
  assert.throws(() => deleteGameProfile(dir, profile.id), /presets/);
  deleteCommentaryPreset(dir, preset.id);
  assert.deepEqual(deleteGameProfile(dir, profile.id), { deleted: true, id: profile.id });
  assert.equal(listGameProfiles(dir).length, 1);
});

test('worker preferences combine profile and preset without secrets', async (t) => {
  const dir = tempDir(t);
  const prefs = buildWorkerPreferences(dir, DEFAULT_GAME_PROFILE_ID, DEFAULT_COMMENTARY_PRESET_ID);
  assert.equal(prefs.game.id, 'free-fire');
  assert.equal(prefs.prompt.tone, BUILT_IN_COMMENTARY_PRESET.tone);
  assert.equal(JSON.stringify(prefs).includes('enc:'), false);
  const profile = createGameProfile(dir, { name: 'Ranked', context: 'Final zones.' });
  const preset = createCommentaryPreset(dir, { profileId: profile.id, name: 'Calm', tone: 'calm' });
  const custom = buildWorkerPreferences(dir, profile.id, preset.id);
  assert.equal(custom.game.context, 'Final zones.');
  assert.equal(custom.prompt.tone, 'calm');
  assert.throws(() => buildWorkerPreferences(dir, 'missing', preset.id), /not found/);
});
