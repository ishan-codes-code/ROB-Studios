# Contract: commentary audio manifest v1 (`tts-v1`)

Versioned schema for the script-to-audio pipeline (roadmap milestone
M6: `script-v1` segments → one WAV per segment → audio manifest).
Produced by `run_generate_tts` into `output/audio/tts.json` from the
validated `output/script/script.json` of the same run. Consumed by
the artifact browser and workspace audio panels for playback; the
contract itself carries no playback state (Ready/Failed/etc. are
derived by joining entries against listed files).

The script is only read, never modified: every entry quotes the exact
segment text that was sent to the TTS provider, so the manifest alone
lets a player reconstruct the commentary sequence.

## Layout

Under the run's `--output-dir` (Electron: the project's `output/`):

- `audio/tts.json` — this manifest, written atomically last.
- `audio/segments/<sanitized-segment-id>.wav` — one complete WAV per
  successful segment, each written atomically (temp file + verified
  rename). Filenames derive from segment ids only: unsafe characters
  become underscores, and a sanitization collision fails the run
  before any synthesis. Timestamps are never used as filenames.

Rerun policy (explicit): every run synthesizes all eligible segments
fresh and replaces prior outputs via atomic rename. Reruns re-spend
TTS calls; there is no resume and no skip-if-present. A crash never
leaves a partial WAV or manifest behind.

## Schema

Top-level value must be a JSON object with exactly these fields:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `schema_version` | string | yes, must equal `"tts-v1"` | Contract version |
| `status` | `success`, `partial`, `silence`, or `error` | yes | `success`: every entry succeeded or was skipped; `partial`: at least one success and at least one error; `silence`: the script was silent (no entries, no synthesis calls); `error`: at least one error and no success |
| `generation_id` | 64 lowercase hex chars | yes | `generation_identity` over the exact script bytes plus model, voice, and voice direction — binds this audio to its inputs |
| `model` | string | yes | Pinned TTS model (`gemini-3.8-flash-tts` or `gemini-3.8-flash-lite-tts`) |
| `voice` | non-empty string | yes | Voice id used for every segment |
| `voice_direction` | non-empty string | yes | Exact style direction sent with every segment |
| `generated_from` | object | yes | Replay provenance (see below) |
| `entries` | array of entry objects | yes (may be empty) | One entry per script segment, in script order; empty only for `silence` |

`generated_from` has exactly one field: `script` (non-empty string,
the script filename, never an absolute path).

Each entry object has exactly these fields:

| Field | Type | Meaning |
|---|---|---|
| `segment_id` | non-empty string | Original script segment id, unique per document |
| `timestamp_seconds` | number | Original segment timestamp; entries stay in non-decreasing order |
| `text` | non-empty string | Exact text sent to the provider — never paraphrased, never a replacement |
| `source_claim_ids` | non-empty array of non-empty strings | Original gated claim ids |
| `audio_file` | string or null | Manifest-relative WAV path (`segments/<name>.wav`); non-null only for `success` |
| `status` | `success`, `skipped`, or `error` | `success`: WAV synthesized and written; `skipped`: deliberately not synthesized (no API call, no file) — reserved, never emitted by this milestone; `error`: synthesis or the file write failed |
| `error` | string or null | Non-empty redacted diagnostic for `error` entries, null otherwise — never spoken text |

## Validation

`validate_tts_manifest` enforces shape (exact fields, value types,
unique segment ids, chronological entries, `segments/*.wav` audio
paths without traversal) plus status consistency:

- `silence` if and only if `entries` is empty.
- `success` only when no entry failed; `partial` only with at least
  one success and one error; `error` only with errors and no success.

The runner validates the built manifest before writing it; an invalid
manifest is an internal error and is never written.

The input script is validated with the existing `validate_script`
before any synthesis: a malformed script, an `error`-status script,
or a filename collision fails the run with no API calls and no
manifest. Empty or invalid text is therefore never synthesized.

## Failure semantics

- Synthesis and file-write failures are recorded per entry; the run
  continues with the next segment. Successful WAVs are preserved.
- A run whose manifest status is `partial` or `error` exits non-zero;
  the manifest and successful WAVs remain on disk for inspection.
- Error text is truncated, whitespace-collapsed, and redacted: the
  API key value never appears in the manifest, stdout, or stderr.

## Credentials

The TTS key arrives only through the `AI_COMMENTATOR_PROVIDER_API_KEY`
environment variable (same handoff as the `tts_say.py` proof of
concept) — never argv, stdin, files, logs, or renderer state. The
worker fails fast before any paid call when it is absent. Electron
does not yet inject a vault TTS credential into the worker
environment: project-level TTS settings are a later milestone, so
Electron-spawned runs cannot reach this stage until then.

## Compatibility

- `tts-v1` is a new, distinct artifact. It does not change the
  meaning of `script-v1`, commentary, events, match state, or
  observations.
- Consumers must accept `silence` (empty entries) and `skipped`
  entries as valid outcomes and must never speak the `error` field.
- Field or status additions require a new schema version; readers
  must reject unknown top-level, entry, or `generated_from` fields
  rather than guessing.
- Discovery (Electron): `listArtifacts` reports the manifest as the
  `tts` summary (readable via the `tts` artifact kind) and lists
  `output/audio/segments/*.{wav,mp3,ogg,m4a}` under the
  `audio/segments` scope, served over
  `project://<id>/audio/segments/<name>`. The legacy `audio/` and
  `audio/commentary` roots stay listed for older projects.
