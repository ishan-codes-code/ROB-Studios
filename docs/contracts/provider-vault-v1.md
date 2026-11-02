# Provider vault v1

Named, encrypted, multi-credential provider storage owned by the Electron
main process. The curated catalogue supports `meta` (Meta Model API),
`baseten` (Baseten), and `google-gemini-tts` (Google Gemini TTS). There
are no generic endpoints, no user-editable
base URLs, and no arbitrary model IDs — see
`electron/src/provider-catalog.mjs` for the curated catalogue.

## Files (under Electron `userData`)

- `provider-vault.json` — versioned index of non-secret credential records
  (`{version: 1, credentials: [...]}`), written atomically (tmp file +
  rename). Never holds key material.
- `credentials/<id>.enc` — one `safeStorage`-encrypted key per record,
  written atomically with mode `0o600`. Deleted by overwrite-then-unlink.

## Credential record (public shape, no secrets)

```json
{
  "id": "cred-9f3a2b1c4d5e6f70",
  "name": "Meta Personal",
  "provider": "meta",
  "purpose": "vision",
  "model": "muse-spark-1.3",
  "credentialVersion": 2,
  "createdAt": "2026-11-02T10:00:00.000Z",
  "updatedAt": "2026-11-02T11:00:00.000Z",
  "verification": {
    "status": "verified",
    "verifiedAt": "2026-11-02T11:00:00.000Z",
    "verifiedCredentialVersion": 2,
    "verifiedModel": "muse-spark-1.3"
  }
}
```

Google Gemini TTS records use `purpose: "tts"` and `model: null`; no fake
Vision model is stored. Their verification records use a null
`verifiedModel` and remain scoped to the exact credential version. Existing
Meta/Baseten records without `purpose` are interpreted as Vision records.
TTS records cannot be selected for project Vision processing.

`credentialVersion` increments on every key replacement.
For Vision credentials, `verification.status` is `verified` only after an
explicit user-initiated image-input check for that exact credential-version/
model pair. For TTS credentials, it is verified only after the separate
Google authentication and TTS model-metadata check succeeds. That check does
not generate speech and does not prove inference entitlement. Changing a key
or Vision model resets verification. Verification is never inferred from
catalogue membership and never runs in the background or at launch.

## Operations (main-process IPC)

Create, list, rename, set-key, set-model, test-connection,
verify-image / verify-TTS-authentication, delete. The renderer receives
only the public shape plus `keyAvailable` (whether the ciphertext exists
and decrypts), purpose, and provider display name. There is no read/reveal operation: key entry is
write-only, and saved keys render as "Credential stored securely" (or
"Key unreadable" when decryption fails).

## Security rules

- `safeStorage` unavailable, corrupted ciphertext, missing files,
  invalid IDs, and interrupted writes fail closed with secret-free
  errors. A credential counts as configured only if it decrypts.
- No plaintext fallback. No secret in `provider-vault.json`, settings,
  logs, IPC responses, error messages, worker argv/stdout/stderr, or
  renderer state.
- Deleting a credential referenced by any project is refused with the
  referencing project names; the caller must reassign those projects
  first. This covers TTS references too: a project TTS override or the
  global TTS default blocks deletion until reassigned. There is no
  silent substitution of another key — ever.
- TTS runs and previews resolve the key main-side from the selected
  purpose-`tts` record and hand it to Python exclusively through the
  `AI_COMMENTATOR_PROVIDER_API_KEY` child environment (see
  `tts-studio-v1.md`), beside — never mixed with — the vision key.
- TEMPORARY development-only exception: in unpackaged builds only,
  an explicit user opt-in permits memory-held credentials
  (`devOnly`) while OS encryption is unavailable. They never touch
  disk, clear on disable and quit, and production builds reject the
  bypass entirely. Secure storage stays preferred whenever available.

## Migration

Legacy M5 state (`settings.json` provider section + `provider-key.enc`)
migrates once, only when the vault is empty: a base URL matching a
known provider yields one named credential (model kept when it is in
the curated catalogue, otherwise the provider default), plus custom
game/preset records when legacy style preferences differ from the
built-ins. New records are written and validated first; only then is
the legacy key archived to `provider-key.enc.migrated` (never deleted
outright). Unmappable URLs and undecryptable keys migrate nothing and
report a reconfiguration notice. See `docs/contracts/` for the legacy
`application-settings-v1.md` snapshot.
