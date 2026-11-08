# 0016 — Gameplay intelligence: interpretation layer, gameplay events, significance gating

- **Status** — accepted.

## Context

ROB narrated visible objects ("a player standing near the billboard")
instead of commentating the match. Root causes sat below the wording:
the `observation-v2` structured keys were validated but never read;
match state filed flat `(category, description)` facts with no entity
or temporal reasoning; event detection covered only HUD text (kill
feed, elim counters) while `combat` observations could become neither
scene lines nor events; the commentary gate spoke every confident
fact with no significance test; and the script validator's keyword
groups made analytical paraphrase impossible while letting knock
evidence unlock elimination wording.

## Decision

- Add an in-memory `gameplay-v1` interpretation layer
  (`state/gameplay.py`, new contract): deterministic per-entry
  observed/inferred signals — the first consumer of the v2
  `subjects`/`action`/`spatial` keys — plus cautious entity tracks
  (exact-label grouping, unlinked unknowns, occlusion/reappearance/
  movement statuses). Observation, interpretation, and confirmed
  event stay separate: inferred signals never trigger rules alone.
  Never persisted: rebuilt wherever needed, no migration surface.
- Add five `events-v1` rules behind the existing boundary, reusing
  `emit()`, contested/dedup handling, and provenance:
  `combat_engagement` (combat at 2+ distinct timestamps in a window),
  `knockdown_observed`, `revive_observed`, `blue_wall_use`, and
  `zone_pressure` (explicit wording, first-sighting semantics).
  Candidate-only; no schema bump (new `type` values, documented
  first). Kill-feed and counter rules byte-unchanged.
- Gate commentary on broadcast significance
  (`no-broadcast-significance`): scene/development claims need
  gameplay wording, an entity-track change, or an event cite.
  Confidence is not significance. Echoes always pass (their rule
  evidence is the link). Claims carry internal `gameplay` context for
  the script validator; lines and claim ids unchanged.
- Give wording stages a bounded match narrative
  (`commentary/narrative.py`): situation, active engagements, recent
  developments, uncertainties, already-said — prompt context only,
  never citable evidence.
- Ground the script validator in structured tags: knock/elim stems
  policed separately (tags never upgrade a knock), action verbs
  per-stem with narrow engagement/movement paraphrase allowances,
  and engagement/movement/zone nouns requiring evidence wording or a
  matching tag. Strictness rises; no previously prohibited claim is
  broadly allowed.
- No new pipeline, coordinator, paid call, or protocol change:
  streaming windows, worker NDJSON, provider boundary, model ID, TTS,
  OBS plans, and Electron are untouched. New windows for engagement
  (15s) and entity reappearance (6s) are tuning placeholders.

## Alternatives considered

- An `observation-v3` schema with model-asserted entity identities was
  rejected: live v2 field population is already unverified, and
  identity resolution belongs in deterministic code (exact-label
  tracks here), not in model output.
- A second paid semantic judge for validation was rejected: it adds a
  paid call per segment with its own failure modes, while structured
  gameplay tags constrain the generator deterministically.
- Persisting gameplay state alongside `match_state.json` was rejected:
  derivation is cheap and deterministic, and a second snapshot would
  add a stale-snapshot surface for no replay benefit.

## Consequences

- Quiet windows go silent instead of narrating scenery; combat,
  knocks, revives, cover, and zone developments surface as qualified
  candidate echoes and gameplay-grounded script lines.
- Existing commentary/script/streaming fixtures that asserted
  trivial scene lines were updated to gameplay-bearing wordings;
  the old expectations are preserved as suppression tests.
- Live v2 field population and window tuning still need real
  footage; thresholds ship as documented placeholders.
