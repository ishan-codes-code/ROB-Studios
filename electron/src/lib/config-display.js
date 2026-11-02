// Pure project-configuration display helpers (renderer-safe, no IPC).
// Covered by electron/test/config-display.test.mjs.

export const BUILT_IN_PRESET_ID = 'default-energetic';

/** Presets selectable for a profile: its own plus the built-in default. */
export function presetsForProfile(presets, profileId) {
  if (!Array.isArray(presets)) return [];
  return presets.filter(
    (entry) => entry && (entry.profileId === profileId || entry.id === BUILT_IN_PRESET_ID),
  );
}

/** True when the resolved project config can start a paid run. */
export function isRunReady(config) {
  return config?.credential?.verified === true && (config?.warnings ?? []).length === 0;
}

/** One-line label for a credential option. Never includes key material. */
export function credentialLabel(credential) {
  if (!credential) return 'No configuration';
  const verified = credential.verification?.status === 'verified' ? 'verified' : 'unverified';
  return `${credential.name} · ${credential.model} · ${verified}`;
}

/** One-line label for a commentary preset option. */
export function presetLabel(preset) {
  if (!preset) return 'Default style';
  const style = [preset.tone, preset.language].filter(Boolean).join(' · ');
  return style ? `${preset.name} · ${style}` : preset.name;
}
