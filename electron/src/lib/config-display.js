// Pure project-configuration display helpers (renderer-safe, no IPC).
// Covered by electron/test/config-display.test.mjs.

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
