# Contract: frame observation v2 (`observation-v2`)

Versioned schema for one validated vision-model observation of a single
gameplay frame, extending `observation-v1` with optional verbatim-only
structured evidence (session-2 gameplay intelligence). Produced by the
vision paths (which now request `observation-v2`), consumed alongside
v1 by state tracking, event detection, commentary, and script
generation. Strict validation: anything not conforming is rejected,
never guessed.

## Schema

Top-level value must be a JSON object with exactly these fields
(identical to v1 apart from the version string):

| Field | Type | Required | Meaning |
|---|---|---|---|
| `schema_version` | string | yes, must equal `"observation-v2"` | Contract version |
| `timestamp` | number (int or float) | yes | Frame position in seconds within the source video, as stated in the prompt |
| `observations` | array of observation objects | yes (may be empty) | Directly visible evidence, one entry per distinct thing seen |
| `uncertainties` | array of non-empty strings | yes (may be empty) | What is unreadable, ambiguous, or uncertain — never invented detail |

Each observation object has the four v1 core fields plus three
optional structured-evidence keys, and nothing else:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `category` | string, one of `environment`, `character`, `hud`, `combat`, `other` | yes | What kind of thing is observed |
| `description` | non-empty string | yes | What is visible |
| `confidence` | string, one of `high`, `medium`, `low` | yes | How certain the observation is |
| `evidence` | non-empty string | yes | Visible detail grounding the claim (e.g. quoted on-screen text, position, color) |
| `subjects` | array of subject objects | no | On-screen tokens worth structuring (absent = none) |
| `action` | non-empty string or null | no | Verbatim quoted verb/phrase, or null when seen but unreadable |
| `spatial` | non-empty string or null | no | Verbatim positional phrase, or null when seen but unreadable |

Each subject object has exactly these fields:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `label` | non-empty string | yes | The on-screen token, quoted verbatim |
| `kind` | string, one of `player`, `team`, `other` | yes | What kind of token it is |

## Validation rules

Reject with a clear error (never silently accept or fabricate):

- Everything v1 rejects (malformed JSON, empty output, non-object
  top level, missing/wrong-typed fields, bad category/confidence,
  unknown extra fields, unquoted prose), plus:
- `subjects` present but not a list; a subject that is not an object,
  has extra fields, has an empty label, or has a `kind` outside
  `player`/`team`/`other`.
- `action`/`spatial` present but neither null nor a non-empty string.
- A structured token that is not a verbatim substring of its own
  entry's `description` or `evidence` (label, action, and spatial
  alike). The observation layer structures what is quoted; it never
  resolves roles, outcomes, or intent.

The verbatim-substring rule mirrors the `TAG.NAME` token-subset rule
in `commentary-v1`: structured tokens must already be present in the
quoted text, so no new claim enters through the structured keys.

## Absent vs null vs unknown

- An absent key means nothing was worth structuring.
- Explicit `null` (`action`/`spatial` only) means seen but
  unreadable; the reason belongs in `uncertainties` as well.
- Anything unreadable or ambiguous still goes into `uncertainties`
  as plain text; a `low`-confidence observation is still a claim
  about something seen, not a guess.

## Example

```json
{
  "schema_version": "observation-v2",
  "timestamp": 3,
  "observations": [
    {
      "category": "hud",
      "description": "Team AG panel header Elim 4, bottom-left.",
      "confidence": "high",
      "evidence": "Header text Elim 4 in the team AG panel.",
      "subjects": [{"label": "AG", "kind": "team"}],
      "action": "Elim 4",
      "spatial": "bottom-left"
    }
  ],
  "uncertainties": []
}
```

## Compatibility

- `validate_observation` accepts `observation-v1` and
  `observation-v2`; the v1 entry shape is unchanged and v1 documents
  with v2 keys are rejected (strict per-version allowlists).
- Directories may mix v1 and v2 files; every consumer reads both.
- `observation_sha256` hashes the canonical full document, so the
  same content as v1 vs v2 hashes differently: rewriting a file
  across versions invalidates the stored snapshot and forces
  `--rebuild-state` before detection, commentary, or script runs
  (the standard stale-snapshot refusal, never a silent mix).
- Match state is unchanged (`match-state-v1`): facts still file
  under the exact `(category, description)` pair. The structured
  keys are validated at ingest, echoed into vision context, and read
  by the `gameplay-v1` interpretation layer (entity labels seed
  tracks; quoted action/spatial phrases feed engagement, movement,
  and posture signals); nothing is re-stated in state.
- Vision prompts request `observation-v2` with the optional keys;
  the previous-observation context carries them in bounded form.
  Consumers must tolerate absent keys (v1 files and v1-shaped v2
  entries) rather than assuming structured evidence exists.
