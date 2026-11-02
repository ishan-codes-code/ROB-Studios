# ADR 0009: Multi-credential encrypted vault and safe migration

- Status: Accepted
- Date: 2026-11-02

## Context

M5 stored one global provider configuration and one `provider-key.enc`.
Users need multiple named configurations per provider, per-key
verification state, and project-level selection — without secrets ever
reaching the renderer, logs, or settings files.

## Decision

Electron main process owns a vault: `provider-vault.json` (versioned
non-secret index) plus `credentials/<id>.enc` (one `safeStorage`
ciphertext each, atomic writes, `0o600`, overwrite-then-unlink
deletion). Records carry name/provider/model, a `credentialVersion`
bumped on key rotation, and verification bound to the exact
credential-version/model pair; any key or model change resets to
`unverified`. Reads probe decryption so a credential counts as
configured only when actually readable. Deletion while referenced by a
project is refused with project names; nothing silently substitutes
another key.

Migration from legacy M5 runs once when the vault is empty: only a
base URL matching a known provider maps to a credential; game/prompt
preferences become library records when they differ from the built-ins;
the legacy key file is archived (not deleted) after the new records
validate. Unmappable URLs and undecryptable keys migrate nothing and
report reconfiguration.

## Consequences

Renderer sees only sanitized public records plus `keyAvailable`.
Preload gains narrow `credential-*` methods; the old single-key IPC
remains for compatibility. Secure-storage outages, corruption, and
missing files fail closed. See
`docs/contracts/provider-vault-v1.md`.
