# Contract: derived gameplay interpretation v1 (`gameplay-v1`)

Versioned schema for the deterministic interpretation layer between
validated vision observations and gameplay reasoning. Produced in memory
by `build_gameplay_state` from validated
`observation-v1`/`observation-v2` documents plus their `match-state-v1`
snapshot; consumed in memory by event detection, commentary gating, and
narrative construction. Strict validation: anything not conforming is
rejected, never guessed.

## Why this stage exists

Raw observations describe visible things; gameplay reasoning needs
interpreted signals (posture, combat activity, entity references) and
cautious cross-frame identity. This contract is where the previously
unused `observation-v2` structured keys (`subjects`, `action`,
`spatial`) finally contribute: they are read here, deterministically,
alongside description and evidence text. No model call happens at this
stage and no new claim enters: every tag quotes wording already present
in a validated observation.

## Three levels, kept separate

- **Observation:** what is directly visible. The `observed` tag list of
  each entry — wording literally present (entity token, posture word,
  combat word, Blue Wall word, zone word, HUD counter, feed mention,
  throwable/vehicle words, quoted action/spatial).
- **Interpretation:** what the evidence suggests. The `inferred` tag
  list — weak single-entry suggestions (`possible_engagement_cue`,
  `possible_movement_cue`, `possible_zone_pressure_cue`) that require
  corroboration. Inferred tags never trigger single-sighting event
  rules on their own.
- **Confirmed event:** what the evidence is sufficient to establish.
  This document confirms nothing. Confirmation-shaped judgments live
  only in `events-v1` rules, which cite this document's signals plus
  their own temporal requirements.

## Schema

Top-level value must be a JSON object with exactly these fields:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `schema_version` | string | yes, must equal `"gameplay-v1"` | Contract version |
| `latest_timestamp` | number or null | yes | Latest source timestamp, from match state |
| `fact_signals` | array of fact-signal objects | yes (may be empty) | Merged signals per exact fact key, sorted by (category, description) |
| `entities` | array of entity-track objects | yes (may be empty) | Cautious identity tracks, sorted by (first_seen, ref) |
| `summary` | object | yes | Bounded counts and derived lists (see below) |

Each fact-signal object has exactly these fields: `category`
(non-empty string), `description` (non-empty string), `observed`
(sorted array of non-empty strings), `inferred` (sorted array of
non-empty strings), `entities` (array of `{label, kind}` objects,
sorted by label).

Each entity-track object has exactly these fields:

| Field | Type | Meaning |
|---|---|---|
| `ref` | non-empty string | Track identity: the exact on-screen label, or `unknown-<source>-<index>` |
| `kind` | non-empty string | `player`/`team`/`other` from `subjects`, `token` for bare `TAG.NAME` text, `unknown` for unlabeled sightings |
| `identity` | `exact-label` or `unknown` | How the track was formed |
| `first_seen` | number | Earliest sighting timestamp |
| `last_seen` | number | Latest sighting timestamp |
| `status` | `observed`, `reappeared`, or `occluded` | Derived (see below) |
| `posture` | string or null | Latest posture word, or null when none was worded |
| `movement` | object or null | `{from, to}` differing spatial phrases, or null |
| `sightings` | non-empty array of sighting objects | Every sighting, sorted by (timestamp, source) |

Each sighting object has exactly these fields: `timestamp` (number),
`source` (non-empty string), `fact_key` (two-element `[category,
description]` list), `spatial` (string, empty when unquoted), `action`
(string, empty when unquoted), `posture` (string or null), `observed`
(list of strings).

`summary` has exactly these fields: `entity_count` (labeled tracks),
`unknown_sightings` (unlinked tracks), `combat_active` (boolean:
combat wording present and the latest timestamp observed),
`moved_entities` (sorted refs with movement), `reappeared_entities`
(sorted refs with status `reappeared`), `occluded_entities` (sorted
refs with status `occluded`).

## Identity and status rules

- Sightings group by **exact label string only**. Similar labels
  (`AG.BAROS` vs `AG.BARON`) are never merged; occlusion, camera
  changes, and ambiguous appearances never justify a merge.
- Entries without an entity label yield one unlinked `unknown-` track
  each. Unknown tracks never join another sighting across frames.
- `observed`: last seen at the latest timestamp with no wide gap.
  `reappeared`: last seen at the latest timestamp after a gap wider
  than `ENTITY_REAPPEAR_GAP_S` (6 seconds). `occluded`: not seen at
  the latest timestamp — a visibility gap, never an elimination, a
  departure, or a revive claim.
- `movement` is set only when two non-empty spatial phrases from the
  same track differ (compared case-insensitively, originals kept). A
  single movement word is only a `possible_movement_cue` inference,
  never confirmed repositioning.

## Signal lexicon

Tags derive from explicit word lists in `state/gameplay.py`
(`POSTURE_WORDS`, `COMBAT_WORDS`, `KNOCKDOWN_WORDS`, `REVIVE_WORDS`,
`BLUE_WALL_WORDS`, `GRENADE_WORDS`, `SMOKE_WORDS`, `VEHICLE_WORDS`,
`ZONE_WORDS`, `ELIM_WORDS`, `MOVEMENT_WORDS`, `SCENERY_WORDS`).
Load-bearing distinctions:

- Knockdown words (`knocked`, `downed`, `crawling`, ...) tag
  `knockdown` and `posture`, never `elim`. A down player is down, not
  eliminated.
- Only explicit outcome words (`eliminated`, `killed`, `finished`,
  `flush`, ...) tag `elim`.
- `blue wall` and `gloo wall` tag `blue_wall`; a bare `shield` never
  does. A Blue Wall is cover, not a conventional shield.
- `revive` words tag `revive`; a reappearing player without them is
  reappearance, never a revive.
- Scenery nouns (`grass`, `road`, `billboard`, ...) tag `scenery` so
  the significance gate can tell standalone environment description
  from gameplay-linked context. The tag suppresses nothing by itself.

## Determinism and persistence

Inputs sort before grouping; every list is emitted sorted; the
document contains no wall-clock time and no random ids. The same
observations plus snapshot always yield the same document regardless
of input order. The document is **never persisted**: it is rebuilt in
memory wherever it is needed, so there is no artifact file, no
migration, and no stale-snapshot surface beyond the inputs it derives
from.

## Compatibility

Changes to this contract require bumping `schema_version` and
reviewing all consumers (event detection, commentary gating,
narrative). Adding a signal tag is a minor but review-gated change
(document it here first); changing identity, status, or movement
semantics is breaking.
