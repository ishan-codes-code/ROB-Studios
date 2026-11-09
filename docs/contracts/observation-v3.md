# Contract: broadcast observation v3 (`observation-v3`)

Versioned schema for one validated vision-model observation of a
single gameplay frame, read as a broadcast overlay: HUD values
(round timer, team scores, alive pips, focus player) plus visible
event cues — never prose descriptions. Produced by the broadcast
vision call, consumed by the broadcast pipeline (ADR 0017). Strict
validation: anything not conforming is rejected, never guessed.

Core rule: **unknown = null, never prose negations.** A value that is
not visible or unreadable is `null`. Observations report only what is
visible; they never list absent things and never carry sentences
about what is NOT visible.

## Schema

Top-level value must be a JSON object with exactly these fields:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `schema_version` | string | yes, must equal `"observation-v3"` | Contract version |
| `timestamp` | number (int or float) | yes | Frame position in seconds within the source video, as stated in the prompt |
| `scene` | string, one of `gameplay`, `spectate`, `lobby`, `loading`, `results`, `menu`, `cutscene`, `unknown` | yes | What kind of screen is shown |
| `round` | round object | yes | Round clock and number (see below) |
| `teams` | array of team objects | yes (may be empty) | One entry per side shown on the scoreboard |
| `focus` | focus object or null | yes | The spectated/featured player, or null when none is featured |
| `in_view` | array of in-view objects | yes (may be empty) | Other named or sided players visible in frame |
| `cues` | array of cue objects | yes (may be empty) | Event cues clearly visible in this frame |
| `notes` | non-empty string (`<=140` chars) or null | yes | One short positive sentence, or null |
| `confidence` | string, one of `high`, `medium`, `low` | yes | How certain the reading is |

The `round` object has exactly these fields:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `timer` | string `MM:SS` or null | yes | Round clock as shown (`timer` is `MM:SS` or null) |
| `timer_red` | boolean | yes | Whether the timer renders red (low time) |
| `round_no` | integer or null | yes | Current round number |

Each team object has exactly these fields:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | non-empty string | yes | Team id: stable letters (`A`, `B`, ...) |
| `color` | non-empty string | yes | Whatever color the HUD shows for this side |
| `score` | integer or null | yes | Rounds/points won |
| `alive` | integer or null | yes | Players alive, from the pips row |
| `total` | integer or null | yes | Roster size, from the pips row |

Team ids are unique within a document. `alive`/`total` come from the
pips row; `alive` never exceeds `total` when both are known.

The `focus` object (when not null) has exactly these fields:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `name` | non-empty string or null | yes | Focus player name as shown |
| `team` | non-empty string or null | yes | Focus player's team id |
| `weapon` | non-empty string or null | yes | Focus player's weapon as shown |
| `state` | string, one of `alive`, `knocked`, `spectating`, `dead` | yes | Focus player's state |
| `hp_pct` | integer `0`–`100` or null | yes | Focus player's health percent |

Each `in_view` object has exactly these fields: `name` (non-empty
string or null), `team` (non-empty string or null), `state`
(required, one of `alive`, `knocked`, `spectating`, `dead`).

Each `cues` object has exactly these fields: `cue` (required, one of
the cue enum below) and `evidence` (required, non-empty string of at
most 12 words quoting what is visible).

`cues[].cue` belongs to the pack-configurable cue enum (default
list):

`muzzle_flash`, `tracer`, `knock_indicator`,
`elimination_banner`, `kill_feed_entry`, `damage_numbers`, `grenade`,
`smoke`, `zone_shrinking`, `revive`, `vehicle`, `victory_banner`,
`defeat_banner`, `round_start`, `round_end`.

All numeric fields are integers or null: `round_no`, `score`,
`alive`, `total`, `hp_pct`. Booleans are never accepted where an
integer is required, and integers are never accepted where a boolean
(`timer_red`) is required.

## Validation rules

Reject with a clear error (never silently accept or fabricate):

- Malformed JSON, empty output, or a non-object top level.
- Missing/wrong-typed fields, bad enum values, or any unknown extra
  field at any level.
- Non-integer numbers (including booleans) where integers are
  required; non-boolean values for `timer_red`.
- `alive` greater than `total` when both are known.
- `hp_pct` outside `0`–`100`.
- `timer` present but not matching `^\d{1,2}:\d{2}$`.
- Duplicate team ids.
- `evidence` empty or longer than 12 words; `notes` empty or longer
  than 140 characters.

## Absent vs null vs unknown

- An absent key is a validation error: every field above is required
  at its level (`focus` and the nullable leaves carry explicit `null`
  instead of going missing).
- Explicit `null` means not visible or unreadable. There is no other
  way to say unknown: prose negations (`No ...`, `not visible`,
  `nothing ...`) never appear in a valid document.
- `notes` carries at most one short positive sentence; silence is
  `null`, never an empty string and never a sentence about absence.

## Token budget

A typical v3 document runs ~150–250 tokens of model output (vs ~2,600
for a prose observation). Callers size `max_output_tokens` for a few
hundred tokens of JSON plus margin; prose-observation output budgets
must not be reused for this call.

## Example: mid-fight frame

```json
{
  "schema_version": "observation-v3",
  "timestamp": 12.5,
  "scene": "gameplay",
  "round": {"timer": "01:23", "timer_red": false, "round_no": 2},
  "teams": [
    {"id": "A", "color": "blue", "score": 1, "alive": 4, "total": 4},
    {"id": "B", "color": "red", "score": 0, "alive": 3, "total": 4}
  ],
  "focus": {"name": "VORCA_Raj", "team": "A", "weapon": "M1887", "state": "alive", "hp_pct": 80},
  "in_view": [{"name": null, "team": "B", "state": "alive"}],
  "cues": [{"cue": "muzzle_flash", "evidence": "yellow flash at weapon muzzle"}],
  "notes": "VORCA_Raj holds the lane with an M1887.",
  "confidence": "high"
}
```

## Example: quiet-lobby frame

```json
{
  "schema_version": "observation-v3",
  "timestamp": 0.0,
  "scene": "lobby",
  "round": {"timer": null, "timer_red": false, "round_no": null},
  "teams": [],
  "focus": null,
  "in_view": [],
  "cues": [],
  "notes": null,
  "confidence": "high"
}
```

## Compatibility

- `observation-v3` is a new, distinct schema. It does not change the
  meaning of `observation-v1` or `observation-v2`: legacy documents
  stay valid, the legacy `validate_observation` accepts only v1/v2
  (v3 documents are rejected there), and v1/v2-shaped input is
  rejected by the v3 validator.
- The legacy pipeline (state, events, commentary, script, worker,
  streaming) reads v1/v2 only. v3 gains consumers only through the
  broadcast pipeline (ADR 0017); no existing consumer is rewired.
- Field additions require a new schema version; readers must reject
  unknown top-level or nested fields rather than guessing.
- The cue enum default lives in `OBSERVATION_V3_CUES`
  (`python/ai_commentator/config.py`); packs may configure their own
  list, and validation takes the effective list as input.
