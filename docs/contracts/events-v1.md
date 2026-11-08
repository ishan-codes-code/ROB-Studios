# Contract: evidence-grounded events v1 (`events-v1`)

Versioned schema for gameplay events detected offline from validated
`observation-v1`/`observation-v2` JSON files and their `match-state-v1`
snapshot (roadmap
milestone 5). Produced by the `--detect-events` path into
`output/events/events.json`; the detector performs no vision calls, no text
interpretation beyond explicit pattern matching, and no Free Fire reasoning.
A changed state is not automatically a gameplay event: an event fires only
when a defined rule's evidence requirements are fully satisfied.

## Schema

Top-level value must be a JSON object with exactly these fields:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `schema_version` | string | yes, must equal `"events-v1"` | Contract version |
| `generated_from` | object | yes | Replay provenance (see below) |
| `rules_evaluated` | sorted array of non-empty strings | yes (may be empty) | Every detection rule that ran, whether or not it fired |
| `contested_timestamps` | sorted array of numbers | yes (may be empty) | Timestamps skipped because divergent documents disagree there |
| `events` | array of event objects | yes (may be empty) | Emitted events, sorted by (timestamp, type, id) |

`generated_from` has exactly these fields:

| Field | Type | Meaning |
|---|---|---|
| `observations` | sorted array of non-empty strings | Every accepted observation filename |
| `match_state` | non-empty string | State snapshot filename (`match_state.json`) |

Each event object has exactly these fields:

| Field | Type | Meaning |
|---|---|---|
| `schema_version` | string | Always `"events-v1"` (each event is self-describing) |
| `id` | non-empty string | Deterministic id (`evt-` + 12 hex chars) derived from the event's canonical content |
| `type` | non-empty string | Rule name that fired (v1: `kill_feed_entry`, `elim_count_increased`, `elim_streak`, `feed_cluster`, `combat_engagement`, `knockdown_observed`, `revive_observed`, `blue_wall_use`, or `zone_pressure`) |
| `timestamp` | number | Timestamp semantics per rule (see "Rules" below): the triggering observation's timestamp |
| `status` | `candidate` | v1 emits candidates only — supported, never certified (see "Statuses" below) |
| `rule` | non-empty string | Rule name and version that fired (e.g. `kill_feed_entry/v1`) |
| `sources` | non-empty array of source refs, sorted | Every accepted observation the event rests on |
| `evidence` | non-empty array of non-empty strings | Precise quoted text satisfying the rule |
| `confidence` | `high`/`medium`/`low` | The weakest of the contributing observations' model confidence labels — a label, not proof |
| `detail` | non-empty string | Why the evidence satisfies the rule, in plain words |

Each source ref has exactly these fields: `timestamp` (number),
`file` (non-empty string), `fact_id` (non-empty string, the
`match-state-v1` fact the trigger claim was filed under).

## Statuses

v1 has a single status: `candidate`. A candidate is a claim the stored
evidence supports under a stated rule — it is not a certified fact. Nothing
in v1 can confirm an event (confirmation would require corroboration rules
that do not exist yet), so the detector never emits `confirmed` or any other
status, and validators reject anything but `candidate`. A future version may
add confirmation rules; that change review-gates on this contract.

## Rules (v1)

Rules are intentionally few and strict. Each rule names its trigger fields,
its timestamp semantics, and what it refuses to conclude.

### `kill_feed_entry` (rule `kill_feed_entry/v1`)

Fires when one validated `hud` observation visibly transcribes a kill-feed
entry. All of the following must hold:

- The entry's category is `hud` and its confidence is `high` or `medium`.
- Its description references a feed explicitly (contains `kill feed`,
  `killfeed`, `elimination feed`, or `elim feed`, case-insensitive).
- Its evidence transcribes at least two *distinct* name tokens of the form
  `TAG.NAME` (e.g. `RRQ.JEEK`), quoting the feed line.

Timestamp: the transcribing observation's timestamp. The event cites the
single observation (plus its state fact) and quotes the evidence. Killer and
victim roles are **not** assigned — the detail states that roles are not
established without verb semantics. A feed mention without transcribed names
(e.g. "kill feed lines" noted as truncated or uncertain) does not fire.

### `elim_count_increased` (rule `elim_count_increased/v1`)

Fires when the same team-scoped elimination counter is read at two
timestamps with a strictly greater integer. All of the following must hold:

- Both readings come from `hud` observations with confidence `high` or
  `medium`.
- Each reading's description contains an `Elim <integer>` counter and a
  team label in the same sentence; the counter is attributed to the nearest
  team label (the preceding one wins ties), and the two readings share the
  identical team (exact string match — similar names are never merged).
  Dots inside `TAG.NAME` tokens do not end sentences.
- Comparisons are per-team: each reading is checked against the
  previous reading for the same team, so another team's interleaved
  counter neither joins nor blocks the pair.
- The later reading's integer is strictly greater than the earlier one's.

Timestamp: the later reading's timestamp. The event cites both observations
(with their state fact ids) and quotes both counter readings. The event
claims only that the counter increased — never who was eliminated, by whom,
or by what means. Equal readings, decreases, resets, and counters without a
shared scope token are suppressed (a decrease may mean a new game, not an
event).

### `elim_streak` (rule `elim_streak/v1`)

Fires when the same team-scoped elimination counter is read at three
or more timestamps as a strictly increasing chain (at least two
strictly-increasing steps) whose total span fits
`EVENT_STREAK_WINDOW_S` seconds (initial value 30; a tuning
placeholder, not a product decision). All of the following must hold:

- Every reading comes from a `hud` observation with confidence `high`
  or `medium`, scoped exactly like `elim_count_increased` readings
  (an `Elim <integer>` counter and a team label in the same sentence,
  attributed to the nearest team label, preceding wins ties).
- Timestamps and counters both strictly increase along the chain;
  within one team's readings, equal readings and decreases break
  the chain into maximal runs, each evaluated independently.
  Readings scoped to other teams form their own chains and neither
  join nor break this team's chain.
- The chain's span (last timestamp minus first) fits the window.

Timestamp: the last reading's timestamp. The event cites every
reading (with state fact ids) and quotes every counter sentence;
confidence is the weakest of the chained readings' labels. It claims only that the
counter rose through the quoted steps — never who was eliminated, by
whom, or by what means. Pairwise `elim_count_increased` events still
fire for each increasing step alongside the streak.

### `feed_cluster` (rule `feed_cluster/v1`)

Fires when two or more `kill_feed_entry`-satisfying `hud`
observations fall within `EVENT_CLUSTER_WINDOW_S` seconds (initial
value 10; a tuning placeholder) with pairwise-disjoint transcribed
name-token sets. All of the following must hold:

- Each entry independently satisfies the `kill_feed_entry` predicate
  (`hud`, `high`/`medium`, explicit feed mention, at least two
  distinct `TAG.NAME` tokens in evidence).
- In timestamp order, each entry after the first joins the cluster
  only when its span from the cluster start fits the window and none
  of its name tokens appeared in an earlier cluster entry; otherwise
  the cluster closes and a new one opens (greedy, deterministic).

Timestamp: the last entry's timestamp. The event cites every entry
(with state fact ids) and quotes every description and evidence
string; confidence is the weakest of the entries' labels. The event
claims only a candidate grouping: disjoint names are necessary but
not sufficient proof of distinct entries (re-sightings with
transcription variance group the same way), so whether the entries
are distinct or repeated sightings of the same entry is explicitly
not established. Killer and victim roles are **not** assigned. A
lone feed entry, overlapping name sets, and spans beyond the window
never cluster.

### `combat_engagement` (rule `combat_engagement/v1`)

Fires when combat activity is observed at two or more distinct
timestamps whose span fits `EVENT_ENGAGEMENT_WINDOW_S` seconds
(initial value 15; a tuning placeholder). A sighting is a `combat`
observation with confidence `high` or `medium`, or a `character`
observation with `high`/`medium` confidence and explicit combat
wording; generic character visibility without combat wording is not a
sighting. Sightings cluster greedily in timestamp order (a sighting
joins the open cluster when its span from the cluster start fits the
window, otherwise the cluster closes and a new one opens); only
clusters spanning at least two distinct timestamps emit.

Timestamp: the last sighting's timestamp. The event cites every
sighting (with state fact ids) and quotes every description and
evidence string; confidence is the weakest of the sightings' labels.
It claims only that combat activity was observed across those
sightings — never who fought whom, who won, or why it started. One
frame of combat wording is a sighting, never an engagement.

### `knockdown_observed` (rule `knockdown_observed/v1`)

Fires when one `character` or `combat` observation with confidence
`high` or `medium` explicitly words a player knocked down (knockdown
wording per `gameplay-v1`, e.g. knocked, downed, crawling) without
elimination wording. The rule fires at the first sighting of its exact
wording; a re-sighting (a down player who stays down) is not a new
event.

Timestamp: the wording observation's timestamp. The event claims only
that a player was observed down — elimination is explicitly not
established, and a down player can be revived. A prone figure without
knockdown wording is not a knockdown.

### `revive_observed` (rule `revive_observed/v1`)

Fires when one `character` or `combat` observation with confidence
`high` or `medium` explicitly words a revive. First-sighting
semantics, as for `knockdown_observed`: re-sightings are not new
events.

Timestamp: the wording observation's timestamp. The event claims only
that revive wording was observed — who revived whom is not
established. A reappearing player without revive wording is
reappearance, never a revive.

### `blue_wall_use` (rule `blue_wall_use/v1`)

Fires when one `environment`, `character`, or `combat` observation
with confidence `high` or `medium` explicitly words Blue Wall cover
(`blue wall` or the `gloo wall` item alias; a bare `shield` never
matches). First-sighting semantics: re-sightings are not new events.

Timestamp: the wording observation's timestamp. The event claims only
that Blue Wall cover was observed — who placed it and when are not
established. A Blue Wall is cover, never a conventional shield.

### `zone_pressure` (rule `zone_pressure/v1`)

Fires when one `environment`, `character`, `hud`, or `combat`
observation with confidence `high` or `medium` explicitly words zone
developments (zone wording per `gameplay-v1`, e.g. safe zone,
shrinking, zone circle). First-sighting semantics: a persistent banner
fires once at its first sighting and re-sightings are not new events.

Timestamp: the wording observation's timestamp. The event claims only
that zone wording was observed — who is affected is not established.
Bare timer readings and uninterpreted counters still yield nothing.

Significance between event types is deterministic but computed, not
stored: `feed_cluster` > `elim_streak` > `combat_engagement` >
`knockdown_observed` > `elim_count_increased` > `kill_feed_entry` >
`revive_observed` > `blue_wall_use` > `zone_pressure`, tie-broken by
(timestamp, id) at gating and rendering time. No stored significance
field exists.

## Suppressed claims (never events in v1)

- A missing nameplate does not establish an elimination, knock, or wipe.
- A newly seen player or nameplate does not establish movement or arrival.
- A changed HUD number or timer whose meaning is not established by quoted
  evidence does not establish anything (timers, alive-counts, and
  uninterpreted counters included; explicit zone wording such as "Safe
  Zone is now shrinking" is a `zone_pressure` candidate, not a number
  reading).
- A persistent HUD element (tournament branding, a standing banner, a
  minimap) re-observed across frames is filed as re-sightings, never as
  repeated events. Single-sighting gameplay rules fire once at the first
  sighting of their exact wording.
- Low-confidence trigger claims are suppressed: rules require `high` or
  `medium` source confidence.
- Conflicted facts (first seen at a contested timestamp) and contested
  timestamps (divergent documents for one timestamp) are skipped entirely —
  never resolved in favor of the newest or most confident document.
- Elimination wording outside kill-feed and elimination-counter evidence
  (a bare "eliminated" in a character description) is not an elimination
  event: confirmation stays with feed and counter evidence.
- A reappearing player without revive wording is reappearance, never a
  revive; an occluded (out-of-view) entity is never an elimination.
- One frame of combat wording is a sighting, never an engagement.
- Intentions, off-screen fights, kills, team eliminations, and match
  outcomes are never inferred.

## Identity and deduplication

An event id is `evt-` plus the first 12 hex characters of the SHA-256 of
the canonical JSON object (sorted keys, compact separators) over
`type`, `timestamp`, `status`, `rule`, `sources`, `evidence`, `detail`,
and `confidence`. The same inputs therefore
always yield the same ids, and repeated detection of the same trigger
collapses to one event: within a run, two triggers producing the same id
emit once; across runs, identical inputs produce byte-identical output
files. Observation duplicates (same timestamp and content hash) are skipped
before detection and never double-count.

## Determinism and replay

Inputs sort by (timestamp, filename) before detection; event lists sort by
(timestamp, type, id); ids and the state-derived fact ids are deterministic;
no wall-clock time, randomness, or arrival order leaks into the output. The
detector additionally refuses to run on a stale snapshot: the state's
(timestamps, content hashes) must exactly cover the discovered observation
files, otherwise it exits non-zero telling the operator to rebuild state
first. Replaying the same observation directory plus its snapshot always
reproduces the same `events.json`.

## Validation and malformed input

Every observation is parsed, `observation-v1`/`observation-v2`-validated, and
timestamp-checked before detection; the state snapshot is
`match-state-v1`-validated; the emitted document is `events-v1`-validated
before its atomic write. A malformed observation or an invalid state is
rejected with a clear per-file reason and a non-zero exit — never applied,
never written into the output, and never allowed to corrupt stored
observations, stored state, or a previous valid events file.

## What v1 does not do

- Certify truth (`confirmed` status), resolve uncertainties, or upgrade a
  model confidence label into proof.
- Interpret ambiguous numbers, merge similar names, or read intentions.
- Emit events for the five stored real observations unless their evidence
  satisfies a rule — a changed state alone is not an event.
- Call any API, write to the frames or observations directories, or modify
  sources and state. Detection output goes only to `output/events/`.

## Compatibility

Changes to this contract require bumping `schema_version` and reviewing all
consumers. Adding a rule is a minor but review-gated change (new `type`
values must be documented here first); tightening, renaming, or removing is
breaking. Consumers must tolerate unknown `type`/`status` values gracefully
(treat as opaque) rather than crashing.
