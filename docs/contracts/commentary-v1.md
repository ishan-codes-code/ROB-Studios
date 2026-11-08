# Contract: evidence-grounded commentary v1 (`commentary-v1`)

Versioned schema for concise commentary lines generated offline from
validated `observation-v1`/`observation-v2` JSON files, their
`match-state-v1` snapshot, and
their `events-v1` candidates (roadmap milestone 7). Produced by the
`--generate-commentary` path into `output/commentary/commentary.json`;
consumed in the future by TTS (milestone 8). The generator performs no
vision calls and no Free Fire reasoning: wording comes only from
deterministic templates over evidence-gated claims.

A central rule of this contract: **containment and token checks are
necessary but not sufficient evidence of support.** A line is justified
only when it was produced by its template from inputs satisfying that
template's evidence-shape precondition (see "Templates"). Validation
therefore checks the template's required inputs, not just the text.

## Schema

Top-level value must be a JSON object with exactly these fields:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `schema_version` | string | yes, must equal `"commentary-v1"` | Contract version |
| `generated_from` | object | yes | Replay provenance (see below) |
| `prior_commentary` | object | yes | How the previous output file was treated (see below) |
| `rules_evaluated` | sorted array of non-empty strings | yes (may be empty) | Every gating rule that ran, whether or not it fired |
| `lines` | array of line objects | yes (may be empty) | Emitted commentary, sorted by (timestamp, seq, id); empty means deliberate silence |
| `suppressed` | array of suppression objects | yes (may be empty) | Everything considered and rejected, with reasons |

`generated_from` has exactly these fields:

| Field | Type | Meaning |
|---|---|---|
| `observations` | sorted array of non-empty strings | Every accepted observation filename |
| `match_state` | non-empty string | State snapshot filename (`match_state.json`) |
| `events` | non-empty string | Events filename (`events.json`) |

`prior_commentary` has exactly these fields:

| Field | Type | Meaning |
|---|---|---|
| `file` | non-empty string | Previous commentary filename (`commentary.json`) |
| `status` | `absent`, `ok`, or `ignored-malformed` | `absent`: no prior file (first run); `ok`: prior file parsed and used for repeat suppression; `ignored-malformed`: prior file unreadable or invalid — run proceeded as a first run |

Each line object has exactly these fields:

| Field | Type | Meaning |
|---|---|---|
| `schema_version` | string | Always `"commentary-v1"` (each line is self-describing) |
| `id` | non-empty string | Run-unique line id (`cmt-` + 12 hex chars, derived like event ids) |
| `claim_id` | non-empty string | Stable claim identity (`clm-` + 12 hex chars over canonical type, template, evidence, source ids, and latest evidence timestamp — identical evidence re-emits nothing; new-timestamp evidence is a new claim) |
| `timestamp` | number | Latest supporting evidence timestamp — never wall-clock time |
| `seq` | non-negative integer | Position within its timestamp, assigned in emission order |
| `type` | `scene`, `development`, or `event_echo` | Claim kind (see "Templates") |
| `template` | non-empty string | Gating template key for the claim; must be listed in "Templates". Names the precondition that justified the claim, not necessarily the wording path (writer-mode text is natural, not templated) |
| `text` | non-empty string | The speakable sentence: a fixed template prefix plus verbatim validated strings (deterministic mode), or natural wording that still contains every evidence quote verbatim (writer mode) |
| `sources` | non-empty array of source refs, sorted | Observation refs, each `{timestamp, file, fact_id}` with the fact present in state |
| `event_id` | string or null | The candidate event id for `event_echo`; null otherwise |
| `evidence` | non-empty array of non-empty strings | Quoted strings from the cited observations; each must occur verbatim in both the cited observation text and the line text |
| `confidence` | `high`/`medium`/`low` | The minimum of the cited sources' model confidence labels — inherited, never scored, never higher than any source |
| `qualification` | string or null | Required non-null for `event_echo` (fixed qualifier text); must be null for `scene`/`development` |

Each suppression object has exactly these fields: `rule` (non-empty
string, the gating rule name), `subject` (non-empty string, fact id,
event id, or description of what was considered), `reason` (non-empty
string, plain words).

## Templates

Normative list. Each template names its evidence-shape precondition and
its single allowed claim. The renderer implements exactly these mappings
and no other wording path; a line naming any other template is invalid.

### `scene_visible`

- Precondition: exactly one fact with state status `current`, category
  `environment` or `character`, latest-sighting confidence `high` or
  `medium`, not from a contested timestamp, no uncertainty string in
  any source file naming a quoted token of the claim, and passing the
  broadcast-significance gate (see "Gating rules").
- Allowed claim: restate that fact's description at its latest timestamp.
- Text shape: `"At {timestamp}s, visible: {description}"` with
  `{description}` verbatim.

### `hud_reading`

- Precondition: exactly one fact with state status `current`, category
  `hud`, confidence `high` or `medium`, same contest/uncertainty
  conditions as `scene_visible`, and passing the
  broadcast-significance gate.
- Allowed claim: quote the HUD reading exactly as described, attaching no
  meaning to the numbers.
- Text shape: `"HUD reads: {description}"` with `{description}` verbatim.

### `development_new` / `development_update`

- Precondition: a `new_fact` / `update` change at the latest processed
  timestamp whose fact satisfies the category/confidence/contest rules of
  `scene_visible` (hud-sourced facts keep the same verbatim-description
  shape, which attaches no meaning to the numbers) and passes the
  broadcast-significance gate.
- Allowed claim: restate the changed fact's description verbatim.
- Text shapes: `"New development: {description}"` /
  `"Update: {description}"`.

### `event_echo`

- Precondition: an `events-v1` event with status `candidate` whose every
  cited fact is non-conflicted in state. Echoes always clear the
  significance gate: their rule evidence is the gameplay link.
- Allowed claim: quote the event's evidence and state that it is
  unconfirmed.
- Text shape: `"{evidence quote} — unconfirmed: {qualifier}"` where
  `{qualifier}` is fixed per rule (`kill_feed_entry`: `"killer and victim
  roles are not established"`; `elim_count_increased`: `"who was
  eliminated, by whom, and by what means are not established"`;
  `knockdown_observed`: `"elimination is not established; a down player
  can be revived"`; `revive_observed`: `"who revived whom is not
  established"`; `blue_wall_use`: `"who placed it and when are not
  established"`; `zone_pressure`: `"who is affected is not
  established"`).
  The qualifier slot has no variable path: the renderer holds no other
  wording for this template.

### `event_sequence`

- Precondition: an `events-v1` event with status `candidate` from a
  temporal rule (`elim_streak`, `feed_cluster`, `combat_engagement`)
  whose every cited fact is non-conflicted in state.
- Allowed claim: quote the event's evidence (every reading or entry
  in the sequence) and state that it is unconfirmed.
- Text shape: `"Sequence: {evidence quotes} — unconfirmed:
  {qualifier}"` where `{qualifier}` is fixed per rule
  (`elim_streak`: `"who was eliminated, by whom, and by what means
  are not established"`; `feed_cluster`: `"killer and victim roles
  are not established"`; `combat_engagement`: `"participants,
  outcome, and cause are not established"`). The line type stays
  `event_echo`, so the qualifier, uncertainty, and validator rules
  for echoes apply unchanged; only the template key differs.

Event echoes (both templates) gate and render in significance order
(`feed_cluster` > `elim_streak` > `combat_engagement` >
`knockdown_observed` > `elim_count_increased` > `kill_feed_entry` >
`revive_observed` > `blue_wall_use` > `zone_pressure`, tie-broken by
timestamp then identity) after developments and scene wording.

## Gating rules

Rules are evaluated in order; the first failure for a candidate emits one
`suppressed` record and stops that candidate. Rule names are recorded in
`rules_evaluated`.

- `valid-inputs`: observations, state, and events each validate and the
  state plus events exactly cover the discovered observations (stale
  snapshots refuse the run, mirroring `--detect-events`).
- `stale-fact`: only `current` facts yield scene wording; stale facts are
  recorded, never spoken in the present tense.
- `subsumed-by-development`: a scene twin of a development line for the
  same new evidence is dropped in favor of the development line.
- `no-conflicted-evidence`: contested timestamps and conflicted facts are
  never cited.
- `confidence-floor`: low-confidence sources are suppressed, never
  upgraded.
- `uncertainty-scope`: a claim quoting a token named in a source
  uncertainty is suppressed.
- `category-scope`: `combat`/`other` facts never yield `scene` lines;
  HUD numbers never yield interpretations.
- `no-elimination-from-absence`: missing nameplates, vanished figures,
  and timer/number changes are not events, kills, or eliminations.
- `no-broadcast-significance`: a scene or development claim is spoken
  only when it is worth broadcasting. Confidence is not significance:
  a high-confidence description of grass is still grass. Worthy means
  the claim carries gameplay wording (combat, knockdown, revive, Blue
  Wall, grenade, smoke, vehicle, zone, elimination, or movement
  signals from `gameplay-v1`), a linked entity track moved or
  reappeared across observations, or an event cites the fact
  (environment explaining a development). Standalone scenery, generic
  player sightings, unchanged descriptions, and HUD trivia are
  suppressed with this rule; event echoes always pass it.
- `already-emitted`: a `claim_id` present in a usable prior file with
  unchanged evidence is suppressed (a new evidence timestamp is a new
  `claim_id` by construction and re-emits).
- `no-justified-wording`: anything with no applicable template above is
  suppressed rather than paraphrased.

Every gated claim additionally carries internal `gameplay` context
(`tags`, `entities`, `entity_moved`, `event_linked`) derived from
`gameplay-v1`. It is never persisted on lines and never enters the
claim id; it travels with the claim so the script validator can ground
analytical wording in structured evidence instead of re-guessing from
text.

## Validation

`validate_commentary` checks shape (exact fields, enums, sorted order,
non-empty strings, `seq` per timestamp) and then provenance against the
input bundle when one is supplied: source refs resolve to accepted
observations and state facts; `event_id` resolves to a `candidate` event;
evidence strings occur in both cited observation text and line text;
named tokens in text are a subset of tokens in evidence; line confidence
is not higher than any cited source; `qualification` is present exactly
for `event_echo`; the template is listed above and its precondition
inputs are present. Shape-only validation (no bundle) is available for
file checks; the generation path always validates with the bundle.

## Determinism and replay

Inputs sort by (timestamp, filename); lines sort by (timestamp, seq, id);
claim ids are content hashes; no wall-clock time or randomness enters the
document. Replaying the same observation directory, snapshot, events file,
and prior commentary file reproduces the same output byte-identically.
Emitted history spans both prior lines and prior `already-emitted`
records: a silent file carries no lines, so repeat suppression reads the
records too — otherwise silence would oscillate instead of converging.

## What v1 does not do

- Confirm candidates, resolve uncertainties, merge identities, interpret
  numbers, or infer movement, intent, kills, or outcomes.
- Guarantee semantic faithfulness beyond its mechanical checks: the
  checks bind wording to quoted evidence, but a free-text generator
  could still arrange true quotes misleadingly. The writer mode (one
  text-only model call over gated claims, every line re-validated with
  per-line template fallback) narrows that risk to phrasing around
  mandatory verbatim quotes; it does not eliminate it. No denied-phrase
  list is used: substring blacklists both miss paraphrase and false-hit
  on quoted evidence itself.
- Write anywhere except `output/commentary/`; sources, state, and events
  are read-only inputs.

## Compatibility

Changes to this contract require bumping `schema_version` and reviewing
all consumers (notably future TTS). Adding a template is a minor but
review-gated change (document it here first); tightening, renaming, or
removing is breaking. Consumers must tolerate unknown `type` values
gracefully (treat as opaque) rather than crashing.
