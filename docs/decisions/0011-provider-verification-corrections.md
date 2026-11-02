# ADR 0011: Provider verification corrections (Meta payload, Spark budgets, Baseten model rename)

- Status: Accepted
- Date: 2026-11-02

## Context

Image verification failed while connection checks succeeded. Inspection
against the official docs (fetched 2026-11-02) found three concrete
defects, all in the small verification probes: the Meta Responses
payload omitted the required typed `message` discriminator, both probes
used a 32-token output budget that Muse Spark reasoning consumes before
any answer text, and the pinned Baseten identifier no longer matches
the documented model string. Failures also lost their sanitized
`detail` between the setup probe and the renderer.

## Decision

- Meta: every Responses `input` item carries
  `{"type": "message", "role": "user", "content": [...]}`; `input_image`
  keeps the documented plain-string `image_url`. Probes request
  `reasoning: {"effort": "minimal"}` with `max_output_tokens` 512
  (verify-image) / 64 (verify-connection). An `incomplete` response
  with `max_output_tokens` exhaustion raises `output_exhausted`, never
  a false success. Frame-pipeline payloads keep their existing shape
  plus the discriminator; no behavior change.
- Baseten: pinned model is now `meta-models/muse-spark-open` (per the
  meta-oss-cookbook Baseten guide). `verify-image` sends `max_tokens`
  512 with top-level `reasoning_effort: "low"` (a documented gateway
  parameter) and maps `finish_reason: "length"` to `output_exhausted`.
  The retired `-1026` identifier is a compatibility alias only:
  Python (`registry`, adapter, `BASETEN_MODEL` env) and Electron
  (`provider-catalog`, vault load, legacy migration) normalize it to
  the current id, and any prior verification is downgraded to
  unverified so the new identifier is explicitly re-tested.
- Diagnostics: the sanitized `detail` field now survives
  `provider_setup.py` → `spawnSetup` → IPC → renderer (appended to the
  failure message) and main-process dev logs. No secrets cross that
  path: adapters redact keys before raising.

## Consequences

Verification probes give Muse Spark room to reason and report budget
exhaustion diagnosably. Existing saved Baseten configurations resolve
instead of breaking, but must re-verify once. No live paid
verification was performed; mocked tests cover payloads, budgets,
exhaustion, the rename, and detail propagation.

## Alternatives considered

- Larger blind budgets without a reasoning control (rejected: hides
  the exhaustion mechanism and costs more per probe).
- Keeping the retired identifier working silently (rejected: a renamed
  route must prove itself with a fresh verification).
