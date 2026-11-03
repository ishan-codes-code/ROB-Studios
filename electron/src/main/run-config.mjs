// Project run-configuration resolution (Electron main process only).
//
// At run start, the main process resolves the project's stored
// configuration references (credential + game profile + preset) into the
// concrete, non-secret runtime values the worker needs. The worker
// receives only the active run's provider, model, decrypted key, and
// style preferences — never the vault. This resolution is the run
// snapshot: later UI edits cannot change an already-running job.
import { getProject } from '../project-store.mjs';
import {
  getCredentialForRun,
  isCredentialVerifiedForRun,
} from '../credentials-store.mjs';
import {
  buildWorkerPreferences,
  DEFAULT_COMMENTARY_PRESET_ID,
  DEFAULT_GAME_PROFILE_ID,
} from '../game-store.mjs';
import { getProviderBaseUrl } from '../provider-catalog.mjs';
import { buildPackSnapshot } from '../prompt-packs.mjs';
import { loadSettings } from '../settings-store.mjs';
import { resolveTtsConfig } from '../tts-config.mjs';

/**
 * Resolve `{ provider, model, apiKey, baseUrl, preferences,
 * credentialName, verified }` for a project run. Throws secret-free
 * errors that the IPC handler returns directly: missing selection,
 * missing or unreadable credential, or unknown game/prompt references.
 * `verified` reports image-input verification; paid runs require it.
 * Never silently substitutes another key. `packsFactory` may be null
 * when the prompt-pack probe is unavailable (Python backstops).
 */
export function resolveProjectRunConfig(userDataPath, safeStorage, projectId, packsFactory = null) {
  if (typeof projectId !== 'string' || projectId === '') {
    throw new Error('Project not found.');
  }
  let project;
  try {
    project = getProject(userDataPath, projectId);
  } catch {
    throw new Error('Project not found.');
  }
  const config = project.configuration ?? {
    credentialId: null,
    gameProfileId: DEFAULT_GAME_PROFILE_ID,
    commentaryPresetId: DEFAULT_COMMENTARY_PRESET_ID,
  };
  if (config.credentialId === null || config.credentialId === undefined) {
    throw new Error(
      'This project has no API configuration selected. Open the editor Configure tab to choose one.',
    );
  }
  let resolved;
  try {
    resolved = getCredentialForRun(userDataPath, safeStorage, config.credentialId);
  } catch {
    throw new Error(
      'The selected API configuration is missing or unreadable. Choose another configuration.',
    );
  }
  if (resolved.record.purpose !== 'vision') {
    throw new Error('The selected API configuration is not a Vision credential. Choose a Vision configuration.');
  }
  const verified = isCredentialVerifiedForRun(resolved.record);
  let preferences;
  try {
    preferences = buildWorkerPreferences(
      userDataPath, config.gameProfileId, config.commentaryPresetId,
    );
  } catch {
    throw new Error(
      'The selected game profile or commentary preset is missing. Choose another configuration.',
    );
  }
  try {
    preferences.promptPack = buildPackSnapshot(
      userDataPath, packsFactory, config.promptPackId ?? null,
    );
  } catch {
    throw new Error(
      'The selected prompt pack is invalid. Choose another pack.',
    );
  }
  let baseUrl;
  try {
    baseUrl = getProviderBaseUrl(resolved.provider, resolved.record);
  } catch {
    throw new Error(
      'The selected API configuration has an invalid endpoint URL. Update the endpoint.',
    );
  }
  return {
    provider: resolved.provider,
    model: resolved.model,
    apiKey: resolved.apiKey,
    baseUrl,
    preferences,
    credentialName: resolved.record.name,
    verified,
  };
}

/**
 * Resolve `{ config, apiKey, credentialName }` for a project's TTS run.
 * `catalog` is the validated backend catalogue. The voice triple follows
 * project override > global default > application default; the key comes
 * from the resolved TTS credential only. Throws secret-free, actionable
 * errors: no credential selected, missing/unreadable credential,
 * wrong-purpose credential, or unverified credential. Never silently
 * substitutes another key or voice.
 */
export function resolveTtsRunConfig(userDataPath, safeStorage, projectId, catalog) {
  if (typeof projectId !== 'string' || projectId === '') {
    throw new Error('Project not found.');
  }
  let project;
  try {
    project = getProject(userDataPath, projectId);
  } catch {
    throw new Error('Project not found.');
  }
  const settings = loadSettings(userDataPath);
  const resolved = resolveTtsConfig({
    catalog,
    globalTts: settings.tts ?? null,
    projectTts: project.configuration?.tts ?? null,
  });
  if (resolved.credentialId === null) {
    throw new Error(
      'This project has no TTS credential selected. Choose one in the TTS Studio.',
    );
  }
  let credential;
  try {
    credential = getCredentialForRun(userDataPath, safeStorage, resolved.credentialId);
  } catch {
    throw new Error(
      'The selected TTS credential is missing or unreadable. Choose another TTS credential.',
    );
  }
  if (credential.record.purpose !== 'tts') {
    throw new Error('The selected credential is not a TTS credential. Choose a TTS credential.');
  }
  if (!isCredentialVerifiedForRun(credential.record)) {
    throw new Error(
      'The selected TTS credential is not verified. Verify it under AI Providers first.',
    );
  }
  return {
    config: resolved.config,
    apiKey: credential.apiKey,
    credentialName: credential.record.name,
  };
}

/** Remove host secrets before spawning the worker; keep runtime PATH. */
export function stripHostSecrets(env) {
  const clean = { ...env };
  for (const key of Object.keys(clean)) {
    if (/API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY/i.test(key)) {
      delete clean[key];
    }
  }
  return clean;
}
