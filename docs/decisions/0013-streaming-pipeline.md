# 0013 — Streaming pipeline as opt-in threaded stages

- **Status** — accepted.

## Context

The worker ran six strictly sequential stages: script waited for all
of vision, TTS waited for all of script. The milestone needs Vision →
Script → TTS to overlap (script starts on early evidence, TTS on early
segments), with app-side priority/interruption, without distributed
infrastructure, and without breaking the proven sequential path or the
`script-v1`/`tts-v1` layouts.

## Decision

- Streaming is opt-in (`--streaming` + workspace toggle, default off).
  The sequential path is untouched and stays the default.
- One worker process, three stages, two bounded in-process queues
  (`ai_commentator/streaming/`): the vision loop produces validated
  observations (FIFO, backpressure when script lags); one script thread
  words incremental windows (one bounded LLM call each, same gating
  and validators as sequential); one TTS thread synthesizes utterances
  sequentially (bounded concurrency of one per provider caution).
  No brokers, no thread pools, no asyncio.
- Priority is data, not just prompting: utterances carry urgency
  (event echoes > developments > scene wording); urgent utterances
  supersede routine ones still queued for synthesis (recorded in the
  ledger and final `omitted`, never silently dropped). In-flight
  synthesis is never recalled.
- Mid-run identity is the stable `utterance_id`; final artifacts reuse
  the exact sequential layout (`segment-NNN` ids, segment-named WAVs)
  by sorting at finalize and atomically renaming utterance WAVs. New
  NDJSON progress messages (`script_segment`, `tts_segment`) carry
  incremental state; no intermediate invalid artifact is ever written.
- Windows reuse the pure state/event/gating functions over the
  observation prefix; the deterministic tail (state/events/commentary)
  runs once at the end, best-effort on stopped/failed runs so partial
  runs leave consistent artifacts.
- Failures isolate per window / per utterance; synthesized bytes pass
  WAV container validation before an utterance marks ready.

## Alternatives considered

- Chunked sequential (run stages per batch, still ordered): rejected —
  simpler but not concurrent; acceptance requires overlap.
- Asyncio or multiprocessing: rejected — the paid calls are
  thin-client blocking I/O and the codebase has no async runtime;
  threads with bounded queues are the smallest sufficient tool.
- Emitting intermediate `script.json` versions: rejected — provenance
  checks (chronological order, claim coverage) only hold over the full
  set; NDJSON plus a final atomic write avoids invalid reads.

## Consequences

- Streaming costs more paid calls per run than sequential (one script
  call per window instead of one per run); UI copy stays honest about
  per-window/per-utterance spend.
- Reruns over the same output dir seed suppression from the prior
  script, like sequential; cross-run TTS resume is still out of scope.
- A future A/V sync milestone can build on utterance timestamps,
  segment ids, and claim references, which are preserved end to end.
