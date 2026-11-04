// Game prompt packs (Electron main process only).
//
// Factory packs ship with the application: the Python `prompt_packs.py`
// probe is the single source of truth for factory wording and field
// metadata, loaded once per session and cached. The renderer must never
// hardcode its own copy. User customizations overlay individual fields
// (`prompt-packs.json`, custom text only) and never modify the factory
// defaults: resetting a field or pack means deleting the overlay.
//
// Pack *selection* is per project (`project.json` `configuration`
// `promptPackId`, null = application default); custom *wording* is a
// shared global resource like the game library. Python re-validates the
// pack id and every custom field authoritatively at run time.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolvePythonTool } from './worker-protocol.mjs';

export const PROMPT_PACKS_VERSION = 1;
export const PROMPT_PACKS_FILE_NAME = 'prompt-packs.json';
export const PROMPT_PACK_SCHEMA_VERSION = 'game-pack-v1';
export const DEFAULT_PROMPT_PACK_ID = 'free-fire';

/**
 * Default prompt pack per project game, used only when the project has
 * no explicit `promptPackId` selection. Unknown games fall back to the
 * application default so a null selection never throws.
 */
export const GAME_DEFAULT_PACK_IDS = {
  'free-fire': 'free-fire',
  cod: 'cod',
  bgmi: 'bgmi',
};

export function defaultPackIdForGame(gameId) {
  if (typeof gameId === 'string') {
    const mapped = GAME_DEFAULT_PACK_IDS[gameId];
    if (typeof mapped === 'string') return mapped;
  }
  return DEFAULT_PROMPT_PACK_ID;
}

export const PROMPT_PACK_LOADER_TIMEOUT_MS = 25000;
const MAX_OUTPUT_CHARS = 262144;
const MAX_FACTORY_PACKS = 16;
const MAX_FACTORY_FIELD_CHARS = 8192;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function validateId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new Error('Invalid prompt pack id.');
  return id;
}

export function promptPacksScript(repoRoot) {
  return path.join(repoRoot, 'python', 'prompt_packs.py');
}

/**
 * Validate the untrusted probe document; return normalized factory data:
 * `{ schemaVersion, defaultPackId, fieldMeta, packs }`. Anything outside
 * the contract is rejected so the renderer can never render unvalidated
 * content as factory prompts.
 */
export function normalizeFactoryPacks(doc) {
  if (!doc || typeof doc !== 'object' || doc.ok !== true) {
    throw new Error('Prompt packs returned an invalid response.');
  }
  if (doc.schema_version !== PROMPT_PACK_SCHEMA_VERSION) {
    throw new Error('Prompt packs returned an unsupported schema.');
  }
  if (typeof doc.default_pack_id !== 'string' || !ID_PATTERN.test(doc.default_pack_id)) {
    throw new Error('Prompt packs returned an invalid default.');
  }
  if (!doc.fields || typeof doc.fields !== 'object' || Array.isArray(doc.fields)) {
    throw new Error('Prompt packs returned invalid field metadata.');
  }
  const fieldMeta = {};
  for (const [key, meta] of Object.entries(doc.fields)) {
    if (!ID_PATTERN.test(key) || !meta || typeof meta !== 'object') {
      throw new Error('Prompt packs returned invalid field metadata.');
    }
    if (typeof meta.label !== 'string' || meta.label.trim() === '') {
      throw new Error('Prompt packs returned invalid field metadata.');
    }
    if (!Number.isInteger(meta.max_chars) || meta.max_chars < 1 || meta.max_chars > MAX_FACTORY_FIELD_CHARS) {
      throw new Error('Prompt packs returned invalid field metadata.');
    }
    fieldMeta[key] = {
      label: meta.label,
      description: typeof meta.description === 'string' ? meta.description : '',
      maxChars: meta.max_chars,
    };
  }
  if (Object.keys(fieldMeta).length === 0) {
    throw new Error('Prompt packs returned no editable fields.');
  }
  if (!Array.isArray(doc.packs) || doc.packs.length === 0 || doc.packs.length > MAX_FACTORY_PACKS) {
    throw new Error('Prompt packs returned an invalid pack list.');
  }
  const packs = doc.packs.map((pack) => {
    if (!pack || typeof pack !== 'object') throw new Error('Prompt packs returned an invalid pack.');
    validateId(pack.pack_id);
    if (typeof pack.display_name !== 'string' || pack.display_name.trim() === '') {
      throw new Error('Prompt packs returned an invalid pack.');
    }
    if (!pack.fields || typeof pack.fields !== 'object' || Array.isArray(pack.fields)) {
      throw new Error('Prompt packs returned an invalid pack.');
    }
    const fields = {};
    for (const key of Object.keys(fieldMeta)) {
      const text = pack.fields[key];
      if (typeof text !== 'string' || text.length > MAX_FACTORY_FIELD_CHARS) {
        throw new Error('Prompt packs returned an invalid pack.');
      }
      if (key !== 'game_context' && text.trim() === '') {
        throw new Error('Prompt packs returned an invalid pack.');
      }
      fields[key] = text;
    }
    return {
      packId: pack.pack_id,
      displayName: pack.display_name,
      version: pack.version ?? 1,
      fields,
    };
  });
  const ids = new Set(packs.map((pack) => pack.packId));
  if (ids.size !== packs.length) throw new Error('Prompt packs returned duplicate pack ids.');
  if (!ids.has(doc.default_pack_id)) throw new Error('Prompt packs returned an unknown default pack.');
  return { schemaVersion: doc.schema_version, defaultPackId: doc.default_pack_id, fieldMeta, packs };
}

/** Parse bounded probe stdout: the last line must be the packs JSON. */
export function parsePacksOutput(output) {
  const line = String(output ?? '').trim().split(/\r?\n/).at(-1) ?? '';
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error('Prompt packs returned an invalid response.');
  }
  return normalizeFactoryPacks(parsed);
}

function runProbe({ executable, args, cwd, spawnFn, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn(executable, args, {
        stdio: ['ignore', 'pipe', 'ignore'],
        ...(cwd ? { cwd } : {}),
      });
    } catch {
      reject(new Error('Could not start the prompt packs probe.'));
      return;
    }
    let output = '';
    let settled = false;
    const finish = (fn) => (...args) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn(...args);
    };
    const done = finish(resolve);
    const fail = finish(reject);
    const timeout = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      fail(new Error('Prompt packs request timed out.'));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      output += String(chunk).slice(0, MAX_OUTPUT_CHARS - output.length);
    });
    child.on('error', () => fail(new Error('Could not start the prompt packs probe.')));
    child.on('close', (code) => {
      if (code !== 0) {
        fail(new Error('Prompt packs probe failed. Check the Python environment.'));
        return;
      }
      try {
        done(parsePacksOutput(output));
      } catch (err) {
        fail(err);
      }
    });
  });
}

export function createPromptPackLoader({ repoRoot, runtimeContext = null, spawnFn = spawn, timeoutMs = PROMPT_PACK_LOADER_TIMEOUT_MS } = {}) {
  let cached = null;
  return {
    async load() {
      if (cached) return cached;
      const root = typeof repoRoot === 'function' ? repoRoot() : repoRoot;
      const runtime = typeof runtimeContext === 'function'
        ? runtimeContext()
        : { repoRoot: root, isPackaged: false, platform: process.platform };
      const launch = resolvePythonTool({ tool: 'prompt-packs', ...runtime, repoRoot: runtime.repoRoot ?? root });
      if (!launch.executable) {
        if (launch.reason === 'missing-resource') {
          throw new Error(`Bundled Python runtime not found at ${launch.missing}.`);
        }
        throw new Error('Python virtual environment is not configured.');
      }
      cached = await runProbe({
        executable: launch.executable,
        args: launch.argsPrefix,
        cwd: launch.cwd,
        spawnFn,
        timeoutMs,
      });
      return cached;
    },
    reset() {
      cached = null;
    },
  };
}

export function promptPacksPath(userDataPath) {
  return path.join(userDataPath, PROMPT_PACKS_FILE_NAME);
}

function validateCustomText(fieldMeta, field, value) {
  const meta = fieldMeta[field];
  if (!meta) throw new Error(`Unknown prompt field ${field}.`);
  if (typeof value !== 'string') throw new Error(`Invalid prompt text for ${meta.label}.`);
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > meta.maxChars) {
    throw new Error(`${meta.label} exceeds ${meta.maxChars} characters.`);
  }
  return trimmed;
}

function loadCustomStore(userDataPath, fieldMeta) {
  const file = promptPacksPath(userDataPath);
  if (!fs.existsSync(file)) {
    return { version: PROMPT_PACKS_VERSION, custom: {} };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error('The prompt packs store is corrupted and cannot be read.');
  }
  if (!parsed || typeof parsed !== 'object' || parsed.version !== PROMPT_PACKS_VERSION) {
    throw new Error('The prompt packs store is corrupted and cannot be read.');
  }
  const custom = {};
  const raw = parsed.custom && typeof parsed.custom === 'object' ? parsed.custom : {};
  for (const [packId, fields] of Object.entries(raw)) {
    if (!ID_PATTERN.test(packId) || !fields || typeof fields !== 'object' || Array.isArray(fields)) {
      throw new Error('The prompt packs store is corrupted and cannot be read.');
    }
    // A null fieldMeta means the factory probe is unavailable (run path
    // only): pass entries through structurally so Python — the
    // authoritative validator — rejects bad values loudly instead of
    // the main process silently dropping them.
    if (fieldMeta === null) {
      custom[packId] = { ...fields };
      continue;
    }
    const cleaned = {};
    for (const [field, value] of Object.entries(fields)) {
      const text = validateCustomText(fieldMeta, field, value);
      if (text !== null) cleaned[field] = text;
    }
    if (Object.keys(cleaned).length > 0) custom[packId] = cleaned;
  }
  return { version: PROMPT_PACKS_VERSION, custom };
}

function saveCustomStore(userDataPath, custom) {
  const target = promptPacksPath(userDataPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify({ version: PROMPT_PACKS_VERSION, custom }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, target);
  } finally {
    if (fs.existsSync(temp)) {
      try { fs.unlinkSync(temp); } catch { /* best effort */ }
    }
  }
}

/**
 * List factory packs with customization state. `factory` is the loaded
 * probe document. Each entry carries factory `fields`, the `customized`
 * field list, and `effective` (factory + custom overlay) for display.
 */
export function listPromptPacks(userDataPath, factory) {
  const { custom } = loadCustomStore(userDataPath, factory.fieldMeta);
  return factory.packs.map((pack) => {
    const overlay = custom[pack.packId] ?? {};
    const customized = Object.keys(overlay);
    return {
      packId: pack.packId,
      displayName: pack.displayName,
      version: pack.version,
      fields: { ...pack.fields },
      customized,
      effective: { ...pack.fields, ...overlay },
    };
  });
}

export function getPromptPack(userDataPath, factory, packId) {
  validateId(packId);
  const pack = listPromptPacks(userDataPath, factory).find((entry) => entry.packId === packId);
  if (!pack) throw new Error('Prompt pack not found.');
  return pack;
}

/**
 * Save one custom field. Empty text deletes the overlay (reset that
 * field to factory). Returns the updated pack view.
 */
export function setPromptField(userDataPath, factory, packId, field, text) {
  validateId(packId);
  if (!factory.packs.some((pack) => pack.packId === packId)) {
    throw new Error('Prompt pack not found.');
  }
  if (typeof field !== 'string' || !factory.fieldMeta[field]) {
    throw new Error('Unknown prompt field.');
  }
  const store = loadCustomStore(userDataPath, factory.fieldMeta);
  const cleaned = validateCustomText(factory.fieldMeta, field, text);
  const next = { ...store.custom };
  if (cleaned === null) {
    if (next[packId]) {
      const fields = { ...next[packId] };
      delete fields[field];
      if (Object.keys(fields).length === 0) delete next[packId];
      else next[packId] = fields;
    }
  } else {
    next[packId] = { ...(next[packId] ?? {}), [field]: cleaned };
  }
  saveCustomStore(userDataPath, next);
  return getPromptPack(userDataPath, factory, packId);
}

/** Delete every custom field of one pack (reset to factory defaults). */
export function resetPromptPack(userDataPath, factory, packId) {
  validateId(packId);
  if (!factory.packs.some((pack) => pack.packId === packId)) {
    throw new Error('Prompt pack not found.');
  }
  const store = loadCustomStore(userDataPath, factory.fieldMeta);
  if (store.custom[packId]) {
    const next = { ...store.custom };
    delete next[packId];
    saveCustomStore(userDataPath, next);
  }
  return getPromptPack(userDataPath, factory, packId);
}

/**
 * Resolve the run snapshot for a project's pack selection: `{ packId,
 * custom }` for `AI_COMMENTATOR_SETTINGS_JSON.promptPack`. A null/blank
 * selection means the project game's default pack (see
 * `GAME_DEFAULT_PACK_IDS`; unknown games use the application default).
 * An explicit id always wins over the game default. `factory` may be null when
 * the probe is unavailable: customs pass through and Python validates
 * the pack id and every custom field again before any paid call.
 */
export function buildPackSnapshot(userDataPath, factory, promptPackId, gameId = null) {
  let packId = defaultPackIdForGame(gameId);
  if (typeof promptPackId === 'string' && promptPackId.trim() !== '') {
    validateId(promptPackId);
    packId = promptPackId;
  } else if (promptPackId !== null && promptPackId !== undefined) {
    throw new Error('Invalid prompt pack selection.');
  }
  const { custom } = loadCustomStore(userDataPath, factory ? factory.fieldMeta : null);
  return { packId, custom: { ...(custom[packId] ?? {}) } };
}
