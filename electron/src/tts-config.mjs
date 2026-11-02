// TTS voice-configuration model (Electron main process).
//
// Pure helpers shared by settings storage, project storage, IPC, and run
// resolution. No filesystem, no Electron, no child processes here, so plain
// `node --test` can cover every rule.
//
// Precedence (highest wins): project override > global default > application
// default (the pinned catalogue defaults from `python/tts_catalog.py`).
// Every layer is partial: a null field inherits from the layer below, and a
// credentialId of null means "no TTS credential selected" (an actionable
// error at preview/run time, never a silent fallback).
//
// Bounds mirror the Python validators (`tts/config.py`); Python stays the
// authoritative gate at synthesis time and the worker re-validates argv.

export const TTS_CONFIG_BOUNDS = Object.freeze({
  modelMaxLength: 200,
  voiceMaxLength: 64,
  voiceDirectionMaxLength: 500,
  credentialIdMaxLength: 64,
});

// Renderer/main guard for preview and custom-text input. The Gemini client
// imposes no text cap; this bounds paid preview cost and spawn latency.
export const TTS_PREVIEW_TEXT_MAX_LENGTH = 500;

// Stable worker/setup handoff for the TTS key (mirrors Python
// TTS_API_KEY_ENV_VAR). The key travels process-locally in the child
// environment only — never argv, IPC, files, or logs.
export const TTS_API_KEY_ENV_VAR = 'AI_COMMENTATOR_PROVIDER_API_KEY';

export const TTS_CONFIG_FIELDS = Object.freeze([
  'model',
  'voice',
  'voiceDirection',
  'credentialId',
]);

export function emptyTtsConfig() {
  return { model: null, voice: null, voiceDirection: null, credentialId: null };
}

function assertOptionalText(value, field, maxLength) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength) {
    throw new Error(`Invalid TTS configuration field '${field}'.`);
  }
  return value;
}

/**
 * Normalize one partial TTS layer. Accepts null/undefined (full inherit),
 * an object with any subset of fields (missing means inherit), and trims
 * voice/direction whitespace exactly like the Python validators. Model and
 * credentialId keep their stored spelling; membership/purpose are checked
 * against the live catalogue and vault wherever the layer is used.
 */
export function normalizePartialTtsConfig(value) {
  if (value === null || value === undefined) return emptyTtsConfig();
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid TTS configuration.');
  }
  for (const field of Object.keys(value)) {
    if (!TTS_CONFIG_FIELDS.includes(field)) {
      throw new Error(`Unknown TTS configuration field '${field}'.`);
    }
  }
  const model = assertOptionalText(value.model, 'model', TTS_CONFIG_BOUNDS.modelMaxLength);
  const voice = assertOptionalText(value.voice, 'voice', TTS_CONFIG_BOUNDS.voiceMaxLength);
  const voiceDirection = assertOptionalText(
    value.voiceDirection, 'voiceDirection', TTS_CONFIG_BOUNDS.voiceDirectionMaxLength,
  );
  const credentialId = assertOptionalText(
    value.credentialId, 'credentialId', TTS_CONFIG_BOUNDS.credentialIdMaxLength,
  );
  return {
    model,
    voice: voice === null ? null : voice.trim(),
    voiceDirection: voiceDirection === null ? null : voiceDirection.trim(),
    credentialId,
  };
}

/**
 * Validate the untrusted catalogue probe document (`python/tts_catalog.py`).
 * Returns the normalized catalogue; throws on any shape violation so a
 * corrupt probe can never feed pickers or membership checks.
 */
export function normalizeTtsCatalog(value) {
  if (!value || typeof value !== 'object' || value.ok !== true) {
    throw new Error('TTS catalogue is unavailable.');
  }
  const models = Array.isArray(value.models) ? value.models : null;
  const voices = Array.isArray(value.voices) ? value.voices : null;
  const defaults = value.defaults && typeof value.defaults === 'object' ? value.defaults : null;
  const limits = value.limits && typeof value.limits === 'object' ? value.limits : null;
  if (!models || models.length === 0 || !voices || voices.length === 0 || !defaults || !limits) {
    throw new Error('TTS catalogue is incomplete.');
  }
  for (const model of models) {
    if (!model || typeof model.id !== 'string' || model.id.trim() === '') {
      throw new Error('TTS catalogue has an invalid model.');
    }
  }
  for (const voice of voices) {
    if (!voice || typeof voice.id !== 'string' || voice.id.trim() === '') {
      throw new Error('TTS catalogue has an invalid voice.');
    }
  }
  for (const field of ['model', 'voice', 'voiceDirection']) {
    if (typeof defaults[field] !== 'string' || defaults[field].trim() === '') {
      throw new Error('TTS catalogue has invalid defaults.');
    }
  }
  if (!models.some((model) => model.id === defaults.model)) {
    throw new Error('TTS catalogue default model is not listed.');
  }
  if (!voices.some((voice) => voice.id === defaults.voice)) {
    throw new Error('TTS catalogue default voice is not listed.');
  }
  return {
    models: models.map((model) => ({
      id: model.id,
      description: typeof model.description === 'string' ? model.description : '',
    })),
    voices: voices.map((voice) => ({
      id: voice.id,
      character: typeof voice.character === 'string' ? voice.character : '',
    })),
    defaults: {
      model: defaults.model,
      voice: defaults.voice,
      voiceDirection: defaults.voiceDirection,
    },
    limits: {
      voiceMaxLength: limits.voiceMaxLength,
      voiceDirectionMaxLength: limits.voiceDirectionMaxLength,
    },
  };
}

function pickLayer(projectValue, globalValue) {
  if (projectValue !== null && projectValue !== undefined) return { value: projectValue, source: 'project' };
  if (globalValue !== null && globalValue !== undefined) return { value: globalValue, source: 'global' };
  return { value: null, source: 'appDefault' };
}

/**
 * Resolve the effective configuration: project override > global default >
 * application (catalogue) default. `projectTts`/`globalTts` are partial
 * layers (null fields inherit). The resolved model must be a catalogue
 * member — no silent substitution. Returns `{ config, sources,
 * credentialId, credentialSource }`.
 */
export function resolveTtsConfig({ catalog, globalTts = null, projectTts = null } = {}) {
  if (!catalog || !Array.isArray(catalog.models) || !catalog.defaults) {
    throw new Error('TTS catalogue is required to resolve configuration.');
  }
  const global = normalizePartialTtsConfig(globalTts);
  const project = normalizePartialTtsConfig(projectTts);
  const model = pickLayer(project.model, global.model);
  const voice = pickLayer(project.voice, global.voice);
  const voiceDirection = pickLayer(project.voiceDirection, global.voiceDirection);
  const resolved = {
    model: model.value ?? catalog.defaults.model,
    voice: voice.value ?? catalog.defaults.voice,
    voiceDirection: voiceDirection.value ?? catalog.defaults.voiceDirection,
  };
  if (!catalog.models.some((entry) => entry.id === resolved.model)) {
    throw new Error(`Unsupported TTS model '${resolved.model}'.`);
  }
  const credential = pickLayer(project.credentialId, global.credentialId);
  return {
    config: resolved,
    sources: { model: model.source, voice: voice.source, voiceDirection: voiceDirection.source },
    credentialId: credential.value,
    credentialSource: credential.value === null ? null : credential.source,
  };
}

/**
 * Validate renderer-supplied preview/custom-test text: non-empty,
 * bounded for cost. Leading dashes are rejected because the text
 * travels as a positional argv token to `tts_say.py`, where a leading
 * dash would parse as a flag. The synthesis client performs no text
 * shaping.
 */
export function normalizePreviewText(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('Preview text must not be empty.');
  }
  if (value.startsWith('-')) {
    throw new Error('Preview text must not start with a dash.');
  }
  if (value.length > TTS_PREVIEW_TEXT_MAX_LENGTH) {
    throw new Error(`Preview text must be under ${TTS_PREVIEW_TEXT_MAX_LENGTH + 1} characters.`);
  }
  return value;
}
