// Reusable TTS voice configurations (Electron main process only).
//
// User presets that can be applied to any project's voice settings.
// Each entry is a complete voice triple (model/voice/voiceDirection)
// plus a vault credential *reference* — never key material. Entries
// persist in `voice-configs.json` next to the other userData stores;
// applying one copies its values into `project.json` through the
// existing `tts-config-set` channel, so projects never point back at
// the library and later edits stay isolated.
//
// Validation here is shape-only on purpose: catalogue membership and
// credential existence are checked at apply time (the existing
// `tts-config-set` gates), so saved entries survive catalogue changes
// and credential rotations instead of failing to load.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizePartialTtsConfig } from './tts-config.mjs';
import { PROVIDER_GEMINI_TTS, getProvider } from './provider-catalog.mjs';

export const VOICE_CONFIG_VERSION = 1;
const LIBRARY_FILE_NAME = 'voice-configs.json';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_NAME_LENGTH = 80;

const SETTINGS_FIELDS = Object.freeze(['model', 'voice', 'voiceDirection', 'credentialId']);

function nowIso() {
  return new Date().toISOString();
}

function newId() {
  return `voice-${crypto.randomBytes(6).toString('hex')}`;
}

function validateId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new Error('Invalid voice configuration id.');
  return id;
}

function validateName(name) {
  if (typeof name !== 'string') throw new Error('Name must be a string.');
  const trimmed = name.trim();
  if (trimmed === '') throw new Error('Name must not be empty.');
  if (trimmed.length > MAX_NAME_LENGTH) throw new Error('Name is too long.');
  return trimmed;
}

function validateProviderId(providerId) {
  if (typeof providerId !== 'string' || providerId.trim() === '') {
    throw new Error('Invalid TTS provider.');
  }
  let provider;
  try {
    provider = getProvider(providerId);
  } catch {
    throw new Error(`Unsupported TTS provider '${providerId}'.`);
  }
  if (provider.purpose !== 'tts') throw new Error(`Provider '${providerId}' does not support TTS.`);
  return provider.id;
}

/**
 * Validate one complete settings triple. Shape and bounds come from
 * the shared TTS config model (same trims as synthesis time); the
 * triple itself must be complete — partial presets belong to project
 * layers, not the library. `credentialId` stays nullable so a preset
 * can outlive its credential; apply-time gates resolve it.
 */
function validateSettings(value) {
  const normalized = normalizePartialTtsConfig(value);
  if (normalized.model === null || normalized.voice === null || normalized.voiceDirection === null) {
    throw new Error('Voice configuration needs a model, voice, and voice direction.');
  }
  return normalized;
}

function validateStoredConfig(value) {
  if (!value || typeof value !== 'object') throw new Error('Invalid voice configuration.');
  for (const key of ['createdAt', 'updatedAt']) {
    if (typeof value[key] !== 'string' || Number.isNaN(Date.parse(value[key]))) {
      throw new Error('Invalid voice configuration timestamps.');
    }
  }
  return {
    id: validateId(value.id),
    name: validateName(value.name),
    providerId: validateProviderId(value.providerId),
    ...validateSettings({
      model: value.model,
      voice: value.voice,
      voiceDirection: value.voiceDirection,
      credentialId: value.credentialId,
    }),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export function voiceConfigLibraryPath(userDataPath) {
  return path.join(userDataPath, LIBRARY_FILE_NAME);
}

function loadLibrary(userDataPath) {
  const file = voiceConfigLibraryPath(userDataPath);
  if (!fs.existsSync(file)) {
    return { version: VOICE_CONFIG_VERSION, configs: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error('The voice configuration library is corrupted and cannot be read.');
  }
  if (!parsed || typeof parsed !== 'object' || parsed.version !== VOICE_CONFIG_VERSION) {
    throw new Error('The voice configuration library is corrupted and cannot be read.');
  }
  const configs = Array.isArray(parsed.configs) ? parsed.configs.map(validateStoredConfig) : [];
  const names = new Set();
  for (const config of configs) {
    if (names.has(config.name.toLowerCase())) {
      throw new Error('The voice configuration library is corrupted and cannot be read.');
    }
    names.add(config.name.toLowerCase());
  }
  return { version: VOICE_CONFIG_VERSION, configs };
}

function saveLibrary(userDataPath, { configs }) {
  const document = {
    version: VOICE_CONFIG_VERSION,
    configs: configs.map(validateStoredConfig),
  };
  const target = voiceConfigLibraryPath(userDataPath);
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

function assertUniqueName(configs, name, exceptId = null) {
  if (configs.some((entry) => entry.id !== exceptId && entry.name.toLowerCase() === name.toLowerCase())) {
    throw new Error('A voice configuration with this name already exists.');
  }
}

export function listVoiceConfigs(userDataPath) {
  return loadLibrary(userDataPath).configs.map(clone);
}

export function getVoiceConfig(userDataPath, id) {
  validateId(id);
  const config = loadLibrary(userDataPath).configs.find((entry) => entry.id === id);
  if (!config) throw new Error('Voice configuration not found.');
  return clone(config);
}

export function createVoiceConfig(userDataPath, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid voice configuration.');
  }
  for (const key of Object.keys(input)) {
    if (key !== 'name' && key !== 'providerId' && !SETTINGS_FIELDS.includes(key)) {
      throw new Error(`Unknown voice configuration field '${key}'.`);
    }
  }
  const library = loadLibrary(userDataPath);
  const name = validateName(input.name);
  assertUniqueName(library.configs, name);
  const timestamp = nowIso();
  const config = {
    id: newId(),
    name,
    providerId: input.providerId === undefined ? PROVIDER_GEMINI_TTS : validateProviderId(input.providerId),
    ...validateSettings({
      model: input.model,
      voice: input.voice,
      voiceDirection: input.voiceDirection,
      credentialId: input.credentialId,
    }),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  saveLibrary(userDataPath, { configs: [...library.configs, validateStoredConfig(config)] });
  return clone(config);
}

export function updateVoiceConfig(userDataPath, id, patch = {}) {
  validateId(id);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('Invalid voice configuration update.');
  }
  for (const key of Object.keys(patch)) {
    if (key !== 'name' && key !== 'providerId' && !SETTINGS_FIELDS.includes(key)) {
      throw new Error(`Unknown voice configuration field '${key}'.`);
    }
  }
  const library = loadLibrary(userDataPath);
  const current = library.configs.find((entry) => entry.id === id);
  if (!current) throw new Error('Voice configuration not found.');
  const next = { ...current };
  if (patch.name !== undefined) {
    const name = validateName(patch.name);
    assertUniqueName(library.configs, name, id);
    next.name = name;
  }
  if (patch.providerId !== undefined) next.providerId = validateProviderId(patch.providerId);
  const settingsPatch = {};
  for (const field of SETTINGS_FIELDS) {
    if (patch[field] !== undefined) settingsPatch[field] = patch[field];
  }
  if (Object.keys(settingsPatch).length > 0) {
    // Explicit null clears credentialId only; the triple stays complete.
    const candidate = {
      model: settingsPatch.model !== undefined ? settingsPatch.model : current.model,
      voice: settingsPatch.voice !== undefined ? settingsPatch.voice : current.voice,
      voiceDirection: settingsPatch.voiceDirection !== undefined ? settingsPatch.voiceDirection : current.voiceDirection,
      credentialId: settingsPatch.credentialId !== undefined ? settingsPatch.credentialId : current.credentialId,
    };
    Object.assign(next, validateSettings(candidate));
  }
  next.updatedAt = nowIso();
  const validated = validateStoredConfig(next);
  saveLibrary(userDataPath, {
    configs: library.configs.map((entry) => (entry.id === id ? validated : entry)),
  });
  return clone(validated);
}

export function deleteVoiceConfig(userDataPath, id) {
  validateId(id);
  const library = loadLibrary(userDataPath);
  if (!library.configs.some((entry) => entry.id === id)) {
    throw new Error('Voice configuration not found.');
  }
  // Projects hold copies of applied settings, never references, so no
  // reference guard is needed: deleting a preset cannot orphan a run.
  saveLibrary(userDataPath, { configs: library.configs.filter((entry) => entry.id !== id) });
  return { deleted: true, id };
}
