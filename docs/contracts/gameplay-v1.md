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
| `last_known_position` | string or null, optional | Latest quoted spatial phrase, or null when none was quoted |
| `positions` | array of `{timestamp, source, spatial}` objects, optional | Position-change sequence in sighting order (see below) |
| `engagements` | array of sighting-summary objects, optional | Chronological per-sighting summaries (see below) |
| `tracking_confidence` | `high`/`medium`/`low`, optional | Weakest contributing sighting label (see below) |

Each sighting object has exactly these fields: `timestamp` (number),
`source` (non-empty string), `fact_key` (two-element `[category,
description]` list), `spatial` (string, empty when unquoted), `action`
(string, empty when unquoted), `posture` (string or null), `observed`
(list of strings), and optional `tracking_confidence`
(`high`/`medium`/`low`, restating the entry's observation confidence
label).

Each `positions` element quotes one position change: the first quoted
position plus each later quoted position that differs from the previous
kept one (compared case-insensitively, originals kept). Each
`engagements` element summarizes one sighting — `timestamp`, `source`,
`action`, `spatial`, `posture`, `observed` — in the same order as
`sightings`. The track-level `tracking_confidence` is the weakest
sighting label, so a track is never stronger than any sighting behind
it. The four track fields and the sighting confidence are additive and
optional: documents without them still validate as `gameplay-v1`.

`summary` has exactly these fields: `entity_count` (labeled tracks),
`unknown_sightings` (unlinked tracks), `combat_active` (boolean:
combat wording present and the latest timestamp observed),
`moved_entities` (sorted refs with movement), `reappeared_entities`
(sorted refs with status `reappeared`), `occluded_entities` (sorted
refs with status `occluded`, labeled tracks only — unlinked `unknown-`
tracks stay in `entities` but out of this list).

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
`ZONE_WORDS`, `ELIM_WORDS`, `MOVEMENT_WORDS`, `SCENERY_WORDS`, plus
`WEAPON_WORDS`, `EQUIPMENT_WORDS`, `ROUND_STATE_WORDS`,
`MATCH_PHASE_WORDS`). All sixteen lists match as whole terms on word
boundaries (so `car` never fires inside `carpet`); the four newer
lists additionally match over label-blanked prose (`TAG.NAME` tokens
and subject labels removed), so entity labels are names, never
vocabulary. A negation guard applies to every list: text splits into
clauses on `[.;,]` and `and`/`but`/`or`, a match preceded in its
clause by a negation cue (`no`, `not`, `none`, `without`, `neither`,
`nor`, `absent`, `isn't`, `aren't`, `cannot`, `can't`) is ignored, a
trailing `not clearly visible` construction negates its clause, and a
whole comma/`and`/`or` list after a leading negation is negated (so
`No muzzle flash, tracer, grenade, smoke or vehicle` yields zero
tags); entries whose description opens with a negation cue never
contribute `combat`/`zone`/`grenade`/`smoke`/`vehicle`/`knockdown`/
`elim` tags.
Load-bearing distinctions:

- Knockdown words (`knocked`, `downed`, `crawling`, ...) tag
  `knockdown` and `posture`, never `elim`. A down player is down, not
  eliminated.
- Only explicit outcome words (`eliminated`, `killed`, ...) tag
  `elim` (`finished`/`flush` were removed: looting is not elimination).
- `blue wall` and `gloo wall` tag `blue_wall`; a bare `shield` never
  does. A Blue Wall is cover, not a conventional shield.
- `revive` words tag `revive`; a reappearing player without them is
  reappearance, never a revive.
- Scenery nouns (`grass`, `road`, `billboard`, ...) tag `scenery` so
  the significance gate can tell standalone environment description
  from gameplay-linked context. The tag suppresses nothing by itself.
- Weapon families and model names (`rifle`, `AK`, `M1014`, `ammo`,
  `reload`, ...) tag `weapon`. `gunfire` stays `combat`-only, and a
  gamertag like `SCAR.FACE` never tags `weapon`.
- Gear and consumables (`helmet`, `vest`, `medkit`, `loadout`,
  `loot`, ...) tag `equipment`. A Blue Wall stays `blue_wall`-tagged
  cover, never loadout; a bare `shield` tags nothing.
- Round and outcome markers (`round`, `match point`, `booyah`,
  `victory`/`defeat`, `winner`, `scoreboard`, ...) tag `round_state`.
  `around`/`ground` never match, and bare plural `rounds` is
  intentionally unmatched (ammunition vs game rounds).
- Phase and HUD-progression markers (`lobby`, `parachute`, `drop
  zone`, `alive`, `timer`, `end screen`, ...) tag `match_phase`. Bare
  `elim` is counter-only (`Elim 4`); `eliminated`/`elimination` stay
  `elim`-tagged outcomes and never tag `match_phase`. The kill feed is
  not tagged here (owned by event detection).

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
semantics is breaking. The `weapon`/`equipment`/`round_state`/
`match_phase` tags and the optional track/sighting reconstruction
fields are such an additive extension: `schema_version` stays
`gameplay-v1` and documents without them still validate.
