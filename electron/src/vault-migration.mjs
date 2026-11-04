// One-way migration from the legacy M5 single-key setup to the vault.
//
// Legacy state: `settings.json` (global provider {type, baseUrl, model,
// modelVisionVerified} + game/prompt prefs) and at most one
// `provider-key.enc` ciphertext. Migration creates one named credential
// (only when the legacy base URL maps cleanly to a supported provider)
// and only then archives the legacy key file. Legacy game/commentary
// preferences stay untouched in the old settings file: game metadata is
// project-owned now and there is no library to preserve them into.
// Nothing is deleted before the new credential is safely written and
// validated. Unmappable URLs are left untouched with a reconfiguration
// notice; undecryptable keys produce a "re-enter key" outcome without
// inventing a replacement.
import fs from 'node:fs';
import path from 'node:path';

import { inferProviderFromBaseUrl, getProvider } from './provider-catalog.mjs';

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

/**
 * Run the migration when the vault has no credentials yet.
 * Returns a summary `{ migrated, credentialId, archivedLegacyKey,
 * notice }`. `migrated` is false when there was nothing to migrate or
 * migration was not possible; `notice` carries a human-readable,
 * secret-free explanation in every case.
 */
export function migrateLegacyVault(userDataPath, {
  safeStorage,
  loadSettings,
  vaultHasCredentials,
  createCredential,
  markCredentialVerified,
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
  // Only now that the credential record is safe: archive (never
  // delete) the key. Legacy game/prompt preferences stay in the old
  // settings file, untouched.
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
    notice: `Migrated one ${displayName} configuration. Verify image support before paid runs.`,
  };
}
