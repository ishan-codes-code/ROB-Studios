# 0012 — Game prompt packs with immutable factory defaults

- **Status** — accepted.

## Context

Prompts lived as hardcoded English strings inside the Python engine
(Free Fire wording in the vision/script/writer builders), invisible
and uneditable. The milestone needs game-specific packages (Free Fire,
Call of Duty, BGMI) that users can inspect, customize per prompt, and
select per project — without ever losing the shipped defaults, and
without letting wording edits corrupt schemas, gates, or validators.

## Decision

- Factory wording ships in Python (`ai_commentator/prompts/packs.py`)
  and is exposed read-only through the offline `prompt_packs.py` probe,
  following the TTS catalogue precedent. The renderer never hardcodes
  prompt text.
- Only natural-language wording is editable, in per-field units. JSON
  response shapes, schema labels, evidence gates, and deterministic
  validators stay in the builders and keep enforcing correctness.
- User edits overlay individual fields in a global custom-only store
  (`prompt-packs.json`, atomic writes). Reset deletes the overlay.
  Empty custom text falls back to factory.
- Selection is per project (`configuration.promptPackId`, null =
  application default `free-fire`), snapshotted main-side into
  `AI_COMMENTATOR_SETTINGS_JSON.promptPack` at run start. Python
  re-validates the pack id and every custom field before any paid call.
- Pre-migration projects (no `promptPackId`, no store file) resolve
  byte-identical Free Fire factory behavior, verified against HEAD
  output.

## Alternatives considered

- Duplicating factory wording in JavaScript for the UI: rejected —
  drift between the displayed text and the sent text would be a
  correctness bug. The probe keeps one source of truth.
- Storing full prompt copies per project: rejected — copies rot when
  factory wording improves, and bloat project files. Overlays stay
  minimal and selection stays a reference.
- Making response shapes editable: rejected — malformed shapes fail
  closed but produce confusing run failures; shapes are code, not copy.

## Consequences

- Prompt tuning is safe: the worst a bad edit does is produce
  honestly-reported run failures or omissions, never silent corruption.
- Adding a game means one factory pack plus probe output; no UI or
  store changes.
- The `game-pack-v1` contract owns the field list; removing or
  renaming a field needs a version bump.
