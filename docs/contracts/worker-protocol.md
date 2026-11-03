# Worker protocol (Electron ↔ Python)

How the Electron main process drives the Python engine. The worker is
`python/worker.py`, launched with `child_process.spawn()` (never `exec()`).
It reuses the pipeline runners in `python/main.py`; the protocol below is
the only Electron/Python interface. Changing a message shape is a contract
change: update this document, the parser (`electron/src/worker-protocol.mjs`),
and the tests together.

## Transport

- Command: `<repo>/.venv/bin/python python/worker.py VIDEO [--output-dir DIR]
  --adaptive [--adaptive-max-frames N] [--with-script] [--streaming]
  [--generate-tts [--tts-model MODEL] [--tts-voice VOICE]
  [--tts-voice-direction TEXT]]`
  (Windows interpreter: `.venv/Scripts/python.exe`).
- The video path is a positional argument. `--adaptive` is required:
  adaptive sampling is the only supported analysis mode; `--generate-tts`
  synthesizes commentary audio from the generated script (requires
  `--with-script`; see `docs/contracts/tts-v1.md`). The `--tts-*` options
  carry the effective Studio voice configuration resolved main-side from
  stored settings (see `docs/contracts/tts-studio-v1.md`); unset options
  fall back to engine defaults, and anything else must pass
  `validate_tts_config` or the worker fails fast with a stage-`tts`
  error before any paid call.
- **stdout carries only protocol messages**: one JSON object per line,
  newline-delimited (NDJSON). Engine diagnostics and legacy `print` output
  are redirected to **stderr** so stdout stays parseable even though the
  engine itself prints freely.
- The child is spawned with `stdio: ['pipe', 'pipe', 'pipe']`, owned as
  follows: **stdout** carries only protocol messages (Electron reads);
  **stderr** carries diagnostics (Electron forwards); **stdin** carries
  only control messages (Electron writes, the worker reads). The process
  manager owns stdin writes; the renderer never touches the child.
- The main process supplies the child's provider endpoint/model and prompt
  preferences through `BASETEN_BASE_URL`, `BASETEN_MODEL`, and
  `AI_COMMENTATOR_SETTINGS_JSON`. For a saved credential, it decrypts the
  OS-backed credential immediately before spawning and passes it as
  `BASETEN_API_KEY` only in the child environment. It is never an argument,
  worker message, or renderer value. The legacy host environment key remains
  supported for existing development setups.
- **Control messages** are one newline-delimited JSON object per line:
  `{"type":"stop","version":1}` is version 1's only command, built by
  `buildStopControlLine()` and parsed by
  `python/ai_commentator/vision/control.py`. The worker ignores blank
  lines, rejects malformed JSON, unknown commands, and unsupported
  versions with a short stderr note (never echoing the payload), and
  ends its reader quietly on EOF. Nothing but `stop` version 1 may
  travel this channel: no paths, no shell, no code, no secrets.
- The worker never prints secrets. `BASETEN_API_KEY` is read from the
  environment and its value never appears in any message. The TTS
  stage reads its own key from `AI_COMMENTATOR_PROVIDER_API_KEY`
  (see `docs/contracts/tts-v1.md`) and fails fast when it is absent.

## Messages

```json
{"type": "started", "message": "Processing video clip.mp4"}
{"type": "progress", "stage": "adaptive_vision", "completed": 0, "total": 4, "progress": 0}
{"type": "stage_completed", "stage": "adaptive_vision", "completed": 1, "total": 4, "detail": {"observations": 3, "requests": 2, "termination": "complete"}}
{"type": "result", "data": {"video": "/v/clip.mp4", "output_dir": "/o", "stages": ["adaptive_vision", "state_rebuild", "event_detection", "commentary"], "skipped": [], "mode": "adaptive", "frames": 0, "observations": 3, "events": 0, "commentary_lines": 1, "script": "skipped", "tts": "skipped", "artifacts": {"state": "/o/observations/match_state.json", "events": "/o/events/events.json", "commentary": "/o/commentary/commentary.json", "script": null, "tts": null}}}
{"type": "adaptive_sample", "data": {"timestamp": 12.5, "speed": "HIGH", "reason": "Fast motion.", "next_timestamp": 13.0, "observations": 3, "requests": 3}}
{"type": "script_segment", "data": {"utterance_id": "u-0001", "timestamp_seconds": 12.5, "text": "The zone starts closing in.", "source_claim_ids": ["clm-9f3a2b1c4d5e"], "priority": 1, "status": "worded"}}
{"type": "tts_segment", "data": {"utterance_id": "u-0001", "timestamp_seconds": 12.5, "status": "success", "error": null}}
{"type": "stopped", "data": {"status": "stopped", "termination": "stop-requested", "mode": "adaptive", "observations": 2, "requests": 2}}
{"type": "error", "stage": "state_rebuild", "message": "State rebuild failed; see worker stderr."}
```

Message types:

- `started` — first message of a run; `message` names the video file.
- `progress` — emitted before each stage runs. `completed`/`total` are
  **stage counts** (stages genuinely finished / stages planned).
  `completed` never exceeds `total`. `progress` is
  `round(100 * completed / total)`. These are stage-level, never
  fabricated frame percentages.
- `stage_completed` — `stage` plus a small `detail` object with real,
  observed values only (observation/event/line counts from files the
  stage actually wrote).
- `adaptive_sample` — progress message, one per validated, persisted
  adaptive iteration (never terminal). `data` carries the scheduled
  source-video `timestamp` (finite, ≥ 0), the validated `speed` enum
  (`HIGH`/`NORMAL`/`LOW`), the bounded untrusted `reason` (≤ 280 chars),
  the already-computed `next_timestamp` (`null` when the run ends at the
  video duration), and the cumulative `observations`/`requests` counters
  (non-negative integers). Anything outside this shape is rejected as a
  protocol error. Only the sampling history is new: observations keep
  flowing through the `observation-v1` files, never through this message.
- `script_segment` — progress message, one per worded streaming
  utterance (streaming runs only; never terminal). `data` carries the
  stable `utterance_id` (`u-NNNN` in wording order), the evidence
  `timestamp_seconds`, the validated spoken `text` (8–600 chars),
  `source_claim_ids`, the app-side `priority` (0 urgent … 2 routine),
  and `status` (`worded`, or a later `superseded` update when a more
  important utterance pre-empted this one while it was still queued).
  Anything outside this shape is rejected as a protocol error.
- `tts_segment` — progress message, one per synthesized streaming
  utterance (streaming runs with `--generate-tts` only; never
  terminal). `data` carries the `utterance_id`, `timestamp_seconds`,
  `status` (`success`, `error`, or `skipped`), and a redacted `error`
  string (or null). Audio paths are not reported here: the finished
  `tts-v1` manifest is authoritative after segment-id renaming.
- `stopped` — terminal message of a gracefully stopped adaptive run
  (`--adaptive` only). `data` mirrors the `result` shape plus `status`
  (`"stopped"`), `termination` (`"stop-requested"`), request counts, and a
  `manifest` artifact path. Partial observations and the manifest survive.
  Streaming runs additionally finalize partial `script.json`/`tts.json`
  from the ledger before emitting it. No `result` follows it; the
  process exits `0`.
- `result` — final message on success. `data` reports the video path,
  output directory, completed stage names in order, skipped stage names
  in order (always empty; the adaptive plan has no skip branches), run
  `mode` (`adaptive`), observed counts, the script status (`success`,
  `silence`, or `skipped` when the `--with-script` stage did not run),
  the TTS status (`success`, `partial`, `silence`, `error`, or `skipped`
  when the `--generate-tts` stage did not run), and artifact paths
  (each `null` when the file was not produced). `script` is `null`
  unless `--with-script` ran; `tts` (the `tts-v1` manifest path) is
  `null` unless `--generate-tts` ran.
- `error` — terminal failure. `stage` names the failing phase
  (`validation`, a pipeline stage name, `spawn`, `protocol`, or `worker`);
  `message` is human-readable and never contains secrets. At most one
  `error` is emitted per run, and no `result` follows it.

Stages, in order: `adaptive_vision` (paid), `state_rebuild`
(offline), `event_detection` (offline), `commentary`
(offline, deterministic wording), `script` (paid, only with
`--with-script` — or always in streaming runs), `tts` (paid, only with
`--generate-tts`, which requires `--with-script` or `--streaming`).
The plan is fixed (`plan_stages`): adaptive sampling
is the only supported analysis mode, so `frame_extraction` and batch
`vision_analysis` never run and emit nothing. Corrupt observations
still fail `state_rebuild`; nothing invalid is ever silently accepted.
A completed adaptive stage reports `observations`/`requests`/
`termination` detail; a stopped stage emits `stopped` and halts before
downstream work; a failed stage emits `error`.
See `docs/contracts/adaptive-sampling-v1.md`.

Streaming runs (`--streaming`) execute differently within the same
stage vocabulary: vision produces validated observations into a
bounded queue while script and TTS consumers make progress
concurrently (emitting `script_segment`/`tts_segment`), and the
deterministic `state_rebuild`/`event_detection`/`commentary` tail runs
once over the final observation set afterwards. The run `mode` is
`streaming`. Queues are bounded (vision blocks when script falls
behind); a high-priority utterance supersedes lower-priority
utterances still queued for synthesis (recorded, never silently
dropped); per-window and per-utterance failures stay isolated. On stop
or vision failure the ledger still finalizes partial
`script.json`/`tts.json` and the tail runs best-effort, so partial
runs leave consistent artifacts. The finished `script-v1`/`tts-v1`
layout is identical to sequential runs.

Electron also synthesizes two renderer-only messages that never appear
on the worker's stdout: `{type: "worker-log", text}` for stderr output
and `{type: "worker-exit", code, signal, cancelled}` when the child ends.

## Cooperative stop vs forceful cancellation

- Cooperative stop (`requestStop()` → stdin `stop` line → the worker's
  existing adaptive `StopToken`): the in-flight vision request completes,
  validates, and persists; the run halts before the next capture and
  emits terminal `stopped` with exit `0`. The manager reports whether
  the line was *sent* (`{requested, reason}`); completion is observed
  through `stopped` and the child's actual exit, never claimed early.
  Reasons: `no-active-job`, `stdin-unavailable`, `already-requested`
  (idempotent repeat), `stop-requested`, `write-failed` (retryable).
  Cooperative stop never marks the record cancelled and never starts
  the SIGTERM/SIGKILL escalation.
- Forceful cancellation (`cancel()`): SIGTERM, then SIGKILL after the
  grace period; the child ends with `cancelled: true` and the run
  settles as `cancelled`. This remains the shutdown and fallback path,
  and still works after a cooperative request.
- Terminal settlement: `done` (exit `0` after `result`), `stopped`
  (exit `0` after `stopped`; partial observations and the run manifest
  survive), `error` (a stage failed), `cancelled` (forceful cancel),
  `interrupted` (app quit mid-run). A stop is never reported as
  `cancelled`, and `stopped` never counts as a successful completion.
- Platform notes: stdin delivery works identically on Windows and
  POSIX (it is the Windows-safe path — no signals involved). The
  worker's SIGTERM-to-token mapping from M4.1 stays as a POSIX fallback
  inside adaptive runs only; every other mode keeps existing behavior.

## Validation and exit codes

- Exit `0`: the planned stages all ran; stdout ends with `result`
  or with `stopped` (a gracefully stopped adaptive run, still
  exit `0`).
- Exit `1`: a pipeline stage failed; stdout ends with `error`
  (missing API key for a requested paid stage, rejected observations,
  stale snapshot, write failure, unexpected exception).
- Exit `2`: argument or input validation failed. Missing/unsupported
  video files and a missing `--adaptive` flag are reported as
  `{"type": "error", "stage": "validation", "message": ...}` on stdout
  before exiting; `argparse` usage errors (including the removed
  `--limit`/`--jobs`/`--force`/`--skip-vision` flags) go to stderr
  (standard behavior, no protocol message).
- Missing API keys are detected before any paid call
  (fail fast); no output tree is created in that case.
- SIGTERM is caught and becomes a graceful stop
  (`stopped`, exit `0`): the in-flight request completes, validates, and
  persists before halting. Electron's cancel therefore degrades to
  graceful stop within its SIGKILL grace period on POSIX; on Windows the
  plain kill still terminates immediately.
- `KeyboardInterrupt` (e.g. Electron cancel via SIGTERM/SIGKILL) emits
  `{"type": "error", "stage": "worker", "message": "Processing was cancelled."}`
  and exits `130`.

## Electron run modes

- Adaptive sampling: `--adaptive [--adaptive-max-frames N]` (paid) is
  the only analysis mode. One captured frame, one vision request, one
  validated sampling decision per step; the next timestamp follows the
  decision (HIGH 0.5s, NORMAL 3s, LOW 6s). No extracted JPEG set is
  written; stages are `adaptive_vision` plus the offline downstream;
  the run `mode` is `adaptive`. The first failure terminates the run;
  a stop request emits `stopped` instead. The main process refuses runs
  without a verified credential and the worker fails fast before any
  paid call; key values never appear in any message. `vision-status`
  reports only whether a key is configured.
- One attempt per frame: the engine performs no automatic retries,
  so a run spends at most one vision call per selected frame.
- Streaming commentary: `--streaming` (paid opt-in, requires
  `--adaptive`) words script utterances and synthesizes audio while
  vision is still sampling, over bounded in-process queues. One script
  LLM call per window (at most 6 claims each), one TTS request per
  utterance, sequential within each stage. Priority is enforced
  app-side: candidate-event utterances outrank developments, which
  outrank scene wording, and urgent utterances supersede routine ones
  still queued. The main process refuses TTS without the script or
  streaming, and the worker fails fast on missing keys before any paid
  call, exactly like sequential runs.

Malformed stdout lines are never fatal to the parser: the Electron
`createLineParser` counts them, forwards a `worker-log` note, and keeps
parsing the rest of the stream. A clean worker ends stdout with a
trailing newline; bytes after the last newline at process end are
dispatched as a final message.

## Testing

- `tests/test_worker.py` covers argument parsing (including the
  required `--adaptive` flag and rejected legacy flags), invalid video
  paths, pure-NDJSON stdout, the adaptive-only plan, mocked adaptive
  success/failure, error handling, exit codes, and secret redaction,
  and `tests/test_adaptive.py` covers the adaptive stage, the `stopped`
  terminal, the adaptive protocol (including `adaptive_sample`
  emission), the iteration hook, and the engine stop boundaries —
  all offline with fixture videos and observations, never paid calls.
  `tests/test_tts.py` covers the TTS runner and manifest (mocked
  synthesis, per-segment failure isolation, redaction),
  `tests/test_tts_catalog.py` covers the offline catalogue probe, and
  `tests/test_worker.py` covers the `--generate-tts` flag validation,
  TTS key fail-fast, `--tts-*` config validation/thread-through, and
  the `tts` worker stage.
- `electron/test/` covers incremental parsing (split chunks, multiple
  messages per chunk, invalid lines), input validation, interpreter
  resolution, process cancel/cleanup, `adaptive_sample` shape validation,
  run-option mapping, adaptive state folding, fractional observation
  listing, cooperative-stop IPC/settlement, streaming message shape
  validation (`script_segment`/`tts_segment`), streaming argv mapping,
  and script-segment state folding — with `node:test`, no
  dependencies.
- `tests/test_streaming.py` covers the streaming queues (backpressure,
  priority, supersession), script windows (fresh/dedupe/overflow/
  failure), the orchestrator (final layout, supersession, per-utterance
  failure isolation, WAV validation, silence), and the worker streaming
  path (mocked-vision overlap proof, partials on stop/failure, NDJSON
  cleanliness) — all offline with fake clients, never paid calls.
