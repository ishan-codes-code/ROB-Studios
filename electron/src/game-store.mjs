// Game profiles + commentary presets (Electron main process only).
//
// Free Fire is the only supported game for this milestone. Built-in
// defaults are synthesized in code on every read, so they always exist
// and can never be edited, deleted, or corrupted: only custom records
// are persisted (`game-library.json`). User-editable prompts are style
// preferences; protected system instructions and evidence validation
// live in the Python engine and are never exposed here.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const GAME_LIBRARY_VERSION = 1;
const LIBRARY_FILE_NAME = 'game-library.json';

export const DEFAULT_GAME_PROFILE_ID = 'free-fire-default';
export const DEFAULT_COMMENTARY_PRESET_ID = 'default-energetic';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_NAME_LENGTH = 80;
const MAX_TEXT_SHORT = 80;
const MAX_CONTEXT = 2000;

export const BUILT_IN_GAME_PROFILE = Object.freeze({
  id: DEFAULT_GAME_PROFILE_ID,
  name: 'Free Fire — Default',
  gameId: 'free-fire',
  context: '',
  builtIn: true,
  isDefault: true,
  createdAt: '1970-01-01T00:00:00.000Z',
  updatedAt: '1970-01-01T00:00:00.000Z',
});

export const BUILT_IN_COMMENTARY_PRESET = Object.freeze({
  id: DEFAULT_COMMENTARY_PRESET_ID,
  profileId: DEFAULT_GAME_PROFILE_ID,
  name: 'Default — Energetic',
  personality: 'Esports commentator',
  tone: 'energetic',
  language: 'English',
  instructions: '',
  builtIn: true,
  isDefault: true,
  createdAt: '1970-01-01T00:00:00.000Z',
  updatedAt: '1970-01-01T00:00:00.000Z',
});

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}-${crypto.randomBytes(6).toString('hex')}`;
}

function validateId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new Error('Invalid configuration id.');
  return id;
}

function validateName(name) {
  if (typeof name !== 'string') throw new Error('Name must be a string.');
  const trimmed = name.trim();
  if (trimmed === '') throw new Error('Name must not be empty.');
  if (trimmed.length > MAX_NAME_LENGTH) throw new Error('Name is too long.');
  return trimmed;
}

const shortText = (value, field) => {
  if (typeof value !== 'string') throw new Error(`Invalid ${field}.`);
  if (value.length > MAX_TEXT_SHORT) throw new Error(`Invalid ${field}.`);
  return value;
};

const longText = (value, field, max) => {
  if (typeof value !== 'string') throw new Error(`Invalid ${field}.`);
  if (value.length > max) throw new Error(`Invalid ${field}.`);
  return value;
};

function validateCustomProfile(value) {
  if (!value || typeof value !== 'object') throw new Error('Invalid game profile.');
  validateId(value.id);
  if (value.builtIn === true) throw new Error('Built-in profiles cannot be stored.');
  if (value.gameId !== 'free-fire') throw new Error('Unsupported game.');
  for (const key of ['createdAt', 'updatedAt']) {
    if (typeof value[key] !== 'string' || Number.isNaN(Date.parse(value[key]))) {
      throw new Error('Invalid game profile timestamps.');
    }
  }
  return {
    id: value.id,
    name: validateName(value.name),
    gameId: 'free-fire',
    context: longText(value.context ?? '', 'context', MAX_CONTEXT),
    builtIn: false,
    isDefault: false,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function validateCustomPreset(value, profileIds) {
  if (!value || typeof value !== 'object') throw new Error('Invalid commentary preset.');
  validateId(value.id);
  if (value.builtIn === true) throw new Error('Built-in presets cannot be stored.');
  if (typeof value.profileId !== 'string' || !profileIds.has(value.profileId)) {
    throw new Error('Commentary preset must belong to a known game profile.');
  }
  for (const key of ['createdAt', 'updatedAt']) {
    if (typeof value[key] !== 'string' || Number.isNaN(Date.parse(value[key]))) {
      throw new Error('Invalid commentary preset timestamps.');
    }
  }
  return {
    id: value.id,
    profileId: value.profileId,
    name: validateName(value.name),
    personality: shortText(value.personality ?? '', 'personality'),
    tone: shortText(value.tone ?? '', 'tone'),
    language: shortText(value.language ?? '', 'language'),
    instructions: longText(value.instructions ?? '', 'instructions', MAX_CONTEXT),
    builtIn: false,
    isDefault: false,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export function gameLibraryPath(userDataPath) {
  return path.join(userDataPath, LIBRARY_FILE_NAME);
}

function loadCustomLibrary(userDataPath) {
  const file = gameLibraryPath(userDataPath);
  if (!fs.existsSync(file)) {
    return { version: GAME_LIBRARY_VERSION, profiles: [], presets: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error('The game library is corrupted and cannot be read.');
  }
  if (!parsed || typeof parsed !== 'object' || parsed.version !== GAME_LIBRARY_VERSION) {
    throw new Error('The game library is corrupted and cannot be read.');
  }
  const profiles = Array.isArray(parsed.profiles) ? parsed.profiles.map(validateCustomProfile) : [];
  const profileIds = new Set([DEFAULT_GAME_PROFILE_ID, ...profiles.map((p) => p.id)]);
  const presets = Array.isArray(parsed.presets) ? parsed.presets.map((entry) => validateCustomPreset(entry, profileIds)) : [];
  const profileNames = new Set();
  for (const profile of profiles) {
    if (profileNames.has(profile.name.toLowerCase())) throw new Error('The game library is corrupted and cannot be read.');
    profileNames.add(profile.name.toLowerCase());
  }
  return { version: GAME_LIBRARY_VERSION, profiles, presets };
}

function saveCustomLibrary(userDataPath, { profiles, presets }) {
  const document = {
    version: GAME_LIBRARY_VERSION,
    profiles: profiles.map(validateCustomProfile),
    presets: presets.map((entry) => validateCustomPreset(
      entry,
      new Set([DEFAULT_GAME_PROFILE_ID, ...profiles.map((p) => p.id)]),
    )),
  };
  const target = gameLibraryPath(userDataPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, target);
  } finally {
    if (fs.existsSync(temp)) {
      try { fs.unlinkSync(temp); } catch { /* best effort */ }
    }
  }
  return document;
}

const clone = (value) => JSON.parse(JSON.stringify(value));

export function listGameProfiles(userDataPath) {
  const { profiles } = loadCustomLibrary(userDataPath);
  return [clone(BUILT_IN_GAME_PROFILE), ...profiles.map(clone)];
}

export function listCommentaryPresets(userDataPath, profileId = null) {
  const { presets } = loadCustomLibrary(userDataPath);
  const all = [clone(BUILT_IN_COMMENTARY_PRESET), ...presets.map(clone)];
  if (profileId === null || profileId === undefined) return all;
  validateId(profileId);
  return all.filter((preset) => preset.profileId === profileId);
}

export function getGameProfile(userDataPath, id) {
  validateId(id);
  const profile = listGameProfiles(userDataPath).find((entry) => entry.id === id);
  if (!profile) throw new Error('Game profile not found.');
  return profile;
}

export function getCommentaryPreset(userDataPath, id) {
  validateId(id);
  const preset = listCommentaryPresets(userDataPath).find((entry) => entry.id === id);
  if (!preset) throw new Error('Commentary preset not found.');
  return preset;
}

export function createGameProfile(userDataPath, { name, context = '' } = {}) {
  const library = loadCustomLibrary(userDataPath);
  const cleanName = validateName(name);
  if (library.profiles.some((entry) => entry.name.toLowerCase() === cleanName.toLowerCase())
    || cleanName.toLowerCase() === BUILT_IN_GAME_PROFILE.name.toLowerCase()) {
    throw new Error('A game profile with this name already exists.');
  }
  const timestamp = nowIso();
  const profile = {
    id: newId('game'),
    name: cleanName,
    gameId: 'free-fire',
    context: longText(context ?? '', 'context', MAX_CONTEXT),
    builtIn: false,
    isDefault: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  saveCustomLibrary(userDataPath, {
    profiles: [...library.profiles, profile],
    presets: library.presets,
  });
  return clone(profile);
}

export function updateGameProfile(userDataPath, id, patch = {}) {
  validateId(id);
  if (id === DEFAULT_GAME_PROFILE_ID) throw new Error('The built-in default profile cannot be edited.');
  const library = loadCustomLibrary(userDataPath);
  const profile = library.profiles.find((entry) => entry.id === id);
  if (!profile) throw new Error('Game profile not found.');
  if (!patch || typeof patch !== 'object') throw new Error('Invalid game profile update.');
  const next = { ...profile };
  if (patch.name !== undefined) {
    const cleanName = validateName(patch.name);
    if (library.profiles.some((entry) => entry.id !== id && entry.name.toLowerCase() === cleanName.toLowerCase())
      || cleanName.toLowerCase() === BUILT_IN_GAME_PROFILE.name.toLowerCase()) {
      throw new Error('A game profile with this name already exists.');
    }
    next.name = cleanName;
  }
  if (patch.context !== undefined) next.context = longText(patch.context, 'context', MAX_CONTEXT);
  next.updatedAt = nowIso();
  const validated = validateCustomProfile(next);
  saveCustomLibrary(userDataPath, {
    profiles: library.profiles.map((entry) => (entry.id === id ? validated : entry)),
    presets: library.presets,
  });
  return clone(validated);
}

export function deleteGameProfile(userDataPath, id) {
  validateId(id);
  if (id === DEFAULT_GAME_PROFILE_ID) throw new Error('The built-in default profile cannot be deleted.');
  const library = loadCustomLibrary(userDataPath);
  if (!library.profiles.some((entry) => entry.id === id)) throw new Error('Game profile not found.');
  if (library.presets.some((preset) => preset.profileId === id)) {
    throw new Error('This profile still has commentary presets. Delete or move them first.');
  }
  saveCustomLibrary(userDataPath, {
    profiles: library.profiles.filter((entry) => entry.id !== id),
    presets: library.presets,
  });
  return { deleted: true, id };
}

export function createCommentaryPreset(userDataPath, {
  profileId, name, personality = '', tone = '', language = '', instructions = '',
} = {}) {
  const library = loadCustomLibrary(userDataPath);
  const ownerIds = new Set([DEFAULT_GAME_PROFILE_ID, ...library.profiles.map((p) => p.id)]);
  if (typeof profileId !== 'string' || !ownerIds.has(profileId)) {
    throw new Error('Commentary preset must belong to a known game profile.');
  }
  const cleanName = validateName(name);
  const siblings = [BUILT_IN_COMMENTARY_PRESET, ...library.presets]
    .filter((preset) => preset.profileId === profileId);
  if (siblings.some((preset) => preset.name.toLowerCase() === cleanName.toLowerCase())) {
    throw new Error('A preset with this name already exists for this profile.');
  }
  const timestamp = nowIso();
  const preset = {
    id: newId('preset'),
    profileId,
    name: cleanName,
    personality: shortText(personality ?? '', 'personality'),
    tone: shortText(tone ?? '', 'tone'),
    language: shortText(language ?? '', 'language'),
    instructions: longText(instructions ?? '', 'instructions', MAX_CONTEXT),
    builtIn: false,
    isDefault: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  saveCustomLibrary(userDataPath, {
    profiles: library.profiles,
    presets: [...library.presets, validateCustomPreset(preset, ownerIds)],
  });
  return clone(preset);
}

export function updateCommentaryPreset(userDataPath, id, patch = {}) {
  validateId(id);
  if (id === DEFAULT_COMMENTARY_PRESET_ID) throw new Error('The built-in default preset cannot be edited.');
  const library = loadCustomLibrary(userDataPath);
  const preset = library.presets.find((entry) => entry.id === id);
  if (!preset) throw new Error('Commentary preset not found.');
  if (!patch || typeof patch !== 'object') throw new Error('Invalid preset update.');
  const next = { ...preset };
  if (patch.name !== undefined) {
    const cleanName = validateName(patch.name);
    const siblings = [BUILT_IN_COMMENTARY_PRESET, ...library.presets]
      .filter((entry) => entry.profileId === next.profileId && entry.id !== id);
    if (siblings.some((entry) => entry.name.toLowerCase() === cleanName.toLowerCase())) {
      throw new Error('A preset with this name already exists for this profile.');
    }
    next.name = cleanName;
  }
  if (patch.personality !== undefined) next.personality = shortText(patch.personality, 'personality');
  if (patch.tone !== undefined) next.tone = shortText(patch.tone, 'tone');
  if (patch.language !== undefined) next.language = shortText(patch.language, 'language');
  if (patch.instructions !== undefined) next.instructions = longText(patch.instructions, 'instructions', MAX_CONTEXT);
  next.updatedAt = nowIso();
  const ownerIds = new Set([DEFAULT_GAME_PROFILE_ID, ...library.profiles.map((p) => p.id)]);
  const validated = validateCustomPreset(next, ownerIds);
  saveCustomLibrary(userDataPath, {
    profiles: library.profiles,
    presets: library.presets.map((entry) => (entry.id === id ? validated : entry)),
  });
  return clone(validated);
}

export function duplicateCommentaryPreset(userDataPath, id, name = null) {
  validateId(id);
  const source = getCommentaryPreset(userDataPath, id);
  const library = loadCustomLibrary(userDataPath);
  const base = name === null || name === undefined ? `${source.name} copy` : validateName(name);
  const siblings = [BUILT_IN_COMMENTARY_PRESET, ...library.presets]
    .filter((preset) => preset.profileId === source.profileId);
  let candidate = base.slice(0, MAX_NAME_LENGTH);
  let attempt = 0;
  while (siblings.some((preset) => preset.name.toLowerCase() === candidate.toLowerCase())) {
    attempt += 1;
    if (attempt > 99) throw new Error('Could not find an unused preset name.');
    candidate = `${base} ${attempt + 1}`.slice(0, MAX_NAME_LENGTH);
  }
  return createCommentaryPreset(userDataPath, {
    profileId: source.profileId,
    name: candidate,
    personality: source.personality,
    tone: source.tone,
    language: source.language,
    instructions: source.instructions,
  });
}

export function deleteCommentaryPreset(userDataPath, id) {
  validateId(id);
  if (id === DEFAULT_COMMENTARY_PRESET_ID) throw new Error('The built-in default preset cannot be deleted.');
  const library = loadCustomLibrary(userDataPath);
  if (!library.presets.some((entry) => entry.id === id)) throw new Error('Commentary preset not found.');
  saveCustomLibrary(userDataPath, {
    profiles: library.profiles,
    presets: library.presets.filter((entry) => entry.id !== id),
  });
  return { deleted: true, id };
}

/** Prompt/game payload the worker consumes (non-secret, bounded). */
export function buildWorkerPreferences(userDataPath, gameProfileId, commentaryPresetId) {
  const profile = getGameProfile(userDataPath, gameProfileId);
  const preset = getCommentaryPreset(userDataPath, commentaryPresetId);
  if (preset.profileId !== profile.id && !preset.builtIn) {
    throw new Error('Commentary preset does not belong to the selected game profile.');
  }
  return {
    game: { id: profile.gameId, context: profile.context },
    prompt: {
      personality: preset.personality,
      tone: preset.tone,
      language: preset.language,
      instructions: preset.instructions,
    },
  };
}
