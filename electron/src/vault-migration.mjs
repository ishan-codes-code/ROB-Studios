// One-way migration from the legacy M5 single-key setup to the vault.
//
// Legacy state: `settings.json` (global provider {type, baseUrl, model,
// modelVisionVerified} + game/prompt prefs) and at most one
// `provider-key.enc` ciphertext. Migration creates one named credential
// (only when the legacy base URL maps cleanly to a supported provider),
// preserves game context / commentary preferences as custom library
// records when they differ from the built-ins, and only then archives
// the legacy key file. Nothing is deleted before the new records are
// safely written and validated. Unmappable URLs are left untouched with
// a reconfiguration notice; undecryptable keys produce a "re-enter key"
// outcome without inventing a replacement.
import fs from 'node:fs';
import path from 'node:path';

import { inferProviderFromBaseUrl, getProvider } from './provider-catalog.mjs';
import { DEFAULT_SETTINGS } from './settings-defaults.mjs';

const LEGACY_KEY_FILE = 'provider-key.enc';
const LEGACY_KEY_ARCHIVE = 'provider-key.enc.migrated';

function readLegacySettings(userDataPath, loadSettings) {
  try {
    return loadSettings(userDataPath);
  } catch {
    return null;
  }
}

function readLegacyKey(userDataPath, safeStorage) {
  const file = path.join(userDataPath, LEGACY_KEY_FILE);
  if (!fs.existsSync(file)) return { present: false, key: '' };
  try {
    if (safeStorage?.isEncryptionAvailable?.() !== true) {
      return { present: true, key: '', decryptable: false };
    }
    const key = safeStorage.decryptString(fs.readFileSync(file));
    if (typeof key !== 'string' || key === '') {
      return { present: true, key: '', decryptable: false };
    }
    return { present: true, key, decryptable: true };
  } catch {
    return { present: true, key: '', decryptable: false };
  }
}

function differsFromDefaultPrompt(prompt) {
  const defaults = DEFAULT_SETTINGS.prompt;
  return prompt.personality !== defaults.personality
    || prompt.tone !== defaults.tone
    || prompt.language !== defaults.language
    || (prompt.instructions ?? '') !== defaults.instructions;
}

/**
 * Run the migration when the vault has no credentials yet.
 * Returns a summary `{ migrated, credentialId, archivedLegacyKey,
 * gameProfileId, commentaryPresetId, notice }`. `migrated` is false when
 * there was nothing to migrate or migration was not possible; `notice`
 * carries a human-readable, secret-free explanation in every case.
 */
export function migrateLegacyVault(userDataPath, {
  safeStorage,
  loadSettings,
  vaultHasCredentials,
  createCredential,
  markCredentialVerified,
  createGameProfile,
  createCommentaryPreset,
}) {
  if (vaultHasCredentials()) {
    return { migrated: false, notice: 'Credential vault already initialized.' };
  }
  const settings = readLegacySettings(userDataPath, loadSettings);
  const legacy = readLegacyKey(userDataPath, safeStorage);
  if (!legacy.present) {
    return { migrated: false, notice: 'No legacy credential found; starting fresh.' };
  }
  if (!settings) {
    return { migrated: false, notice: 'Legacy settings are unreadable; re-enter the API key.' };
  }
  const provider = inferProviderFromBaseUrl(settings.provider?.baseUrl);
  if (!provider) {
    return {
      migrated: false,
      notice: 'The previous custom provider URL is not a supported Meta or Baseten endpoint. Create a new API configuration.',
    };
  }
  if (!legacy.decryptable) {
    return {
      migrated: false,
      provider,
      notice: 'The previous API key could not be decrypted. Re-enter the key in a new API configuration.',
    };
  }
  const displayName = getProvider(provider).displayName;
  let credential;
  try {
    credential = createCredential({
      name: `Migrated ${displayName}`,
      provider,
      model: settings.provider?.model,
      key: legacy.key,
    });
  } catch {
    // Model outside the curated catalogue (or any validation failure):
    // retry with the provider default so the key itself is preserved.
    try {
      const fallback = getProvider(provider).models[0].id;
      credential = createCredential({
        name: `Migrated ${displayName}`,
        provider,
        model: fallback,
        key: legacy.key,
      });
    } catch {
      return { migrated: false, provider, notice: 'Legacy credential could not be migrated safely.' };
    }
  }
  if (settings.provider?.modelVisionVerified === true
    && settings.provider?.model === credential.model) {
    try {
      markCredentialVerified(credential.id, credential.model);
    } catch { /* stays unverified; user can verify explicitly */ }
  }
  let gameProfileId = null;
  let commentaryPresetId = null;
  try {
    if (typeof settings.game?.context === 'string' && settings.game.context !== '') {
      const profile = createGameProfile({ name: 'Migrated Free Fire', context: settings.game.context });
      gameProfileId = profile.id;
    }
    if (differsFromDefaultPrompt(settings.prompt ?? {})) {
      const preset = createCommentaryPreset({
        profileId: gameProfileId ?? 'free-fire-default',
        name: 'Migrated style',
        personality: settings.prompt?.personality ?? '',
        tone: settings.prompt?.tone ?? '',
        language: settings.prompt?.language ?? '',
        instructions: settings.prompt?.instructions ?? '',
      });
      commentaryPresetId = preset.id;
    }
  } catch { /* preferences stay in legacy settings; vault credential stands */ }
  // Only now that every new record is safe: archive (never delete) the key.
  let archivedLegacyKey = false;
  try {
    fs.renameSync(
      path.join(userDataPath, LEGACY_KEY_FILE),
      path.join(userDataPath, LEGACY_KEY_ARCHIVE),
    );
    archivedLegacyKey = true;
  } catch { /* original stays; a repeat run will not duplicate (vault non-empty) */ }
  return {
    migrated: true,
    credentialId: credential.id,
    archivedLegacyKey,
    gameProfileId,
    commentaryPresetId,
    notice: `Migrated one ${displayName} configuration. Verify image support before paid runs.`,
  };
}
