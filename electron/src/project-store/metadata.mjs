import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { validateVideoInput } from '../worker-protocol.mjs';
import { normalizePartialTtsConfig } from '../tts-config.mjs';
import { DEFAULT_GAME_ID as CATALOG_DEFAULT_GAME_ID, SUPPORTED_GAME_IDS as CATALOG_GAME_IDS } from '../lib/games.js';

export const SCHEMA_VERSION = 1;
export const PROJECTS_DIR_NAME = 'projects';
export const DELETION_QUARANTINE_DIR_NAME = '.deleted';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_NAME_LENGTH = 100;
const CONFIGURATION_FIELDS = new Set(['credentialId', 'game', 'promptPackId', 'tts']);

// Project-owned game metadata. Supported games mirror the loaded
// prompt packs (see lib/games.js); per-game suggestion lists live
// there, while storage keeps bounded free text so legacy projects
// always read back.
export const SUPPORTED_GAME_IDS = CATALOG_GAME_IDS;
export const DEFAULT_GAME_ID = CATALOG_DEFAULT_GAME_ID;
export const DEFAULT_GAME_LANGUAGE = 'English';
// Commentary voice formerly owned by the built-in preset. The worker
// still receives these verbatim, so runs behave exactly as before.
export const DEFAULT_COMMENTARY_PERSONALITY = 'Esports commentator';
export const DEFAULT_COMMENTARY_TONE = 'energetic';
const GAME_TEXT_MAX = 80;
const GAME_CONTEXT_MAX = 2000;
const GAME_TEAMS_MAX = 8;

export function defaultGameMetadata() {
  return {
    id: DEFAULT_GAME_ID,
    matchType: null,
    mode: null,
    map: null,
    category: null,
    teams: [],
    tournament: null,
    stage: null,
    language: DEFAULT_GAME_LANGUAGE,
    additionalContext: '',
  };
}

function cleanGameText(value, { required = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw new Error('Invalid game metadata.');
    return null;
  }
  if (typeof value !== 'string') throw new Error('Invalid game metadata.');
  const trimmed = value.trim();
  if (trimmed === '') {
    if (required) throw new Error('Invalid game metadata.');
    return null;
  }
  if (trimmed.length > GAME_TEXT_MAX) throw new Error('Invalid game metadata.');
  return trimmed;
}

/**
 * Validate project-owned game metadata, filling defaults for omitted
 * optional fields. Accepts partial input (creation and patch flows);
 * unknown game ids are rejected — unsupported games must never reach
 * a run.
 */
export function normalizeGameMetadata(value) {
  if (!value || typeof value !== 'object') throw new Error('Invalid game metadata.');
  const id = value.id ?? DEFAULT_GAME_ID;
  if (!SUPPORTED_GAME_IDS.includes(id)) throw new Error('Invalid game metadata.');
  const teams = value.teams ?? [];
  if (!Array.isArray(teams) || teams.length > GAME_TEAMS_MAX) {
    throw new Error('Invalid game metadata.');
  }
  const cleanTeams = [];
  for (const entry of teams) {
    const cleaned = cleanGameText(entry);
    if (cleaned !== null) cleanTeams.push(cleaned);
  }
  let additionalContext = '';
  if (value.additionalContext !== null && value.additionalContext !== undefined && value.additionalContext !== '') {
    if (typeof value.additionalContext !== 'string') throw new Error('Invalid game metadata.');
    additionalContext = value.additionalContext.trim();
    if (additionalContext.length > GAME_CONTEXT_MAX) throw new Error('Invalid game metadata.');
  }
  return {
    id,
    matchType: cleanGameText(value.matchType),
    mode: cleanGameText(value.mode),
    map: cleanGameText(value.map),
    category: cleanGameText(value.category),
    teams: cleanTeams,
    tournament: cleanGameText(value.tournament),
    stage: cleanGameText(value.stage),
    language: cleanGameText(value.language) ?? DEFAULT_GAME_LANGUAGE,
    additionalContext,
  };
}

/**
 * Compose the bounded worker game-context string from project-owned
 * metadata. Only populated fields flow; structured fields come first
 * (mode, match, map, category, tournament, stage, legacy teams) and
 * the labeled free-form notes last. The bound only ever trims the
 * tail. Missing values stay unknown — nothing is defaulted here.
 */
export function composeGameContext(game) {
  const parts = [];
  if (game?.mode) parts.push(`Mode: ${game.mode}.`);
  if (game?.matchType) parts.push(`Match: ${game.matchType}.`);
  if (game?.map) parts.push(`Map: ${game.map}.`);
  if (game?.category) parts.push(`Category: ${game.category}.`);
  if (game?.tournament) parts.push(`Tournament: ${game.tournament}.`);
  if (game?.stage) parts.push(`Stage: ${game.stage}.`);
  if (Array.isArray(game?.teams) && game.teams.length > 0) {
    parts.push(`Teams: ${game.teams.join(' vs ')}.`);
  }
  if (game?.additionalContext) parts.push(`Notes: ${game.additionalContext}`);
  return parts.join(' ').slice(0, GAME_CONTEXT_MAX);
}

/**
 * Non-secret worker preferences from project-owned game metadata.
 * `game.metadata` carries the normalized structured fields (additive:
 * older readers use `id`/`context` only) so the engine can word a
 * project-aware opening introduction from real values instead of
 * parsing the composed context string. Personality/tone mirror the
 * retired built-in preset; language follows the project.
 */
export function buildWorkerPreferences(game) {
  const normalized = normalizeGameMetadata(game ?? {});
  return {
    game: {
      id: normalized.id,
      context: composeGameContext(normalized),
      metadata: {
        matchType: normalized.matchType,
        mode: normalized.mode,
        map: normalized.map,
        category: normalized.category,
        teams: [...normalized.teams],
        tournament: normalized.tournament,
        stage: normalized.stage,
        additionalContext: normalized.additionalContext,
      },
    },
    prompt: {
      personality: DEFAULT_COMMENTARY_PERSONALITY,
      tone: DEFAULT_COMMENTARY_TONE,
      language: normalized.language,
      instructions: '',
    },
  };
}

const GAME_LIBRARY_FILE = 'game-library.json';
const LEGACY_DEFAULT_PROFILE_ID = 'free-fire-default';

/**
 * Tolerant read of one legacy library record. The retired game library
 * file is never written or deleted anymore; this exists only to carry
 * custom match context and commentary language into project-owned
 * metadata on first read. Anything unexpected yields null (defaults).
 */
function readLegacyLibraryEntry(userDataPath, kind, id) {
  try {
    if (typeof userDataPath !== 'string' || typeof id !== 'string' || id === '') return null;
    const raw = fs.readFileSync(path.join(userDataPath, GAME_LIBRARY_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    const entries = kind === 'profile' ? parsed?.profiles : parsed?.presets;
    if (!Array.isArray(entries)) return null;
    const entry = entries.find((candidate) => candidate?.id === id);
    return entry && typeof entry === 'object' ? entry : null;
  } catch {
    return null;
  }
}

function migrateLegacyGameConfig(userDataPath, value) {
  const game = defaultGameMetadata();
  const profileId = typeof value.gameProfileId === 'string' ? value.gameProfileId : null;
  if (profileId && profileId !== LEGACY_DEFAULT_PROFILE_ID) {
    const profile = readLegacyLibraryEntry(userDataPath, 'profile', profileId);
    const context = typeof profile?.context === 'string' ? profile.context.trim() : '';
    if (context !== '') game.additionalContext = context.slice(0, GAME_CONTEXT_MAX);
    if (profile && typeof profile.gameId === 'string' && SUPPORTED_GAME_IDS.includes(profile.gameId)) {
      game.id = profile.gameId;
    }
  }
  const presetId = typeof value.commentaryPresetId === 'string' ? value.commentaryPresetId : null;
  if (presetId && presetId !== 'default-energetic') {
    const preset = readLegacyLibraryEntry(userDataPath, 'preset', presetId);
    const language = typeof preset?.language === 'string' ? preset.language.trim() : '';
    if (language !== '') game.language = language.slice(0, GAME_TEXT_MAX);
  }
  return game;
}
const PATCHABLE_FIELDS = new Set(['processingStatus', 'lastOpenedAt', 'configuration']);
const PROCESSING_STATUSES = new Set(['idle', 'processing', 'done', 'stopped', 'error', 'cancelled', 'interrupted']);

// Transient filesystem failures worth retrying with backoff: a locked
// media file (EBUSY/EPERM/EACCES on Windows) or a directory that cannot
// be removed while a handle is still draining (ENOTEMPTY).
const DELETION_RETRYABLE_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES']);
const DELETION_MAX_ATTEMPTS = 6;
const DELETION_BASE_DELAY_MS = 50;
const DELETION_BACKGROUND_DELAYS_MS = [2000, 5000, 10000];

// In-flight deletions, keyed by project id. The main process is the only
// writer, so an in-memory guard is sufficient to serialize concurrent
// delete/open/update/export/run requests for the same project.
const deletionLocks = new Set();

export function isProjectDeletionLocked(id) {
  return deletionLocks.has(id);
}

export function getProjectsRoot(userDataPath) {
  return path.join(userDataPath, PROJECTS_DIR_NAME);
}

function assertId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new Error('Invalid project id.');
}

export function resolveProjectDir(projectsRoot, id) {
  assertId(id);
  const dir = path.join(projectsRoot, id);
  const relative = path.relative(projectsRoot, dir);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid project id.');
  return dir;
}

function slugify(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return slug || 'project';
}

function validateName(name) {
  if (typeof name !== 'string') throw new Error('Project name must be a string.');
  const trimmed = name.trim();
  if (trimmed === '') throw new Error('Project name must not be empty.');
  if (trimmed.length > MAX_NAME_LENGTH) throw new Error('Project name is too long.');
  return trimmed;
}

function validateConfiguration(value, userDataPath = null) {
  if (!value || typeof value !== 'object') throw new Error('Invalid project configuration.');
  // Older projects may store a partial configuration object (e.g. only
  // credentialId). Missing selections fall back to defaults at read
  // time instead of failing the whole project load; the stored file is
  // only rewritten on the next explicit configuration save.
  const {
    credentialId = null,
    promptPackId = null,
  } = value;
  if (credentialId !== null && (typeof credentialId !== 'string' || !ID_PATTERN.test(credentialId))) {
    throw new Error('Invalid project configuration.');
  }
  // Null means the application default pack (Free Fire factory wording),
  // so projects saved before prompt packs keep their exact behavior.
  if (promptPackId !== null && (typeof promptPackId !== 'string' || !ID_PATTERN.test(promptPackId))) {
    throw new Error('Invalid project configuration.');
  }
  let game;
  if (value.game === null || value.game === undefined) {
    // Legacy configs carried profile/preset IDs instead of owned
    // metadata: migrate once (custom context and language survive),
    // then drop the obsolete references. Idempotent: migrated configs
    // carry `game` and never take this path again.
    game = (value.gameProfileId !== null && value.gameProfileId !== undefined)
      || (value.commentaryPresetId !== null && value.commentaryPresetId !== undefined)
      ? migrateLegacyGameConfig(userDataPath, value)
      : defaultGameMetadata();
  } else {
    game = normalizeGameMetadata(value.game);
  }
  return {
    credentialId,
    game,
    promptPackId,
    tts: normalizePartialTtsConfig(value.tts ?? null),
  };
}

export function defaultProjectConfiguration() {
  return {
    credentialId: null,
    game: defaultGameMetadata(),
    promptPackId: null,
    tts: { model: null, voice: null, voiceDirection: null, credentialId: null },
  };
}

function validateMetadata(value, userDataPath = null) {
  if (!value || typeof value !== 'object') throw new Error('Invalid project metadata.');
  assertId(value.id);
  validateName(value.name);
  if (value.schemaVersion !== SCHEMA_VERSION) throw new Error('Unsupported project version.');
  for (const key of ['createdAt', 'updatedAt', 'lastOpenedAt']) {
    if (typeof value[key] !== 'string' || Number.isNaN(Date.parse(value[key]))) throw new Error('Invalid project timestamps.');
  }
  if (!value.sourceVideo || typeof value.sourceVideo.path !== 'string' || typeof value.sourceVideo.sizeBytes !== 'number') throw new Error('Invalid project source video.');
  if (!PROCESSING_STATUSES.has(value.processingStatus)) throw new Error('Invalid processing status.');
  value.configuration = validateConfiguration(value.configuration ?? defaultProjectConfiguration(), userDataPath);
  return value;
}

function writeAtomic(filePath, text) {
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, text);
  fs.renameSync(tmpPath, filePath);
}

function readMetadata(projectDir, userDataPath = null) {
  return validateMetadata(JSON.parse(fs.readFileSync(path.join(projectDir, 'project.json'), 'utf8')), userDataPath);
}

function toPublicMetadata(meta) {
  return {
    id: meta.id, name: meta.name, createdAt: meta.createdAt, updatedAt: meta.updatedAt,
    lastOpenedAt: meta.lastOpenedAt,
    sourceVideo: { path: meta.sourceVideo.path, sizeBytes: meta.sourceVideo.sizeBytes },
    processingStatus: meta.processingStatus, schemaVersion: meta.schemaVersion,
    configuration: { ...meta.configuration },
  };
}

export function listProjects(userDataPath) {
  const root = getProjectsRoot(userDataPath);
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch (err) { if (err?.code === 'ENOENT') return []; throw err; }
  const projects = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.tmp-')) continue;
    if (entry.name === DELETION_QUARANTINE_DIR_NAME) continue;
    try { projects.push(toPublicMetadata(readMetadata(path.join(root, entry.name), userDataPath))); } catch { continue; }
  }
  projects.sort((a, b) => {
    const key = (p) => p.lastOpenedAt || p.updatedAt || p.createdAt || '';
    return key(b).localeCompare(key(a));
  });
  return projects;
}

export function getProject(userDataPath, id) {
  return toPublicMetadata(readMetadata(resolveProjectDir(getProjectsRoot(userDataPath), id), userDataPath));
}

export function createProject(userDataPath, { name, sourcePath, game } = {}) {
  const cleanName = validateName(name);
  if (typeof sourcePath !== 'string' || sourcePath === '') throw new Error('A source video path is required.');
  const inputError = validateVideoInput(sourcePath);
  if (inputError) throw new Error(inputError);
  let stat = null;
  try { stat = fs.statSync(sourcePath); } catch { stat = null; }
  if (!stat || !stat.isFile()) throw new Error('The selected file could not be read.');
  const root = getProjectsRoot(userDataPath);
  fs.mkdirSync(root, { recursive: true });
  const slug = slugify(cleanName);
  let id = null;
  let finalDir = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = `${slug}-${crypto.randomBytes(3).toString('hex')}`;
    const candidateDir = path.join(root, candidate);
    if (!fs.existsSync(candidateDir)) { id = candidate; finalDir = candidateDir; break; }
  }
  if (!id) throw new Error('Could not allocate a project directory.');
  const stagingDir = path.join(root, `.tmp-${id}`);
  fs.rmSync(stagingDir, { recursive: true, force: true });
  try {
    const ext = path.extname(sourcePath).toLowerCase() || '.mp4';
    const sourceDir = path.join(stagingDir, 'source');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.mkdirSync(path.join(stagingDir, 'output'), { recursive: true });
    fs.mkdirSync(path.join(stagingDir, 'audio', 'commentary'), { recursive: true });
    const destVideo = path.join(sourceDir, `gameplay${ext}`);
    fs.copyFileSync(sourcePath, destVideo);
    const copied = fs.statSync(destVideo);
    const now = new Date().toISOString();
    const metadata = {
      schemaVersion: SCHEMA_VERSION, id, name: cleanName, createdAt: now, updatedAt: now, lastOpenedAt: now,
      sourceVideo: { path: path.join(finalDir, 'source', `gameplay${ext}`), sizeBytes: copied.size }, processingStatus: 'idle',
      configuration: validateConfiguration(
        { ...defaultProjectConfiguration(), ...(game === null || game === undefined ? {} : { game }) },
        userDataPath,
      ),
    };
    writeAtomic(path.join(stagingDir, 'project.json'), JSON.stringify(metadata, null, 2));
    fs.renameSync(stagingDir, finalDir);
    return toPublicMetadata(validateMetadata(metadata, userDataPath));
  } catch (err) { fs.rmSync(stagingDir, { recursive: true, force: true }); throw err; }
}

export function updateProject(userDataPath, id, patch = {}) {
  const dir = resolveProjectDir(getProjectsRoot(userDataPath), id);
  const meta = readMetadata(dir, userDataPath);
  if (!patch || typeof patch !== 'object') throw new Error('Invalid project update.');
  const next = { ...meta, sourceVideo: { ...meta.sourceVideo } };
  for (const [key, value] of Object.entries(patch)) {
    if (!PATCHABLE_FIELDS.has(key)) throw new Error(`Project field '${key}' cannot be updated.`);
    if (key === 'configuration') {
      if (!value || typeof value !== 'object') throw new Error('Invalid project configuration.');
      for (const field of Object.keys(value)) {
        if (!CONFIGURATION_FIELDS.has(field)) throw new Error(`Project field '${field}' cannot be updated.`);
      }
      next.configuration = validateConfiguration({ ...meta.configuration, ...value }, userDataPath);
      continue;
    }
    if (key === 'processingStatus' && !PROCESSING_STATUSES.has(value)) throw new Error('Invalid processing status.');
    if (key === 'lastOpenedAt' && (typeof value !== 'string' || Number.isNaN(Date.parse(value)))) throw new Error('Invalid timestamp.');
    next[key] = value;
  }
  next.updatedAt = new Date().toISOString();
  writeAtomic(path.join(dir, 'project.json'), JSON.stringify(validateMetadata(next, userDataPath), null, 2));
  return toPublicMetadata(next);
}

export function settleProjectRun(userDataPath, id, status) {
  if (!PROCESSING_STATUSES.has(status) || status === 'processing' || status === 'idle') throw new Error('Invalid settle status.');
  const meta = readMetadata(resolveProjectDir(getProjectsRoot(userDataPath), id), userDataPath);
  if (meta.processingStatus !== 'processing') return { settled: false, project: toPublicMetadata(meta) };
  return { settled: true, project: updateProject(userDataPath, id, { processingStatus: status }) };
}

export function reconcileInterruptedRuns(userDataPath) {
  const reconciled = [];
  for (const project of listProjects(userDataPath)) {
    if (project.processingStatus === 'processing') { settleProjectRun(userDataPath, project.id, 'interrupted'); reconciled.push(project.id); }
  }
  return reconciled;
}

export function openProject(userDataPath, id) { return updateProject(userDataPath, id, { lastOpenedAt: new Date().toISOString() }); }

function defaultSleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function defaultScheduleBackground(task, ms) {
  const timer = setTimeout(() => {
    Promise.resolve()
      .then(task)
      .catch((err) => {
        try { console.error('[project-store] background deletion cleanup failed:', err?.message ?? err); } catch { /* never break shutdown */ }
      });
  }, ms);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return timer;
}

function safeLog(logger, level, message) {
  try { logger?.[level]?.(message); } catch { /* logging must never break deletion */ }
}

async function withDeletionRetries(operation, sleep) {
  let lastError = null;
  for (let attempt = 1; attempt <= DELETION_MAX_ATTEMPTS; attempt += 1) {
    try {
      await operation();
      return attempt;
    } catch (err) {
      lastError = err;
      if (!DELETION_RETRYABLE_CODES.has(err?.code) || attempt === DELETION_MAX_ATTEMPTS) break;
      await sleep(DELETION_BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

function getQuarantineRoot(projectsRoot) {
  return path.join(projectsRoot, DELETION_QUARANTINE_DIR_NAME);
}

function readTombstoneRecord(fsModule, tombDir) {
  try {
    const record = JSON.parse(fsModule.readFileSync(path.join(tombDir, 'tombstone.json'), 'utf8'));
    if (record && typeof record === 'object' && typeof record.id === 'string') return record;
  } catch { /* missing or corrupt tombstone: still a candidate for removal */ }
  return null;
}

function readQuarantinedProjectRecord(fsModule, tombDir) {
  // Crash recovery: a project renamed into quarantine without its
  // tombstone still carries project.json with the real id.
  try {
    const meta = JSON.parse(fsModule.readFileSync(path.join(tombDir, 'project.json'), 'utf8'));
    if (meta && typeof meta.id === 'string') return { id: meta.id };
  } catch { /* partially removed tree: still a candidate for removal */ }
  return null;
}

function findTombstone(fsModule, projectsRoot, id) {
  let entries = [];
  try {
    entries = fsModule.readdirSync(getQuarantineRoot(projectsRoot), { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const tombDir = path.join(getQuarantineRoot(projectsRoot), entry.name);
    const record = readTombstoneRecord(fsModule, tombDir)
      ?? readQuarantinedProjectRecord(fsModule, tombDir);
    if (record && record.id === id) return { tombDir, record };
  }
  return null;
}

function writeTombstoneRecord(fsModule, tombDir, record) {
  fsModule.writeFileSync(path.join(tombDir, 'tombstone.json'), JSON.stringify(record, null, 2));
}

function lockedFilesError(id, err, phase) {
  const code = err?.code ?? 'unknown';
  const error = new Error(
    `Could not delete project '${id}': files are still in use (${code} during ${phase}). `
    + 'Close any playback of this project, wait a moment, then retry.',
  );
  error.code = err?.code;
  error.cause = err;
  return error;
}

function scheduleQuarantineCleanup({ fs: fsModule, sleep, logger, scheduleBackground, tombDir, record, delayIndex = 0 }) {
  if (delayIndex >= DELETION_BACKGROUND_DELAYS_MS.length) {
    safeLog(logger, 'error', `[project-store] background cleanup gave up for deleted project '${record.id}'; the startup sweep will retry.`);
    return;
  }
  scheduleBackground(async () => {
    try {
      await withDeletionRetries(
        () => fsModule.rmSync(tombDir, { recursive: true, force: true }),
        sleep,
      );
      safeLog(logger, 'info', `[project-store] background cleanup removed deleted project '${record.id}'.`);
    } catch (err) {
      try {
        writeTombstoneRecord(fsModule, tombDir, {
          ...record,
          attempts: (record.attempts ?? 0) + DELETION_MAX_ATTEMPTS,
          lastError: err?.message ?? String(err),
          lastCode: err?.code ?? null,
          updatedAt: new Date().toISOString(),
        });
      } catch { /* tombstone bookkeeping must not break the retry chain */ }
      scheduleQuarantineCleanup({ fs: fsModule, sleep, logger, scheduleBackground, tombDir, record, delayIndex: delayIndex + 1 });
    }
  }, DELETION_BACKGROUND_DELAYS_MS[delayIndex]);
}

export async function deleteProject(userDataPath, id, options = {}) {
  const {
    fs: fsModule = fs,
    sleep = defaultSleep,
    logger = console,
    scheduleBackground = defaultScheduleBackground,
  } = options ?? {};
  const projectsRoot = getProjectsRoot(userDataPath);
  const dir = resolveProjectDir(projectsRoot, id);
  if (deletionLocks.has(id)) {
    throw new Error(`Deletion already in progress for project '${id}'.`);
  }
  deletionLocks.add(id);
  try {
    // A previous attempt already quarantined this project: the logical
    // deletion stands, so report success (never "not found") and nudge
    // physical cleanup once more.
    const resumed = findTombstone(fsModule, projectsRoot, id);
    if (resumed) {
      scheduleQuarantineCleanup({ fs: fsModule, sleep, logger, scheduleBackground, tombDir: resumed.tombDir, record: resumed.record });
      return { deleted: true, id, alreadyDeleted: true, cleanup: 'pending' };
    }
    if (!fsModule.existsSync(path.join(dir, 'project.json'))) {
      throw new Error('Project not found.');
    }
    const quarantineRoot = getQuarantineRoot(projectsRoot);
    fsModule.mkdirSync(quarantineRoot, { recursive: true });
    const stamp = `${id}.${Date.now()}.${crypto.randomBytes(3).toString('hex')}`;
    const tombDir = path.join(quarantineRoot, stamp);
    // Atomic logical deletion: one same-filesystem rename moves the
    // project out of the library. It is either fully visible or fully
    // gone — never partially deleted.
    try {
      await withDeletionRetries(() => fsModule.renameSync(dir, tombDir), sleep);
    } catch (err) {
      throw lockedFilesError(id, err, 'quarantine');
    }
    const record = { id, deletedAt: new Date().toISOString(), attempts: 0, lastError: null, lastCode: null };
    try {
      writeTombstoneRecord(fsModule, tombDir, record);
    } catch (err) {
      // The tombstone is bookkeeping; its absence must not fail a
      // deletion that already succeeded. The startup sweep removes
      // tombstone-less quarantine entries too.
      safeLog(logger, 'error', `[project-store] could not write tombstone for '${id}': ${err?.message ?? err}`);
    }
    try {
      record.attempts = await withDeletionRetries(
        () => fsModule.rmSync(tombDir, { recursive: true, force: true }),
        sleep,
      );
      return { deleted: true, id, cleanup: 'complete' };
    } catch (err) {
      try {
        writeTombstoneRecord(fsModule, tombDir, {
          ...record,
          attempts: DELETION_MAX_ATTEMPTS,
          lastError: err?.message ?? String(err),
          lastCode: err?.code ?? null,
        });
      } catch { /* tombstone bookkeeping must not fail the deletion report */ }
      safeLog(logger, 'error', `[project-store] deferred physical cleanup for deleted project '${id}': ${err?.message ?? err}`);
      scheduleQuarantineCleanup({ fs: fsModule, sleep, logger, scheduleBackground, tombDir, record });
      return { deleted: true, id, cleanup: 'pending' };
    }
  } finally {
    deletionLocks.delete(id);
  }
}

export async function sweepDeletionQuarantine(userDataPath, options = {}) {
  const { fs: fsModule = fs, sleep = defaultSleep, logger = console } = options ?? {};
  const swept = [];
  const pending = [];
  const quarantineRoot = getQuarantineRoot(getProjectsRoot(userDataPath));
  let entries = [];
  try {
    entries = fsModule.readdirSync(quarantineRoot, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return { swept, pending };
    safeLog(logger, 'error', `[project-store] could not sweep deletion quarantine: ${err?.message ?? err}`);
    return { swept, pending };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const tombDir = path.join(quarantineRoot, entry.name);
    const record = readTombstoneRecord(fsModule, tombDir)
      ?? readQuarantinedProjectRecord(fsModule, tombDir)
      ?? { id: entry.name };
    try {
      await withDeletionRetries(() => fsModule.rmSync(tombDir, { recursive: true, force: true }), sleep);
      swept.push(record.id);
    } catch (err) {
      pending.push(record.id);
      try {
        writeTombstoneRecord(fsModule, tombDir, {
          id: record.id,
          deletedAt: record.deletedAt ?? null,
          attempts: (record.attempts ?? 0) + DELETION_MAX_ATTEMPTS,
          lastError: err?.message ?? String(err),
          lastCode: err?.code ?? null,
          updatedAt: new Date().toISOString(),
        });
      } catch { /* tombstone bookkeeping must not break the sweep */ }
      safeLog(logger, 'error', `[project-store] startup sweep kept tombstone for '${record.id}': ${err?.message ?? err}`);
    }
  }
  return { swept, pending };
}

export function getProjectOutputDir(userDataPath, id) {
  const dir = resolveProjectDir(getProjectsRoot(userDataPath), id);
  if (!fs.existsSync(path.join(dir, 'project.json'))) throw new Error('Project not found.');
  return path.join(dir, 'output');
}
