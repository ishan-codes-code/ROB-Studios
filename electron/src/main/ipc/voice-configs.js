// Reusable voice-configuration library IPC (Electron main process).
//
// Channels (all validated main-side; the renderer is never trusted):
// - `voice-config-list` () -> { ok, configs }
// - `voice-config-create` (input) -> { ok, config }
// - `voice-config-update` (id, patch) -> { ok, config }
// - `voice-config-delete` (id) -> { ok, deleted, id }
//
// Entries carry a vault credential *reference*, never key material.
// Catalogue membership and credential existence stay apply-time
// concerns (the existing `tts-config-set` gates); saving only pins
// the provider from vault metadata when the credential resolves.
import { listCredentials } from '../../credentials-store.mjs';
import {
  createVoiceConfig,
  deleteVoiceConfig,
  listVoiceConfigs,
  updateVoiceConfig,
} from '../../voice-config-store.mjs';

function fail(ipcName, err, fallback) {
  try { console.error(`[${ipcName}] failed:`, err?.message ?? err); } catch { /* never break IPC */ }
  return { ok: false, error: err?.message ?? fallback };
}

/**
 * Pin `providerId` from the referenced credential's vault metadata.
 * Best-effort: an unreadable vault keeps the caller's value (store
 * validation still requires a known TTS provider), and a dangling
 * credential id is tolerated — apply-time gates resolve it. A
 * credential that resolves to a non-TTS purpose is rejected: a voice
 * preset must never point at a vision credential.
 */
function stampProviderFromCredential(userDataPath, safeStorage, input) {
  const credentialId = input?.credentialId;
  if (credentialId === null || credentialId === undefined) return input;
  let records;
  try {
    records = listCredentials(userDataPath, safeStorage);
  } catch {
    return input;
  }
  if (!Array.isArray(records)) return input;
  const match = records.find((entry) => entry?.id === credentialId);
  if (!match) return input;
  if (match.purpose !== 'tts') {
    throw new Error('Choose a TTS credential for a voice configuration.');
  }
  if (typeof match.provider === 'string' && match.provider !== '') {
    return { ...input, providerId: match.provider };
  }
  return input;
}

export function registerVoiceConfigIpc({ ipcMain, app, safeStorage = null }) {
  const userData = () => app.getPath('userData');

  ipcMain.handle('voice-config-list', async () => {
    try {
      return { ok: true, configs: listVoiceConfigs(userData()) };
    } catch (err) { return fail('voice-config-list', err, 'Could not load voice configurations.'); }
  });

  ipcMain.handle('voice-config-create', async (_event, input = {}) => {
    try {
      const stamped = stampProviderFromCredential(userData(), safeStorage, input ?? {});
      return { ok: true, config: createVoiceConfig(userData(), stamped) };
    } catch (err) { return fail('voice-config-create', err, 'Could not save the voice configuration.'); }
  });

  ipcMain.handle('voice-config-update', async (_event, id, patch = {}) => {
    try {
      const stamped = patch && typeof patch === 'object' && patch.credentialId !== undefined
        ? stampProviderFromCredential(userData(), safeStorage, patch)
        : patch;
      return { ok: true, config: updateVoiceConfig(userData(), id, stamped ?? {}) };
    } catch (err) { return fail('voice-config-update', err, 'Could not save the voice configuration.'); }
  });

  ipcMain.handle('voice-config-delete', async (_event, id) => {
    try {
      return { ok: true, ...deleteVoiceConfig(userData(), id) };
    } catch (err) { return fail('voice-config-delete', err, 'Could not delete the voice configuration.'); }
  });
}
