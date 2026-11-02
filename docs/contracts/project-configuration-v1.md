# Project configuration v1

Per-project references to shared configuration resources. Credentials,
game profiles, and commentary presets live once in their global stores;
a project stores only their IDs. No API keys or credential records are
ever duplicated into project directories.

## Shape (`project.json`, `configuration` field, schema version unchanged)

```json
{
  "configuration": {
    "credentialId": "cred-9f3a2b1c4d5e6f70",
    "gameProfileId": "free-fire-default",
    "commentaryPresetId": "default-energetic"
  }
}
```

- `credentialId`: vault credential ID, or `null` (nothing selected).
  Explicit selection is required for paid runs: with several saved
  credentials the app never guesses; with exactly one, the UI may offer
  it as the initial selection but still persists the explicit choice.
- `gameProfileId`: game-library profile ID (default `free-fire-default`).
- `commentaryPresetId`: preset ID (default `default-energetic`).

New projects start with the built-in game/preset defaults and no
credential. Pre-migration projects without `configuration` default on
read and persist on the next update.

## Rules

- References are validated against the vault and game library on write;
  unknown IDs are rejected.
- Deleting a credential, profile, or preset referenced by a project is
  refused with the referencing project names.
- Opening a project resolves its references through audited
  main-process APIs. Missing or unreadable references surface as
  configuration warnings with a remediation path — never as a silent
  switch to another key.

## Game library (global resources)

`game-library.json` persists custom Free Fire profiles and commentary
presets; the built-in `Free Fire — Default` profile and
`Default — Energetic` preset are synthesized in code and always exist.
Built-ins cannot be edited, renamed, or deleted; customs support
create/rename/edit/duplicate/delete within the same validation bounds
as the legacy settings (names ≤ 80 chars, context/instructions ≤ 2000,
personality/tone/language ≤ 80). User-editable prompts are style
preferences only: they never override observation schemas, evidence
requirements, claim gates, timestamp validation, or script checks.

## Run snapshot

At run start the main process resolves the project's references into a
non-secret runtime snapshot (provider, model, key, bounded game/prompt
preferences) and passes only that snapshot to the worker child
environment. Later UI edits cannot change a running job. The Python
process never receives the vault. See
[worker-runtime-config.md](worker-runtime-config.md).
