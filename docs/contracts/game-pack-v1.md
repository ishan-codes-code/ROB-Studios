# Contract: game prompt packs v1 (`game-pack-v1`)

Versioned schema for the game-specific LLM prompt wording the
application sends. Three factory packs ship with the app — Free Fire,
Call of Duty, and Battlegrounds Mobile India (BGMI) — and users can
inspect, customize, reset, and per-project select them. Factory defaults
are never overwritten: custom wording overlays individual fields, and
resetting deletes the overlay.

## What a pack holds (and what it must not)

A pack holds **editable natural-language wording only**: the vision
subject/coverage/sampling/closing paragraphs, the script persona,
priorities, rules, and closing, the commentary-writer persona and
rules, plus the pack's game label and default game context. The exact
field list is defined once in Python (`PACK_FIELDS` in
`python/ai_commentator/prompts/packs.py`) and travels with the factory
probe document, so the UI never hardcodes it.

A pack must never hold JSON response shapes, schema labels, evidence
validators, claim gates, or timestamp logic. Those stay in the prompt
builders (`vision/client.py`, `script/generation.py`,
`commentary/writer.py`) and their deterministic validators, which keep
enforcing correctness no matter how the wording is edited. Custom text
is bounded per field (see the probe document's `max_chars`) and treated
as untrusted input: Python re-validates every custom field before any
paid call.

## Factory source of truth

`python/prompt_packs.py` is the single source of truth for factory
wording and field metadata. It is an offline one-shot probe (no key, no
network) printing one JSON document:

```json
{
  "ok": true,
  "schema_version": "game-pack-v1",
  "version": 1,
  "default_pack_id": "free-fire",
  "fields": {
    "vision_intro": {"label": "Vision subject", "description": "…", "max_chars": 500}
  },
  "packs": [
    {"pack_id": "free-fire", "display_name": "Free Fire", "version": 1, "fields": {"vision_intro": "…"}}
  ]
}
```

Electron loads it once per session through the cached
`createPromptPackLoader` (`electron/src/prompt-packs.mjs`) and validates
the untrusted output with `normalizeFactoryPacks`. The renderer receives
packs only through the `prompt-pack-list` IPC response.

## Custom store (`prompt-packs.json`)

Global Electron `userData` file holding **custom text only**:

```json
{"version": 1, "custom": {"cod": {"script_closing": "Custom closing."}}}
```

Writes are atomic (temp file + rename, `0o600`). Unknown pack ids and
fields are rejected on write; a corrupt file fails loudly instead of
silently falling back. Resetting one field deletes its entry; resetting
a pack deletes all of its entries. Existing installs without this file
resolve pure factory defaults.

## Selection and precedence

Pack *selection* is per project: `project.json` `configuration`
`promptPackId` (`null` = application default, `free-fire`). Pack
*wording* is a shared global resource: the effective text for a run is
factory defaults plus that pack's global custom overlay. Resolution
order for a run:

1. Project override (`promptPackId`, when set)
2. Application default (`free-fire`)

At run start the main process snapshots `{packId, custom}` into
`AI_COMMENTATOR_SETTINGS_JSON.promptPack`
(see [worker-runtime-config.md](worker-runtime-config.md)); later UI
edits cannot change a running job. Projects saved before prompt packs
(`promptPackId` absent) read as `null` and keep their exact prior
behavior. Python resolves the environment selection last
(`prompt_pack_selection`), so standalone CLI runs can select a pack with
`--game-pack` / `AI_COMMENTATOR_PACK_ID`.

The effective vision game context is the pack's `game_context` field
followed by the user's per-profile context, so current profile settings
keep working unchanged.

## IPC surface

- `prompt-pack-list` → `{ok, defaultPackId, fieldMeta, packs}` where
  each pack carries factory `fields`, the `customized` field list, and
  `effective` (factory + overlay) for display.
- `prompt-pack-set` (`packId`, `field`, `text`) → `{ok, pack}`; empty
  text resets that field to factory.
- `prompt-pack-reset` (`packId`) → `{ok, pack}`; clears every custom
  field of that pack.

All inputs are validated main-side; renderer values are never trusted.

## Compatibility

- Adding a factory pack or field is additive: old custom stores stay
  valid, unknown stored entries are ignored until their pack/field
  exists.
- Removing or renaming a field requires a schema version bump; readers
  must reject unknown versions rather than guessing.
- The worker `--game-pack` flag and `AI_COMMENTATOR_PACK_ID` are the
  standalone equivalents of the project selection; Electron runs pass
  the resolved snapshot through the child environment instead.
