# ADR 0008: Explicit Meta/Baseten provider adapters

- Status: Accepted
- Date: 2026-11-02

## Context

The vision engine spoke only Baseten's OpenAI-compatible Chat
Completions dialect (`vision/client.py` hardcoded `BASETEN_MODEL`,
chat payloads, and Baseten-branded errors/diagnostics). The roadmap
requires Meta Model API support with the same batch + adaptive
behavior, the same `observation-v1` validation, and no paid retries —
without letting HTTP protocol details leak into the pipeline.

## Decision

Add `python/ai_commentator/vision/providers/` with a minimal
`VisionProviderAdapter` interface (`request_observation_text`,
`request_adaptive_text`, `request_text`, `verify_connection`,
`verify_image`, `close`), a `BasetenAdapter` (pinned model
`meta-models/muse-spark-open-1026`, Chat Completions, unchanged wire
behavior), a `MetaAdapter` (`POST https://api.meta.ai/v1/responses`,
Bearer auth, curated models `muse-spark-1.3` / `muse-wonder-1.0`), and
a `registry` with the curated catalogue and an explicit-vs-legacy
environment resolver. `client.py` keeps every existing function and
signature; raw SDK clients take the legacy path byte-for-byte, adapters
take the new path. Observation parsing/validation, sampling, and
manifest logic are untouched.

## Consequences

Batch, adaptive, writer, and script stages work with both providers
through one normalized result shape. Official Meta docs consulted:
overview, protocols/responses, image-understanding, models (fetched
2026-11-02). Residual uncertainty: the exact `input_image` member shape
of the Responses image content is isolated behind `MetaAdapter` — if
live verification rejects it, only that file changes. No live paid
verification was performed; mocked tests cover both adapters.

## Alternatives considered

A single generic client with interchangeable base URLs (rejected: it
hides provider differences and invites arbitrary endpoints, which this
milestone explicitly forbids).
