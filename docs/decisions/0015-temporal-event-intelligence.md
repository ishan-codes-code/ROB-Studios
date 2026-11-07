# 0015 — Temporal gameplay event intelligence as an additive extension

- **Status** — accepted.

## Context

Milestone 5 detects single-observation and pairwise events
(`kill_feed_entry`, `elim_count_increased`). Session-2 gameplay
intelligence needs multi-observation patterns — a team counter rising
across three or more readings, several fresh feed entries landing
together — without weakening evidence gating, without new pipeline
stages, and without breaking the `events-v1`, `commentary-v1`,
`script-v1`, match-state, worker-protocol, or TTS contracts.

## Decision

- Observations gain an additive `observation-v2` schema: the v1 core
  plus optional verbatim-only `subjects`/`action`/`spatial` keys.
  Every structured token must already quote its entry's description
  or evidence; roles, outcomes, and intent stay forbidden at the
  observation layer. Validators accept v1 and v2; v1 shape and
  strictness are unchanged.
- Detection gains two rules behind the existing boundary, reusing
  `emit()`, contested/dedup handling, and provenance: `elim_streak`
  (same-team strictly-increasing chain of 3+ readings within a
  window) and `feed_cluster` (2+ feed-satisfying observations within
  a window with disjoint name-token sets). No `events-v1` schema
  bump: new rule names become new `type` values, documented first,
  review-gated as the contract requires.
- Significance (`feed_cluster` > `elim_streak` >
  `elim_count_increased` > `kill_feed_entry`) is computed at
  gating/priority time, never stored.
- Commentary gains one echo-like `event_sequence` template; the line
  type stays `event_echo`, so qualifier, uncertainty, confidence,
  token-subset, and evidence-containment rules apply unchanged.
  Script needs no shape or stem change: sequence claims are
  `event_echo` claims to the script validator.
- State, streaming windows, worker protocol, TTS, and Electron are
  untouched: no new carried state (prefix rebuild already carries
  event state), stable claim ids collapse re-gated sequences across
  windows, and v2 content hashes force snapshot rebuilds through
  the standard stale-snapshot refusal.

## Alternatives considered

- New `events-v2` with a stored significance field: rejected — a
  stored rank would need corroboration semantics that do not exist;
  a computed rank is deterministic and needs no migration.
- Vision-side entity resolution or role assignment: rejected —
  model-assigned killer/victim roles cannot be validated
  mechanically; exact-match tokens and explicit qualifiers keep
  every claim checkable.
- A separate temporal pipeline: rejected — the worker must reuse
  engine functions, and prefix-rebuild windows already re-run the
  pure detectors; new rules flow through both sequential and
  streaming paths with no new machinery.

## Consequences

- Vision prompts request `observation-v2`; mixed v1/v2 directories
  validate, and rewriting a file across versions invalidates its
  snapshot (rebuild required, never silent).
- Window thresholds (`EVENT_STREAK_WINDOW_S`,
  `EVENT_CLUSTER_WINDOW_S`) are initial placeholders needing tuning
  against real match footage; live model emission of the optional
  keys is unverified until the first paid run (no paid calls were
  made for this milestone).
- Pairwise `elim_count_increased` events still fire alongside
  streaks, and single `kill_feed_entry` events alongside clusters:
  sequences add wording, they do not replace the atomic evidence.
