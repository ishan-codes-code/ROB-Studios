# 0017 — Broadcast pipeline: overlay perception plus deterministic timeline

- **Status** — accepted.

## Context

The v1/v2 perception path asks the model for prose scene descriptions
(~2,600 tokens per observation) and then recovers gameplay meaning
with a keyword tagger (`state/gameplay.py` word lists). Verified on
the real Clash Squad fixture, that recovery guesses: negated wording
("No muzzle flash, ...") was tagged `combat` and produced HIGH
false-engagement beats, substring accidents (`carpet` → vehicle) fired
gameplay tags, and absence had to be worded as presence because the
schema has no null for "not shown". ADR 0016 hardened the tagger with
a negation guard and word boundaries, but the underlying shape —
prose first, keywords second — keeps every downstream stage one
rewording away from a false signal. The broadcast overlay already
carries the match facts the commentary needs (round clock, scores,
alive pips, focus player, visible event cues); reading it directly
removes the prose surface the tagger guesses over.

This does not re-litigate ADR 0016's rejection of model-asserted
entity identities: v3 asserts no identities. Names are quoted HUD
strings, teams are stable scoreboard letters, and anything unreadable
is explicit null. Identity resolution stays out of model output.

## Decision

- Add `observation-v3` (new contract, new validator): one compact
  HUD-reading document per frame (~150–250 tokens of model output),
  with strict boundary validation and unknown-as-null semantics. v1/v2
  and the legacy pipeline are untouched; v3 documents are rejected by
  the legacy validator and vice versa.
- Adopt the broadcast pipeline shape for recorded runs:
  perception (v3 overlay reading) → timeline (deterministic merge of
  per-frame readings into a match clock) → analyst (situation reads
  over the timeline) → caster (beat selection and wording) →
  grounded validator (deterministic evidence checks before anything
  speaks) → TTS fit (timing and delivery shaping for synthesis).
- The keyword tagger is not used on this path. v3 fields are already
  structured readings (timers, counts, enums, quoted names), so
  gameplay meaning comes from comparing readings across frames, not
  from matching words inside sentences. No substring lists, no
  negation heuristics, no posture inference operate on v3 text.
- Prompt wording for the v3 call lives in the packs as a new additive
  `broadcast_vision_prompt` field (game-pack-v1 allows additive
  fields without a version bump); the cue enum default lives in
  config and is pack-configurable at validation time.

## Alternatives considered

- Extending v2 with more structured keys was rejected: the prose
  core stays the failure surface, and each new key replays the
  population-verification problem (live v2 fields were never
  confirmed populated).
- Running the keyword tagger over v3 `notes`/`evidence` strings was
  rejected: those strings exist for human audit and validator
  grounding, and tagging them would reintroduce the exact failure
  mode (negations, accidents) v3 removes.
- Rewiring the legacy pipeline (state/events/commentary/script) onto
  v3 now was rejected: the legacy path is the shipped behavior with
  golden fixtures; the broadcast pipeline is built alongside it and
  earns its cutover with replay parity on real runs.

## Consequences

- This change ships schema + prompt wording + validator only. The
  timeline, analyst, caster, validator, and TTS-fit stages are
  planned follow-ups; no caller requests v3 yet and no legacy
  consumer reads it.
- Callers must size `max_output_tokens` for a few hundred tokens of
  JSON; prose-observation output budgets must not be reused.
- The CoD/BGMI broadcast layouts are best-effort and marked
  unverified in the pack source; they need confirmation against real
  footage before any paid v3 call uses them.
- v3 grows the pack surface by one field per game; the game-pack-v1
  additive-field rule covers it with no version bump.
