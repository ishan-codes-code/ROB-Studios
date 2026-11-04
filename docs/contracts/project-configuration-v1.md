# Project configuration v1

Per-project configuration. Credentials live once in the vault and are
referenced by ID; game metadata is owned directly by the project. No
API keys or credential records are ever duplicated into project
directories.

## Shape (`project.json`, `configuration` field, schema version unchanged)

```json
{
  "configuration": {
    "credentialId": "cred-9f3a2b1c4d5e6f70",
    "game": {
      "id": "free-fire",
      "matchType": "Battle Royale",
      "mode": "Squad",
      "map": "Bermuda",
      "category": "Ranked",
      "teams": ["Team A", "Team B"],
      "tournament": null,
      "stage": null,
      "language": "English",
      "additionalContext": ""
    },
    "promptPackId": null
  }
}
```

- `credentialId`: vault credential ID, or `null` (nothing selected).
  Explicit selection is required for paid runs: with several saved
  credentials the app never guesses; with exactly one, the UI may offer
  it as the initial selection but still persists the explicit choice.
- `game`: project-owned match metadata. `id` is one of the supported
  game ids (`free-fire`, `cod`, `bgmi`, mirroring the prompt-pack
  catalog; unknown ids are rejected so unsupported games never reach
  a run). `matchType`, `mode`, `map`, `category`, `tournament`,
  `stage` are optional short strings (null when unset); `language`
  defaults to `English` and drives commentary language; `teams` holds
  up to 8 short entries; `additionalContext` holds up to 2000 chars
  of free-form match context. Bounds mirror the retired library
  (short fields ≤ 80 chars). Suggestion lists live in the
  project-owned catalog (`electron/src/lib/games.js`); the store
  validates bounds only, so legacy free-text values always read
  back. `category`/`tournament`/`stage` persist but are not yet
  composed into worker context (see Run snapshot).
- `promptPackId`: game prompt-pack ID, or `null` for the application
  default (`free-fire`). Validated against the factory packs on save;
  see [game-pack-v1.md](game-pack-v1.md).

New projects start with default game metadata and no credential.
Pre-migration projects without `configuration` default on read and
persist on the next update.

## Rules

- The credential reference is validated against the vault on write;
  unknown IDs are rejected.
- Deleting a credential referenced by a project is refused with the
  referencing project names.
- Opening a project resolves its references through audited
  main-process APIs. Missing or unreadable references surface as
  configuration warnings with a remediation path — never as a silent
  switch to another key.

## Legacy migration (game profiles / commentary presets)

Projects saved with `gameProfileId` / `commentaryPresetId` migrate on
read: custom profile match context becomes `game.additionalContext`
and the custom preset language becomes `game.language`; anything
unresolvable falls back to the Free Fire defaults. Migration is
in-memory and idempotent — the stored file keeps its legacy fields
until the next explicit configuration save, and `game-library.json`
is never written or deleted (custom personality/tone/instructions
have no project-owned equivalent and stay in that file, ignored).

## Run snapshot

At run start the main process resolves the project's configuration
into a non-secret runtime snapshot (provider, model, key, bounded
game/prompt preferences) and passes only that snapshot to the worker
child environment. Later UI edits cannot change a running job. The
Python process never receives the vault. Worker preferences keep the
long-standing `{game: {id, context}, prompt: {personality, tone,
language, instructions}}` shape: `context` is composed from the
project's game metadata, and personality/tone mirror the retired
built-in preset (`Esports commentator` / `energetic`), so runs behave
exactly as before. See
[worker-runtime-config.md](worker-runtime-config.md).
