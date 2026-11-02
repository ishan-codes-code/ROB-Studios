// TTS Studio IPC (Electron main process): catalogue, configuration, preview.
//
// Channels (all validated main-side; the renderer is never trusted):
// - `tts-catalog` () -> { ok, catalog, previewPhrase }
// - `tts-config-get` (projectId|null) -> { ok, global, project, resolved,
//   sources, credentialId, credentialSource, credential, warnings, appDefault }
// - `tts-config-set` ({ scope, projectId?, patch }) -> tts-config-get shape
// - `tts-preview` ({ text, model, voice, voiceDirection, projectId?, credentialId? })
//   -> { ok, audioBase64, bytes, mimeType, config }
//
// Key material never crosses IPC: previews and runs resolve the TTS key
// from the vault in the main process and hand it to Python through the
// child environment only. Preview audio returns as base64 and the temp
// WAV is deleted immediately; previews never touch project artifacts.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getProject, updateProject } from '../../project-store.mjs';
import { getCredentialForRun, isCredentialVerifiedForRun } from '../../credentials-store.mjs';
import { loadSettings, saveSettings } from '../../settings-store.mjs';
import {
  normalizePartialTtsConfig,
  normalizePreviewText,
  resolveTtsConfig,
  TTS_API_KEY_ENV_VAR,
  TTS_PREVIEW_TEXT_MAX_LENGTH,
} from '../../tts-config.mjs';
import { resolvePythonExecutable } from '../../worker-protocol.mjs';

export const TTS_PREVIEW_PHRASE =
  "He's pushing into the compound! One player spotted near the building, the fight is about to explode!";
export const TTS_PREVIEW_TIMEOUT_MS = 60000;
export const TTS_PREVIEW_MAX_BYTES = 8 * 1024 * 1024;
const TTS_PREVIEWS_DIR = 'tts-previews';
const STALE_PREVIEW_MAX_AGE_MS = 60 * 60 * 1000;
const MAX_STDERR_CHARS = 8192;

export function ttsSayScript(repoRoot) {
  return path.join(repoRoot, 'python', 'tts_say.py');
}

export function buildPreviewArgv(script, { text, model, voice, style, out }) {
  return [script, text, '--model', model, '--voice', voice, '--style', style, '--out', out];
}

function childEnv(key) {
  return {
    PATH: process.env.PATH ?? '',
    SYSTEMROOT: process.env.SYSTEMROOT ?? '',
    [TTS_API_KEY_ENV_VAR]: key,
  };
}

function scrubKey(text, key) {
  if (!key || typeof text !== 'string' || !text.includes(key)) return text;
  return text.split(key).join('[REDACTED]');
}

/**
 * Spawn `tts_say.py` for one preview turn. Resolves `{ ok, stderr }`;
 * file verification and cleanup stay with the caller. `spawnFn` is
 * injectable for tests.
 */
export function runTtsPreviewProcess({
  executable, args, key, spawnFn = spawn, timeoutMs = TTS_PREVIEW_TIMEOUT_MS,
}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv(key) });
    } catch {
      resolve({ ok: false, stderr: 'Could not start the TTS preview process.' });
      return;
    }
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish({ ok: false, stderr: 'TTS preview timed out.' });
    }, timeoutMs);
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk).slice(0, MAX_STDERR_CHARS - stderr.length);
    });
    child.on('error', () => finish({ ok: false, stderr: 'Could not start the TTS preview process.' }));
    child.on('close', (code) => {
      if (code === 0) {
        finish({ ok: true, stderr });
        return;
      }
      const message = stderr.trim().split(/\r?\n/).at(-1) || 'TTS preview failed.';
      finish({ ok: false, stderr: message });
    });
  });
}

export function previewsDir(userDataPath) {
  return path.join(userDataPath, TTS_PREVIEWS_DIR);
}

/** Best-effort sweep of preview WAVs left behind by crashes. */
export function sweepStalePreviews(userDataPath, now = Date.now()) {
  try {
    const dir = previewsDir(userDataPath);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.wav')) continue;
      const file = path.join(dir, entry.name);
      try {
        if (now - fs.statSync(file).mtimeMs > STALE_PREVIEW_MAX_AGE_MS) fs.unlinkSync(file);
      } catch { /* keep sweeping */ }
    }
  } catch { /* missing dir is fine */ }
}

function previewTempPath(userDataPath) {
  const dir = previewsDir(userDataPath);
  fs.mkdirSync(dir, { recursive: true });
  const token = crypto.randomBytes(8).toString('hex');
  return path.join(dir, `preview-${process.pid}-${Date.now()}-${token}.wav`);
}

function removeQuietly(file) {
  try { fs.unlinkSync(file); } catch { /* already gone */ }
}

function assertProjectId(projectId) {
  if (typeof projectId !== 'string' || projectId === '') throw new Error('Invalid project id.');
}

async function credentialMetadata(userDataPath, safeStorage, credentialId) {
  if (credentialId === null || credentialId === undefined) {
    return { credential: null, warning: null };
  }
  let resolved;
  try {
    resolved = getCredentialForRun(userDataPath, safeStorage, credentialId);
  } catch {
    return { credential: null, warning: 'The saved TTS credential is missing or unreadable. Choose another credential.' };
  }
  if (resolved.record.purpose !== 'tts') {
    return { credential: null, warning: 'The saved credential is not a TTS credential. Choose a TTS credential.' };
  }
  const verified = isCredentialVerifiedForRun(resolved.record);
  return {
    credential: {
      id: resolved.record.id,
      name: resolved.record.name,
      provider: resolved.record.provider,
      verified,
    },
    warning: verified
      ? null
      : 'This TTS credential is not verified. Verify it on the API Keys page before previewing.',
  };
}

export function registerTtsIpc({
  ipcMain, app, safeStorage, repoRoot, catalogLoader, spawnFn = spawn,
  previewTimeoutMs = TTS_PREVIEW_TIMEOUT_MS, runPreview = runTtsPreviewProcess,
}) {
  const userData = () => app.getPath('userData');

  async function configSnapshot(projectId) {
    const catalog = await catalogLoader.load();
    const settings = loadSettings(userData());
    let projectTts = null;
    if (projectId !== null && projectId !== undefined) {
      assertProjectId(projectId);
      projectTts = getProject(userData(), projectId).configuration?.tts ?? null;
    }
    const warnings = [];
    const globalLayer = normalizePartialTtsConfig(settings.tts ?? null);
    const projectLayer = projectId === null || projectId === undefined
      ? null
      : normalizePartialTtsConfig(projectTts);
    let resolved;
    try {
      resolved = resolveTtsConfig({
        catalog,
        globalTts: globalLayer,
        projectTts: projectLayer,
      });
    } catch (err) {
      // Stored values can outlive the catalogue (e.g. a removed model).
      // The config view falls back to application defaults with an
      // explicit warning so the user can repair and save; preview and
      // run resolution stay strict and fail closed.
      warnings.push(
        `Saved TTS settings are no longer valid (${err?.message ?? 'unknown reason'}). Choose replacements and save.`,
      );
      resolved = resolveTtsConfig({ catalog, globalTts: null, projectTts: null });
    }
    // Credential selection never depends on the catalogue, so it stays
    // visible (and editable) even while the voice triple falls back.
    const credentialId = projectLayer?.credentialId
      ?? globalLayer.credentialId
      ?? null;
    const credentialSource = credentialId === null
      ? null
      : (projectLayer?.credentialId != null ? 'project' : 'global');
    const { credential, warning } = await credentialMetadata(
      userData(), safeStorage, credentialId,
    );
    if (warning) warnings.push(warning);
    return {
      ok: true,
      global: globalLayer,
      project: projectLayer,
      resolved: resolved.config,
      sources: resolved.sources,
      credentialId,
      credentialSource,
      credential,
      warnings,
      appDefault: { ...catalog.defaults },
    };
  }

  ipcMain.handle('tts-catalog', async () => {
    try {
      const catalog = await catalogLoader.load();
      return {
        ok: true,
        catalog,
        previewPhrase: TTS_PREVIEW_PHRASE,
        textLimit: TTS_PREVIEW_TEXT_MAX_LENGTH,
      };
    } catch (err) {
      try { console.error('[tts-catalog] failed:', err?.message ?? err); } catch { /* never break IPC */ }
      return { ok: false, error: err?.message ?? 'TTS catalogue is unavailable.' };
    }
  });

  ipcMain.handle('tts-config-get', async (_event, projectId = null) => {
    try {
      return await configSnapshot(projectId ?? null);
    } catch (err) {
      try { console.error('[tts-config-get] failed:', err?.message ?? err); } catch { /* never break IPC */ }
      return { ok: false, error: err?.message ?? 'Could not load TTS configuration.' };
    }
  });

  ipcMain.handle('tts-config-set', async (_event, input = {}) => {
    try {
      const scope = input?.scope;
      if (scope !== 'global' && scope !== 'project') throw new Error("TTS scope must be 'global' or 'project'.");
      const patch = input?.patch;
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new Error('TTS patch must be an object.');
      }
      // Unknown keys and shape violations fail before anything is written.
      const normalized = normalizePartialTtsConfig(patch);
      const provided = Object.keys(patch);
      if (provided.length === 0) throw new Error('TTS patch must set at least one field.');
      const catalog = await catalogLoader.load();
      const model = patch.model ?? null;
      if (model !== null && !catalog.models.some((entry) => entry.id === model)) {
        throw new Error(`Unsupported TTS model '${model}'.`);
      }
      const credentialId = patch.credentialId ?? null;
      if (credentialId !== null) {
        let resolved;
        try {
          resolved = getCredentialForRun(userData(), safeStorage, credentialId);
        } catch {
          throw new Error('The selected TTS credential is missing or unreadable.');
        }
        if (resolved.record.purpose !== 'tts') throw new Error('Choose a TTS credential for TTS configuration.');
      }
      if (scope === 'global') {
        const settings = loadSettings(userData());
        const merged = { ...normalizePartialTtsConfig(settings.tts ?? null) };
        for (const key of provided) merged[key] = normalized[key];
        saveSettings(userData(), { ...settings, tts: merged });
        return await configSnapshot(input?.projectId ?? null);
      }
      assertProjectId(input?.projectId);
      const project = getProject(userData(), input.projectId);
      const merged = { ...normalizePartialTtsConfig(project.configuration?.tts ?? null) };
      for (const key of provided) merged[key] = normalized[key];
      updateProject(userData(), input.projectId, { configuration: { tts: merged } });
      return await configSnapshot(input.projectId);
    } catch (err) {
      try { console.error('[tts-config-set] failed:', err?.message ?? err); } catch { /* never break IPC */ }
      return { ok: false, error: err?.message ?? 'Could not save TTS configuration.' };
    }
  });

  ipcMain.handle('tts-preview', async (_event, input = {}) => {
    let tmp = null;
    try {
      const text = normalizePreviewText(input?.text);
      const triple = normalizePartialTtsConfig({
        model: input?.model ?? null,
        voice: input?.voice ?? null,
        voiceDirection: input?.voiceDirection ?? null,
      });
      if (triple.model === null || triple.voice === null || triple.voiceDirection === null) {
        throw new Error('Preview needs a model, voice, and voice direction.');
      }
      const catalog = await catalogLoader.load();
      if (!catalog.models.some((entry) => entry.id === triple.model)) {
        throw new Error(`Unsupported TTS model '${triple.model}'.`);
      }
      const projectId = input?.projectId ?? null;
      if (projectId !== null) assertProjectId(projectId);
      const overrideId = input?.credentialId ?? null;
      if (overrideId !== null && (typeof overrideId !== 'string' || overrideId === '')) {
        throw new Error('Invalid TTS credential selection.');
      }
      const settings = loadSettings(userData());
      const projectTts = projectId === null
        ? null
        : getProject(userData(), projectId).configuration?.tts ?? null;
      const credentialId = overrideId
        ?? projectTts?.credentialId
        ?? settings.tts?.credentialId
        ?? null;
      if (credentialId === null) {
        return { ok: false, error: 'Select a TTS credential before previewing.', code: 'no-credential' };
      }
      let snapshot;
      try {
        snapshot = getCredentialForRun(userData(), safeStorage, credentialId);
      } catch {
        return { ok: false, error: 'Secure API credential is unavailable. Check secure storage.', code: 'config' };
      }
      if (snapshot.record.purpose !== 'tts') {
        return { ok: false, error: 'The selected credential is not a TTS credential.', code: 'config' };
      }
      if (!isCredentialVerifiedForRun(snapshot.record)) {
        return {
          ok: false,
          error: 'Verify this TTS credential on the API Keys page before previewing.',
          code: 'unverified',
        };
      }
      const root = typeof repoRoot === 'function' ? repoRoot() : repoRoot;
      const { executable } = resolvePythonExecutable(root);
      if (!executable) {
        return { ok: false, error: 'Python virtual environment is not configured.', code: 'config' };
      }
      sweepStalePreviews(userData());
      tmp = previewTempPath(userData());
      const result = await runPreview({
        executable,
        args: buildPreviewArgv(ttsSayScript(root), {
          text, model: triple.model, voice: triple.voice, style: triple.voiceDirection, out: tmp,
        }),
        key: snapshot.apiKey,
        spawnFn,
        timeoutMs: previewTimeoutMs,
      });
      if (!result?.ok) {
        const message = scrubKey(
          (result?.stderr || 'TTS preview failed.').slice(0, 500), snapshot.apiKey,
        );
        removeQuietly(tmp);
        tmp = null;
        return { ok: false, error: message, code: 'preview-failed' };
      }
      let bytes;
      try {
        const stat = fs.statSync(tmp);
        if (!stat.isFile() || stat.size === 0 || stat.size > TTS_PREVIEW_MAX_BYTES) {
          throw new Error('TTS preview produced no audio.');
        }
        bytes = fs.readFileSync(tmp);
      } finally {
        removeQuietly(tmp);
        tmp = null;
      }
      return {
        ok: true,
        audioBase64: bytes.toString('base64'),
        bytes: bytes.length,
        mimeType: 'audio/wav',
        config: { model: triple.model, voice: triple.voice },
      };
    } catch (err) {
      if (tmp) removeQuietly(tmp);
      try { console.error('[tts-preview] failed:', err?.message ?? err); } catch { /* never break IPC */ }
      return { ok: false, error: err?.message ?? 'TTS preview failed.' };
    }
  });
}
