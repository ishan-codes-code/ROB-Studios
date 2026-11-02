// Multi-credential provider vault (Electron main process only).
//
// Secrets live exclusively in per-credential ciphertext files under
// `<userData>/credentials/<id>.enc`, encrypted with Electron
// `safeStorage`. The index `<userData>/provider-vault.json` holds only
// non-secret metadata (names, provider/model, verification state) and
// never key material. The renderer receives sanitized public records;
// decrypted keys cross only into the worker child environment.
//
// Guarantees: atomic writes (tmp file + rename), strict schema
// validation, no plaintext fallback, no secret in errors/logs/IPC,
// corruption is reported (never silently defaulted), and verification
// is invalidated whenever the credential or model changes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  validateProviderModel,
  getProvider,
} from './provider-catalog.mjs';

export const VAULT_VERSION = 1;
export const CREDENTIALS_DIR_NAME = 'credentials';
const VAULT_FILE_NAME = 'provider-vault.json';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_NAME_LENGTH = 80;
const MAX_KEY_LENGTH = 4096;

function assertSafeStorage(safeStorage) {
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function'
    || typeof safeStorage.encryptString !== 'function'
    || typeof safeStorage.decryptString !== 'function') {
    throw new Error('Secure credential storage is unavailable on this device.');
  }
  if (safeStorage.isEncryptionAvailable() !== true) {
    throw new Error('Secure credential storage is unavailable on this device.');
  }
}

function validateName(name) {
  if (typeof name !== 'string') throw new Error('Configuration name must be a string.');
  const trimmed = name.trim();
  if (trimmed === '') throw new Error('Configuration name must not be empty.');
  if (trimmed.length > MAX_NAME_LENGTH) throw new Error('Configuration name is too long.');
  return trimmed;
}

function validateId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new Error('Invalid credential id.');
  }
  return id;
}

function newId() {
  return `cred-${crypto.randomBytes(8).toString('hex')}`;
}

function nowIso() {
  return new Date().toISOString();
}

function unverifiedState() {
  return Object.freeze({
    status: 'unverified',
    verifiedAt: null,
    verifiedCredentialVersion: 0,
    verifiedModel: null,
  });
}

function validateVerification(value, where) {
  if (!value || typeof value !== 'object') throw new Error(`Invalid verification state (${where}).`);
  if (value.status !== 'verified' && value.status !== 'unverified') {
    throw new Error(`Invalid verification status (${where}).`);
  }
  if (value.status === 'verified') {
    if (typeof value.verifiedAt !== 'string' || Number.isNaN(Date.parse(value.verifiedAt))) {
      throw new Error(`Invalid verification timestamp (${where}).`);
    }
    if (!Number.isInteger(value.verifiedCredentialVersion) || value.verifiedCredentialVersion < 1) {
      throw new Error(`Invalid verified credential version (${where}).`);
    }
    return {
      status: 'verified',
      verifiedAt: value.verifiedAt,
      verifiedCredentialVersion: value.verifiedCredentialVersion,
      verifiedModel: value.verifiedModel ?? null,
    };
  }
  return { ...unverifiedState() };
}

function validateRecord(value) {
  if (!value || typeof value !== 'object') throw new Error('Invalid credential record.');
  validateId(value.id);
  const name = validateName(value.name);
  const { provider, model } = validateProviderModel(value.provider, value.model);
  if (!Number.isInteger(value.credentialVersion) || value.credentialVersion < 1) {
    throw new Error('Invalid credential version.');
  }
  for (const key of ['createdAt', 'updatedAt']) {
    if (typeof value[key] !== 'string' || Number.isNaN(Date.parse(value[key]))) {
      throw new Error('Invalid credential timestamps.');
    }
  }
  let verification = validateVerification(value.verification, value.id);
  const purpose = getProvider(provider).purpose ?? 'vision';
  if (verification.status === 'verified'
    && (purpose === 'tts' ? verification.verifiedModel !== null
      : typeof verification.verifiedModel !== 'string' || verification.verifiedModel === '')) {
    throw new Error('Invalid verification target.');
  }
  if (verification.status === 'verified' && verification.verifiedModel !== model) {
    // The resolved model no longer matches the tested one (e.g. a retired
    // model identifier was normalized): the old success cannot vouch for
    // the current model, so verification must run again.
    verification = { ...unverifiedState() };
  }
  return {
    id: value.id,
    name,
    provider,
    purpose,
    model,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    credentialVersion: value.credentialVersion,
    verification,
  };
}

function validateVaultDocument(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid credential vault.');
  }
  if (value.version !== VAULT_VERSION) throw new Error('Unsupported credential vault version.');
  if (!Array.isArray(value.credentials)) throw new Error('Invalid credential vault.');
  const seen = new Set();
  const records = value.credentials.map((entry) => {
    const record = validateRecord(entry);
    if (seen.has(record.id)) throw new Error('Duplicate credential id.');
    seen.add(record.id);
    return record;
  });
  records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { version: VAULT_VERSION, credentials: records };
}

export function vaultPath(userDataPath) {
  return path.join(userDataPath, VAULT_FILE_NAME);
}

export function credentialsDir(userDataPath) {
  return path.join(userDataPath, CREDENTIALS_DIR_NAME);
}

export function credentialFile(userDataPath, id) {
  validateId(id);
  const dir = credentialsDir(userDataPath);
  const file = path.join(dir, `${id}.enc`);
  const relative = path.relative(dir, file);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Invalid credential id.');
  }
  return file;
}

function writeAtomicText(target, text) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, text, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, target);
  } finally {
    if (fs.existsSync(temp)) {
      try { fs.unlinkSync(temp); } catch { /* best effort */ }
    }
  }
}

function writeSecretAtomic(target, encrypted) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, encrypted, { flag: 'w', mode: 0o600 });
    fs.renameSync(temp, target);
  } finally {
    if (fs.existsSync(temp)) {
      try { fs.unlinkSync(temp); } catch { /* best effort */ }
    }
  }
}

/** Load + validate the vault index. Missing file means an empty vault. */
export function loadVault(userDataPath) {
  const file = vaultPath(userDataPath);
  if (!fs.existsSync(file)) return { version: VAULT_VERSION, credentials: [] };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error('The credential vault is corrupted and cannot be read.');
  }
  try {
    return validateVaultDocument(parsed);
  } catch {
    throw new Error('The credential vault is corrupted and cannot be read.');
  }
}

function saveVault(userDataPath, records) {
  const document = validateVaultDocument({ version: VAULT_VERSION, credentials: records });
  writeAtomicText(vaultPath(userDataPath), `${JSON.stringify(document, null, 2)}\n`);
  return document;
}

function probeKeyAvailable(userDataPath, safeStorage, id) {
  try {
    const file = credentialFile(userDataPath, id);
    if (!fs.existsSync(file)) return false;
    const cipher = fs.readFileSync(file);
    if (!cipher || cipher.length === 0) return false;
    const plain = safeStorage.decryptString(cipher);
    return typeof plain === 'string' && plain.length > 0;
  } catch {
    return false;
  }
}

export function toPublicRecord(record, keyAvailable) {
  return {
    id: record.id,
    name: record.name,
    provider: record.provider,
    providerDisplayName: getProvider(record.provider).displayName,
    purpose: getProvider(record.provider).purpose ?? 'vision',
    model: record.model,
    credentialVersion: record.credentialVersion,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    keyAvailable: keyAvailable === true,
    verification: { ...record.verification },
  };
}

/** Sanitized list: never throws for one bad entry; flags it unavailable. */
export function listCredentials(userDataPath, safeStorage) {
  assertSafeStorage(safeStorage);
  const vault = loadVault(userDataPath);
  return vault.credentials.map((record) => {
    let available = false;
    try {
      available = probeKeyAvailable(userDataPath, safeStorage, record.id);
    } catch {
      available = false;
    }
    return toPublicRecord(record, available);
  });
}

function findRecordOrThrow(records, id) {
  const record = records.find((entry) => entry.id === id);
  if (!record) throw new Error('Credential configuration not found.');
  return record;
}

function writeKeyFile(userDataPath, safeStorage, id, key) {
  if (typeof key !== 'string' || key.trim() === '' || key.length > MAX_KEY_LENGTH) {
    throw new Error('API key must be a non-empty string under 4096 characters.');
  }
  let encrypted;
  try {
    encrypted = safeStorage.encryptString(key);
  } catch {
    throw new Error('Secure credential storage is unavailable on this device.');
  }
  if (!encrypted || encrypted.length === 0) {
    throw new Error('Secure credential storage is unavailable on this device.');
  }
  writeSecretAtomic(credentialFile(userDataPath, id), encrypted);
}

function wipeFile(file) {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    size = 0;
  }
  try {
    if (size > 0) fs.writeFileSync(file, Buffer.alloc(Math.min(size, 65536), 0));
  } catch { /* best effort */ }
  try {
    fs.unlinkSync(file);
  } catch { /* already gone */ }
}

export function createCredential(userDataPath, safeStorage, { name, provider, model, key } = {}) {
  assertSafeStorage(safeStorage);
  const cleanName = validateName(name);
  const validated = validateProviderModel(provider, model);
  const vault = loadVault(userDataPath);
  if (vault.credentials.some((entry) => entry.name.toLowerCase() === cleanName.toLowerCase())) {
    throw new Error('A configuration with this name already exists.');
  }
  const timestamp = nowIso();
  const record = {
    id: newId(),
    name: cleanName,
    provider: validated.provider,
    model: validated.model,
    createdAt: timestamp,
    updatedAt: timestamp,
    credentialVersion: 1,
    verification: { ...unverifiedState() },
  };
  // Write the secret first: the index only references keys already on disk.
  writeKeyFile(userDataPath, safeStorage, record.id, key);
  try {
    saveVault(userDataPath, [...vault.credentials, record]);
  } catch (err) {
    try { wipeFile(credentialFile(userDataPath, record.id)); } catch { /* best effort */ }
    throw err;
  }
  return toPublicRecord(record, true);
}

export function renameCredential(userDataPath, safeStorage, id, name) {
  assertSafeStorage(safeStorage);
  validateId(id);
  const cleanName = validateName(name);
  const vault = loadVault(userDataPath);
  const record = findRecordOrThrow(vault.credentials, id);
  if (vault.credentials.some((entry) => entry.id !== id && entry.name.toLowerCase() === cleanName.toLowerCase())) {
    throw new Error('A configuration with this name already exists.');
  }
  const next = { ...record, name: cleanName, updatedAt: nowIso() };
  saveVault(userDataPath, vault.credentials.map((entry) => (entry.id === id ? next : entry)));
  return toPublicRecord(next, probeKeyAvailable(userDataPath, safeStorage, id));
}

export function setCredentialKey(userDataPath, safeStorage, id, key) {
  assertSafeStorage(safeStorage);
  validateId(id);
  const vault = loadVault(userDataPath);
  const record = findRecordOrThrow(vault.credentials, id);
  writeKeyFile(userDataPath, safeStorage, id, key);
  const next = {
    ...record,
    credentialVersion: record.credentialVersion + 1,
    verification: { ...unverifiedState() },
    updatedAt: nowIso(),
  };
  saveVault(userDataPath, vault.credentials.map((entry) => (entry.id === id ? next : entry)));
  return toPublicRecord(next, true);
}

export function setCredentialModel(userDataPath, safeStorage, id, model) {
  assertSafeStorage(safeStorage);
  validateId(id);
  const vault = loadVault(userDataPath);
  const record = findRecordOrThrow(vault.credentials, id);
  const validated = validateProviderModel(record.provider, model);
  if (validated.model === record.model) {
    return toPublicRecord(record, probeKeyAvailable(userDataPath, safeStorage, id));
  }
  const next = {
    ...record,
    model: validated.model,
    verification: { ...unverifiedState() },
    updatedAt: nowIso(),
  };
  saveVault(userDataPath, vault.credentials.map((entry) => (entry.id === id ? next : entry)));
  return toPublicRecord(next, probeKeyAvailable(userDataPath, safeStorage, id));
}

export function deleteCredential(userDataPath, safeStorage, id) {
  assertSafeStorage(safeStorage);
  validateId(id);
  const vault = loadVault(userDataPath);
  findRecordOrThrow(vault.credentials, id);
  saveVault(userDataPath, vault.credentials.filter((entry) => entry.id !== id));
  wipeFile(credentialFile(userDataPath, id));
  return { deleted: true, id };
}

export function markCredentialVerified(userDataPath, safeStorage, id, model) {
  assertSafeStorage(safeStorage);
  validateId(id);
  const vault = loadVault(userDataPath);
  const record = findRecordOrThrow(vault.credentials, id);
  if (record.purpose === 'tts'
    ? model !== null
    : (typeof model !== 'string' || model !== record.model)) {
    throw new Error('Verification target does not match the saved configuration.');
  }
  if (!probeKeyAvailable(userDataPath, safeStorage, id)) {
    throw new Error('Secure API credential is unavailable. Check secure storage.');
  }
  const next = {
    ...record,
    verification: {
      status: 'verified',
      verifiedAt: nowIso(),
      verifiedCredentialVersion: record.credentialVersion,
      verifiedModel: record.model,
    },
    updatedAt: nowIso(),
  };
  saveVault(userDataPath, vault.credentials.map((entry) => (entry.id === id ? next : entry)));
  return toPublicRecord(next, true);
}

export function markCredentialUnverified(userDataPath, safeStorage, id) {
  assertSafeStorage(safeStorage);
  validateId(id);
  const vault = loadVault(userDataPath);
  const record = findRecordOrThrow(vault.credentials, id);
  if (record.verification.status === 'unverified') {
    return toPublicRecord(record, probeKeyAvailable(userDataPath, safeStorage, id));
  }
  const next = {
    ...record,
    verification: { ...unverifiedState() },
    updatedAt: nowIso(),
  };
  saveVault(userDataPath, vault.credentials.map((entry) => (entry.id === id ? next : entry)));
  return toPublicRecord(next, probeKeyAvailable(userDataPath, safeStorage, id));
}

export function isCredentialVerifiedForRun(record) {
  return record.verification.status === 'verified'
    && record.verification.verifiedModel === record.model
    && record.verification.verifiedCredentialVersion === record.credentialVersion;
}

/**
 * Resolve a credential for one processing run. Returns
 * `{ provider, model, apiKey }`. Throws when the record is missing,
 * the ciphertext is absent/corrupt/undecryptable, or the stored secret
 * is empty. Verification gating stays with the caller so it can report
 * the precise "run image verification" remediation.
 */
export function getCredentialForRun(userDataPath, safeStorage, id) {
  assertSafeStorage(safeStorage);
  validateId(id);
  const vault = loadVault(userDataPath);
  const record = findRecordOrThrow(vault.credentials, id);
  let apiKey = '';
  try {
    apiKey = safeStorage.decryptString(fs.readFileSync(credentialFile(userDataPath, id)));
  } catch {
    throw new Error('Secure API credential is unavailable. Check secure storage.');
  }
  if (typeof apiKey !== 'string' || apiKey === '') {
    throw new Error('Secure API credential is unavailable. Check secure storage.');
  }
  return { provider: record.provider, model: record.model, apiKey, record };
}
