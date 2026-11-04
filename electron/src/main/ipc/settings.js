import fs from 'node:fs';
import path from 'node:path';
import { loadSettings, saveSettings } from '../../settings-store.mjs';
import {
  listCredentials,
  createCredential as vaultCreate,
  renameCredential as vaultRename,
  setCredentialKey as vaultSetKey,
  setCredentialModel as vaultSetModel,
  setCredentialEndpoint as vaultSetEndpoint,
  deleteCredential as vaultDelete,
  markCredentialVerified,
  markCredentialUnverified,
  getCredentialForRun,
  isCredentialVerifiedForRun,
  isDevBypassEnabled,
  setDevBypassEnabled,
} from '../../credentials-store.mjs';
import {
  getProvider,
  getProviderBaseUrl,
  validateCustomBaseUrl,
} from '../../provider-catalog.mjs';
import {
  listGameProfiles,
  listCommentaryPresets,
  createGameProfile as libraryCreateProfile,
  updateGameProfile as libraryUpdateProfile,
  deleteGameProfile as libraryDeleteProfile,
  createCommentaryPreset as libraryCreatePreset,
  updateCommentaryPreset as libraryUpdatePreset,
  duplicateCommentaryPreset as libraryDuplicatePreset,
  deleteCommentaryPreset as libraryDeletePreset,
  getGameProfile,
  getCommentaryPreset,
  DEFAULT_GAME_PROFILE_ID,
  DEFAULT_COMMENTARY_PRESET_ID,
} from '../../game-store.mjs';
import { migrateLegacyVault } from '../../vault-migration.mjs';
import { listProjects, getProject, updateProject, recordCompletedActivity } from '../../project-store.mjs';
import {
  listPromptPacks,
  setPromptField,
  resetPromptPack,
} from '../../prompt-packs.mjs';

export function registerSettingsIpc({ ipcMain, app, safeStorage, spawnSetup, packsLoader = null }) {
  async function loadFactory() {
    if (!packsLoader) throw new Error('Prompt packs are unavailable.');
    return packsLoader.load();
  }
  const userData = () => app.getPath('userData');
  const credentials = {
    available: () => safeStorage?.isEncryptionAvailable?.() === true,
    file: () => path.join(userData(), 'provider-key.enc'),
  };
  function writeKey(key) {
    if (!credentials.available()) throw new Error('Secure credential storage is unavailable on this device.');
    if (typeof key !== 'string' || !key.trim() || key.length > 4096) throw new Error('API key must be a non-empty string under 4096 characters.');
    const file = credentials.file();
    const temp = `${file}.${process.pid}.tmp`;
    try { fs.writeFileSync(temp, safeStorage.encryptString(key), { flag: 'w', mode: 0o600 }); fs.renameSync(temp, file); }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
  function readKey() {
    if (!credentials.available()) throw new Error('Secure credential storage is unavailable on this device.');
    const file = credentials.file();
    return fs.existsSync(file) ? safeStorage.decryptString(fs.readFileSync(file)) : '';
  }
  const safe = (err) => ({ ok: false, error: 'Settings operation failed.' });
  const userDataPath = () => userData();

  function ensureMigrated() {
    let credentialsList = [];
    try {
      credentialsList = listCredentials(userDataPath(), safeStorage);
    } catch {
      return { credentials: [], migration: null };
    }
    if (credentialsList.length > 0) return { credentials: credentialsList, migration: null };
    let migration = null;
    try {
      migration = migrateLegacyVault(userDataPath(), {
        safeStorage,
        loadSettings,
        vaultHasCredentials: () => {
          try { return listCredentials(userDataPath(), safeStorage).length > 0; }
          catch { return true; }
        },
        createCredential: (input) => vaultCreate(userDataPath(), safeStorage, input),
        markCredentialVerified: (id, model) => markCredentialVerified(userDataPath(), safeStorage, id, model),
        createGameProfile: (input) => libraryCreateProfile(userDataPath(), input),
        createCommentaryPreset: (input) => libraryCreatePreset(userDataPath(), input),
      });
    } catch {
      migration = { migrated: false, notice: 'Automatic migration failed. Create a new API configuration.' };
    }
    try {
      credentialsList = listCredentials(userDataPath(), safeStorage);
    } catch {
      credentialsList = [];
    }
    return { credentials: credentialsList, migration };
  }

  function projectReferences(credentialId = null, gameProfileId = null, presetId = null) {
    const names = [];
    let projects = [];
    try {
      projects = listProjects(userDataPath());
    } catch {
      return names;
    }
    for (const project of projects) {
      const config = project.configuration ?? {};
      if ((credentialId !== null && (config.credentialId === credentialId
          || config.tts?.credentialId === credentialId))
        || (gameProfileId !== null && config.gameProfileId === gameProfileId)
        || (presetId !== null && config.commentaryPresetId === presetId)) {
        names.push(project.name);
      }
    }
    return names;
  }

  function purposeForSetupOperation(setupOperation) {
    if (setupOperation === 'connection') return 'verify-connection';
    if (setupOperation === 'verify-vision') return 'verify-vision';
    if (setupOperation === 'verify-tts-auth') return 'verify-tts';
    if (setupOperation === 'models') return 'list-models';
    return 'verify-connection';
  }

  // Settings-level activity (credential checks, model discovery) runs
  // in a setup child, not the worker, so the outcome is recorded here
  // once the subprocess settles. Probe errors are already secret-free
  // by the setup contract; only bounded fields are persisted.
  function recordSetupActivity({ provider, model, purpose, startedAt, result }) {
    try {
      const ok = result?.ok === true;
      recordCompletedActivity(userDataPath(), null, {
        provider,
        model: typeof model === 'string' && model !== '' ? model : null,
        purpose,
        status: ok ? 'succeeded' : 'failed',
        startedAt,
        completedAt: Date.now(),
        httpStatus: typeof result?.status === 'number' ? result.status : null,
        errorCode: ok ? null : (typeof result?.code === 'string' ? result.code : 'unknown'),
        errorMessage: ok ? null : (typeof result?.error === 'string' ? result.error : null),
      });
    } catch { /* diagnostics never break settings flows */ }
  }

  async function runCredentialCheck(id, operation) {
    // Read the credential once: the snapshot pins the exact configuration
    // under test (id, provider, model, endpoint, version) so a mid-flight
    // key, model, or endpoint change cannot mark the wrong configuration
    // as verified.
    let snapshot;
    try {
      snapshot = getCredentialForRun(userDataPath(), safeStorage, id);
    } catch {
      return { ok: false, error: 'Secure API credential is unavailable. Check secure storage.', code: 'config', tested: null };
    }
    let baseUrl;
    try {
      baseUrl = getProviderBaseUrl(snapshot.provider, snapshot.record);
    } catch {
      return { ok: false, error: 'The saved endpoint URL is invalid. Update the endpoint and try again.', code: 'config', tested: null };
    }
    const setupOperation = operation === 'verify-vision' && snapshot.record.purpose === 'tts'
      ? 'verify-tts-auth'
      : operation;
    const checkStartedAt = Date.now();
    let result;
    try {
      result = await spawnSetup({
        operation: setupOperation,
        provider: { id: snapshot.provider, baseUrl },
        model: snapshot.model,
        // Key travels process-locally to the setup child only; never to IPC.
        key: snapshot.apiKey,
      });
    } catch {
      // Preserve a checked snapshot for the verify handler's stale-safe
      // invalidation, while keeping subprocess exceptions out of IPC/logs.
      result = {
        ok: false,
        error: 'Provider verification process failed. Try again.',
        code: 'setup',
      };
    }
    recordSetupActivity({
      provider: snapshot.provider,
      model: snapshot.model,
      purpose: purposeForSetupOperation(setupOperation),
      startedAt: checkStartedAt,
      result,
    });
    const tested = {
      id: snapshot.record.id,
      provider: snapshot.provider,
      model: snapshot.model,
      baseUrl: snapshot.record.baseUrl ?? null,
      credentialVersion: snapshot.record.credentialVersion,
    };
    if (!result || typeof result !== 'object' || result.ok !== true) {
      const detail = (result && typeof result.detail === 'string' && result.detail)
        ? result.detail.slice(0, 500)
        : null;
      const failure = {
        ok: false,
        error: (result && typeof result.error === 'string' && result.error)
          || 'Provider request failed. Check the key, model, and provider compatibility.',
        code: (result && typeof result.code === 'string' && result.code) || 'unknown',
        detail,
        tested,
      };
      // Development diagnostics: structured and secret-free (never the key).
      try {
        console.error(
          `[provider-setup] ${operation} failed for provider=${snapshot.provider} model=${snapshot.model}:`,
          `code=${failure.code}`,
          result && typeof result.status === 'number' ? `status=${result.status}` : 'status=n/a',
          detail ? `detail=${detail}` : 'detail=n/a',
        );
      } catch { /* logging must never break the IPC response */ }
      return failure;
    }
    return { ...result, tested };
  }

  ipcMain.handle('settings-load', async () => {
    try { const settings = loadSettings(userData()); return { ok: true, settings, credentialAvailable: credentials.available(), keyConfigured: credentials.available() && fs.existsSync(credentials.file()) }; }
    catch (err) { return safe(err); }
  });
  ipcMain.handle('settings-save', async (_event, value) => {
    try {
      const current = loadSettings(userData());
      const requested = { ...value, provider: { ...value?.provider,
        modelVisionVerified: value?.provider?.baseUrl === current.provider.baseUrl && value?.provider?.model === current.provider.model
          ? current.provider.modelVisionVerified : false } };
      return { ok: true, settings: saveSettings(userData(), requested) };
    } catch (err) { return safe(err); }
  });
  ipcMain.handle('credential-set', async (_event, key) => { try { writeKey(key); return { ok: true, configured: true }; } catch (err) { return safe(err); } });
  ipcMain.handle('credential-delete', async () => { try { const file = credentials.file(); if (fs.existsSync(file)) fs.unlinkSync(file); return { ok: true, configured: false }; } catch (err) { return safe(err); } });
  ipcMain.handle('provider-setup', async (_event, operation, settings) => {
    try {
      if (!['connection', 'models', 'verify-vision'].includes(operation)) throw new Error('Unsupported provider operation.');
      const saved = loadSettings(userData());
      const candidate = saveSettings(userData(), { ...saved, ...settings, provider: { ...saved.provider, ...(settings?.provider ?? {}), modelVisionVerified: settings?.provider?.baseUrl === saved.provider.baseUrl && settings?.provider?.model === saved.provider.model ? saved.provider.modelVisionVerified : false } });
      const key = readKey();
      if (!key) throw new Error('Save an API key before testing the provider.');
      const legacyStartedAt = Date.now();
      const result = await spawnSetup({ operation, provider: candidate.provider, key });
      recordSetupActivity({
        provider: candidate.provider?.id ?? 'baseten',
        model: candidate.provider?.model ?? null,
        purpose: purposeForSetupOperation(operation),
        startedAt: legacyStartedAt,
        result,
      });
      if (operation === 'verify-vision' && result?.ok === true) {
        const verified = { ...candidate, provider: { ...candidate.provider, modelVisionVerified: true } };
        return { ...result, settings: saveSettings(userData(), verified) };
      }
      return result;
    } catch (err) { return safe(err); }
  });

  // ---- Provider vault -------------------------------------------------
  // TEMPORARY development-only bypass: memory-held credentials when OS
  // encryption is unavailable. Gated main-side on app.isPackaged —
  // never on renderer input. Production builds always reject enabling.
  ipcMain.handle('dev-bypass-get', async () => ({
    ok: true,
    supported: app.isPackaged !== true,
    enabled: isDevBypassEnabled(),
  }));
  ipcMain.handle('dev-bypass-set', async (_event, enabled) => {
    try {
      if (app.isPackaged === true) {
        return { ok: false, error: 'The development credential bypass is not available in production builds.' };
      }
      const state = setDevBypassEnabled(enabled === true, { isPackaged: app.isPackaged === true });
      return { ok: true, supported: true, enabled: state.enabled };
    } catch (err) {
      return { ok: false, error: err?.message ?? 'Settings operation failed.' };
    }
  });
  ipcMain.handle('credential-list', async () => {
    try {
      const { credentials: items, migration } = ensureMigrated();
      return {
        ok: true,
        credentials: items,
        migration,
        secureStorageAvailable: safeStorage?.isEncryptionAvailable?.() === true,
      };
    } catch (err) { return safe(err); }
  });
  ipcMain.handle('credential-create', async (_event, input) => {
    try {
      ensureMigrated();
      const credential = vaultCreate(userDataPath(), safeStorage, input ?? {});
      return { ok: true, credential };
    } catch (err) { return safe(err); }
  });
  ipcMain.handle('credential-rename', async (_event, id, name) => {
    try {
      const credential = vaultRename(userDataPath(), safeStorage, id, name);
      return { ok: true, credential };
    } catch (err) { return safe(err); }
  });
  ipcMain.handle('credential-set-key', async (_event, id, key) => {
    try {
      const credential = vaultSetKey(userDataPath(), safeStorage, id, key);
      return { ok: true, credential };
    } catch (err) { return safe(err); }
  });
  ipcMain.handle('credential-set-model', async (_event, id, model) => {
    try {
      const credential = vaultSetModel(userDataPath(), safeStorage, id, model);
      return { ok: true, credential };
    } catch (err) { return safe(err); }
  });
  ipcMain.handle('credential-set-endpoint', async (_event, id, baseUrl) => {
    try {
      const credential = vaultSetEndpoint(userDataPath(), safeStorage, id, baseUrl);
      return { ok: true, credential };
    } catch (err) { return safe(err); }
  });
  // Best-effort live model discovery for custom endpoints. Either
  // resolves a saved credential (key decrypted main-side, never over
  // IPC) or runs one-shot with a caller-supplied endpoint + key during
  // creation (validated, used once, never stored or logged). Structured
  // failures mirror credential-test so the renderer can distinguish
  // "listing unsupported" (offer manual entry) from real errors.
  ipcMain.handle('custom-models', async (_event, input) => {
    try {
      let baseUrl;
      let key;
      if (input && typeof input === 'object' && typeof input.credentialId === 'string' && input.credentialId !== '') {
        let snapshot;
        try {
          snapshot = getCredentialForRun(userDataPath(), safeStorage, input.credentialId);
        } catch {
          return { ok: false, error: 'Secure API credential is unavailable. Check secure storage.', code: 'config' };
        }
        if (snapshot.provider !== 'custom') {
          return { ok: false, error: 'Model discovery is only available for custom endpoints.', code: 'config' };
        }
        baseUrl = snapshot.record.baseUrl;
        key = snapshot.apiKey;
      } else {
        try {
          baseUrl = validateCustomBaseUrl(input?.baseUrl);
        } catch (err) {
          return { ok: false, error: err?.message ?? 'Custom endpoint URL is invalid.', code: 'config' };
        }
        key = input?.key;
        if (typeof key !== 'string' || key.trim() === '' || key.length > 4096) {
          return { ok: false, error: 'API key must be a non-empty string under 4096 characters.', code: 'config' };
        }
      }
      const discoveryStartedAt = Date.now();
      let result;
      try {
        result = await spawnSetup({
          operation: 'models',
          provider: { id: 'custom', baseUrl },
          model: '',
          key,
        });
      } catch {
        result = { ok: false, error: 'Model discovery process failed. Try again.', code: 'setup' };
      }
      recordSetupActivity({
        provider: 'custom',
        model: null,
        purpose: 'list-models',
        startedAt: discoveryStartedAt,
        result,
      });
      if (!result || typeof result !== 'object' || result.ok !== true) {
        return {
          ok: false,
          error: (result && typeof result.error === 'string' && result.error)
            || 'Could not list models for this endpoint.',
          code: (result && typeof result.code === 'string' && result.code) || 'unknown',
          detail: (result && typeof result.detail === 'string' && result.detail)
            ? result.detail.slice(0, 500)
            : null,
        };
      }
      const models = Array.isArray(result.models)
        ? result.models.filter((entry) => entry && typeof entry.id === 'string').map((entry) => ({ id: entry.id }))
        : [];
      return { ok: true, provider: 'custom', models };
    } catch (err) { return safe(err); }
  });
  ipcMain.handle('credential-remove', async (_event, id) => {
    try {
      if (typeof id !== 'string' || id === '') throw new Error('Invalid credential id.');
      const usedBy = projectReferences(id, null, null);
      if (usedBy.length > 0) {
        return { ok: false, error: 'Settings operation failed.', referencedBy: usedBy };
      }
      try {
        if (loadSettings(userDataPath()).tts?.credentialId === id) {
          return { ok: false, error: 'Settings operation failed.', referencedByGlobal: true };
        }
      } catch { /* unreadable settings cannot block deletion */ }
      return { ok: true, ...vaultDelete(userDataPath(), safeStorage, id) };
    } catch (err) { return safe(err); }
  });
  ipcMain.handle('credential-test', async (_event, id) => {
    try {
      if (typeof id !== 'string' || id === '') throw new Error('Invalid credential id.');
      const result = await runCredentialCheck(id, 'connection');
      if (!result?.ok) {
        return { ok: false, error: result?.error ?? 'Settings operation failed.', code: result?.code ?? 'unknown', detail: result?.detail ?? null };
      }
      return { ok: true, connected: true };
    } catch (err) { return safe(err); }
  });
  ipcMain.handle('credential-verify', async (_event, id) => {
    try {
      if (typeof id !== 'string' || id === '') throw new Error('Invalid credential id.');
      const result = await runCredentialCheck(id, 'verify-vision');
      if (!result?.ok) {
        // A failed recheck must not leave an older success displayed as the
        // current status. Only clear the record if the tested snapshot still
        // matches; concurrent key/model edits already invalidate it safely.
        const tested = result?.tested;
        if (tested) {
          try {
            const fresh = getCredentialForRun(userDataPath(), safeStorage, id);
            if (fresh.record.id === tested.id
              && fresh.record.provider === tested.provider
              && fresh.record.model === tested.model
              && (fresh.record.baseUrl ?? null) === (tested.baseUrl ?? null)
              && fresh.record.credentialVersion === tested.credentialVersion) {
              markCredentialUnverified(userDataPath(), safeStorage, id);
            }
          } catch { /* preserve the safe failure response */ }
        }
        return { ok: false, error: result?.error ?? 'Settings operation failed.', code: result?.code ?? 'unknown', detail: result?.detail ?? null };
      }
      // Stale guard: only the exact tested configuration (id, provider,
      // model, credential version) may be marked verified. A key rotation
      // or model change during the check refuses instead of mis-marking.
      let fresh;
      try {
        fresh = getCredentialForRun(userDataPath(), safeStorage, id);
      } catch {
        return { ok: false, error: 'Secure API credential is unavailable. Check secure storage.', code: 'config' };
      }
      const tested = result.tested ?? null;
      if (!tested
        || fresh.record.id !== tested.id
        || fresh.record.provider !== tested.provider
        || fresh.record.model !== tested.model
        || (fresh.record.baseUrl ?? null) !== (tested.baseUrl ?? null)
        || fresh.record.credentialVersion !== tested.credentialVersion) {
        return { ok: false, error: 'The configuration changed during verification. Review the current values and verify again.', code: 'stale' };
      }
      const credential = markCredentialVerified(
        userDataPath(), safeStorage, id,
        fresh.record.purpose === 'tts' ? null : fresh.record.model,
        fresh.record.baseUrl ?? null,
      );
      return { ok: true, credential };
    } catch (err) { return safe(err); }
  });

  // ---- Games & prompts -------------------------------------------------
  ipcMain.handle('game-profile-list', async () => {
    try { return { ok: true, profiles: listGameProfiles(userDataPath()) }; }
    catch (err) { return safe(err); }
  });
  ipcMain.handle('game-profile-create', async (_event, input) => {
    try { return { ok: true, profile: libraryCreateProfile(userDataPath(), input ?? {}) }; }
    catch (err) { return safe(err); }
  });
  ipcMain.handle('game-profile-update', async (_event, id, patch) => {
    try { return { ok: true, profile: libraryUpdateProfile(userDataPath(), id, patch ?? {}) }; }
    catch (err) { return safe(err); }
  });
  ipcMain.handle('game-profile-delete', async (_event, id) => {
    try {
      if (typeof id !== 'string' || id === '') throw new Error('Invalid configuration id.');
      const usedBy = projectReferences(null, id, null);
      if (usedBy.length > 0) {
        return { ok: false, error: 'Settings operation failed.', referencedBy: usedBy };
      }
      return { ok: true, ...libraryDeleteProfile(userDataPath(), id) };
    } catch (err) { return safe(err); }
  });
  ipcMain.handle('preset-list', async (_event, profileId = null) => {
    try { return { ok: true, presets: listCommentaryPresets(userDataPath(), profileId) }; }
    catch (err) { return safe(err); }
  });
  ipcMain.handle('preset-create', async (_event, input) => {
    try { return { ok: true, preset: libraryCreatePreset(userDataPath(), input ?? {}) }; }
    catch (err) { return safe(err); }
  });
  ipcMain.handle('preset-update', async (_event, id, patch) => {
    try { return { ok: true, preset: libraryUpdatePreset(userDataPath(), id, patch ?? {}) }; }
    catch (err) { return safe(err); }
  });
  ipcMain.handle('preset-duplicate', async (_event, id, name = null) => {
    try { return { ok: true, preset: libraryDuplicatePreset(userDataPath(), id, name) }; }
    catch (err) { return safe(err); }
  });
  ipcMain.handle('preset-delete', async (_event, id) => {
    try {
      if (typeof id !== 'string' || id === '') throw new Error('Invalid configuration id.');
      const usedBy = projectReferences(null, null, id);
      if (usedBy.length > 0) {
        return { ok: false, error: 'Settings operation failed.', referencedBy: usedBy };
      }
      return { ok: true, ...libraryDeletePreset(userDataPath(), id) };
    } catch (err) { return safe(err); }
  });

  // ---- Prompt packs --------------------------------------------------
  ipcMain.handle('prompt-pack-list', async () => {
    try {
      const factory = await loadFactory();
      return {
        ok: true,
        defaultPackId: factory.defaultPackId,
        fieldMeta: factory.fieldMeta,
        packs: listPromptPacks(userDataPath(), factory),
      };
    } catch (err) { return safe(err); }
  });
  ipcMain.handle('prompt-pack-set', async (_event, packId, field, text) => {
    try {
      const factory = await loadFactory();
      if (typeof packId !== 'string' || typeof field !== 'string' || typeof text !== 'string') {
        throw new Error('Invalid prompt pack update.');
      }
      return { ok: true, pack: setPromptField(userDataPath(), factory, packId, field, text) };
    } catch (err) { return safe(err); }
  });
  ipcMain.handle('prompt-pack-reset', async (_event, packId) => {
    try {
      const factory = await loadFactory();
      if (typeof packId !== 'string') throw new Error('Invalid prompt pack id.');
      return { ok: true, pack: resetPromptPack(userDataPath(), factory, packId) };
    } catch (err) { return safe(err); }
  });

  // ---- Project configuration -------------------------------------------
  ipcMain.handle('project-config-get', async (_event, projectId) => {
    try {
      if (typeof projectId !== 'string' || projectId === '') throw new Error('Invalid project id.');
      ensureMigrated();
      const project = getProject(userDataPath(), projectId);
      const config = project.configuration ?? {
        credentialId: null,
        gameProfileId: DEFAULT_GAME_PROFILE_ID,
        commentaryPresetId: DEFAULT_COMMENTARY_PRESET_ID,
      };
      let credential = null;
      let credentialWarning = null;
      if (config.credentialId !== null) {
        try {
          const resolved = getCredentialForRun(userDataPath(), safeStorage, config.credentialId);
          if (resolved.record.purpose !== 'vision') throw new Error('Configuration is not a Vision credential.');
          credential = {
            id: resolved.record.id,
            name: resolved.record.name,
            provider: resolved.record.provider,
            model: resolved.record.model,
            baseUrl: resolved.record.baseUrl ?? null,
            verified: isCredentialVerifiedForRun(resolved.record),
          };
          if (!credential.verified) {
            credentialWarning = 'This configuration has not been verified for image input. Run image verification.';
          }
        } catch {
          credentialWarning = 'The saved API configuration is missing or unreadable. Choose another configuration.';
        }
      }
      let profile = null;
      let profileWarning = null;
      try {
        profile = getGameProfile(userDataPath(), config.gameProfileId);
      } catch {
        profileWarning = 'The saved game profile is missing. Choose another profile.';
      }
      let preset = null;
      let presetWarning = null;
      try {
        preset = getCommentaryPreset(userDataPath(), config.commentaryPresetId);
      } catch {
        presetWarning = 'The saved commentary preset is missing. Choose another preset.';
      }
      let packWarning = null;
      if (config.promptPackId !== null && config.promptPackId !== undefined) {
        try {
          const factory = await loadFactory();
          if (!factory.packs.some((pack) => pack.packId === config.promptPackId)) {
            packWarning = 'The saved prompt pack is unknown. Choose another pack.';
          }
        } catch {
          // Loader failure is not a configuration problem: the worker
          // validates the pack id again before any paid call.
        }
      }
      return {
        ok: true,
        configuration: { ...config },
        credential,
        profile,
        preset,
        warnings: [credentialWarning, profileWarning, presetWarning, packWarning].filter(Boolean),
      };
    } catch (err) {
      // Development diagnosis: the renderer keeps a generic message, but
      // the safe reason (ids and validation failures only, never secrets)
      // is logged here.
      try { console.error('[project-config-get] failed:', err?.message ?? err); } catch { /* never break IPC */ }
      return safe(err);
    }
  });
  ipcMain.handle('project-config-set', async (_event, projectId, configuration) => {
    try {
      if (typeof projectId !== 'string' || projectId === '') throw new Error('Invalid project id.');
      if (!configuration || typeof configuration !== 'object') throw new Error('Invalid project configuration.');
      // TTS overrides have a single validated writer (`tts-config-set`,
      // which checks catalogue membership and credential purpose); this
      // channel never accepts them, even though the store shape allows it.
      if (configuration.tts !== undefined) throw new Error('Save TTS overrides from the TTS Studio.');
      if (configuration.credentialId !== undefined && configuration.credentialId !== null) {
        // Validates existence + readability without exposing the secret.
        const resolved = getCredentialForRun(userDataPath(), safeStorage, configuration.credentialId);
        if (resolved.record.purpose !== 'vision') throw new Error('Choose a Vision API configuration for this project.');
      }
      if (configuration.gameProfileId !== undefined) getGameProfile(userDataPath(), configuration.gameProfileId);
      if (configuration.commentaryPresetId !== undefined) getCommentaryPreset(userDataPath(), configuration.commentaryPresetId);
      if (configuration.promptPackId !== undefined && configuration.promptPackId !== null) {
        const factory = await loadFactory();
        if (!factory.packs.some((pack) => pack.packId === configuration.promptPackId)) {
          throw new Error('Unknown prompt pack.');
        }
      }
      const project = updateProject(userDataPath(), projectId, { configuration });
      return { ok: true, configuration: project.configuration };
    } catch (err) {
      try { console.error('[project-config-set] failed:', err?.message ?? err); } catch { /* never break IPC */ }
      return safe(err);
    }
  });
  ipcMain.handle('provider-models', async (_event, providerId) => {
    try {
      const provider = getProvider(providerId);
      return { ok: true, provider: provider.id, models: provider.models.map((m) => ({ ...m })) };
    } catch (err) { return safe(err); }
  });
}
