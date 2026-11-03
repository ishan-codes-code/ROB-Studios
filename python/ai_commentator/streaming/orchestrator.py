"""Streaming orchestration: concurrent script + TTS consumers.

The vision loop (owned by the worker/CLI) stays the producer: every
validated, persisted observation is submitted to the pipeline, which
words script utterances and synthesizes audio concurrently in worker
threads. Bounded queues apply backpressure; sentinels shut the stages
down in order; failures stay isolated per window or per utterance; and
``wait()`` always finalizes honest artifacts from whatever completed —
final ``script.json``/``tts.json`` keep the exact sequential layout
(stable ``segment-NNN`` ids, segment-named WAVs).
"""

from __future__ import annotations

import os
import sys
import threading
from pathlib import Path

from ..commentary.generation import load_prior_commentary
from ..config import (
    EVENTS_FILENAME,
    MATCH_STATE_FILENAME,
    SCRIPT_MAX_HISTORY_LINES,
    SCRIPT_SCHEMA_VERSION,
)
from ..errors import ObservationError
from ..script.generation import (
    load_prior_script,
    script_segment_id,
    validate_script,
)
from ..storage import write_bytes_atomic, write_json_atomic
from ..tts.config import TTS_MANIFEST_FILENAME, TTS_SEGMENTS_DIRNAME, generation_identity
from ..tts.manifest import audio_relpath, build_tts_manifest, validate_tts_manifest
from ..tts.runner import sanitize_segment_filename
from .queues import (
    DEFAULT_OBSERVATION_QUEUE_SIZE,
    DEFAULT_SEGMENT_QUEUE_SIZE,
    PRIORITY_HIGH,
    ObservationQueue,
    PrioritySegmentQueue,
    _Closed,
    utterance_id,
)
from .windows import WINDOW_MIN_OBSERVATIONS, run_script_window


def wav_bytes_valid(payload) -> bool:
    """Check one synthesized payload before it is marked ready.

    Minimal container validation only (WAV magic + sane length): a
    provider hiccup that returns an error page or truncated body must
    mark the utterance failed, never write a corrupt file.
    """
    if not isinstance(payload, (bytes, bytearray)):
        return False
    if len(payload) < 12:
        return False
    return bytes(payload[:4]) == b"RIFF" and bytes(payload[8:12]) == b"WAVE"


class StreamLedger:
    """Thread-safe record of every utterance, omission, and error."""

    def __init__(self):
        self._lock = threading.Lock()
        self._utterances: dict = {}
        self._order: list = []
        self._omitted: list = []
        self._omitted_keys: set = set()
        self._errors: list = []

    def append_utterance(self, record: dict) -> None:
        with self._lock:
            self._utterances[record["utterance_id"]] = record
            self._order.append(record["utterance_id"])

    def add_omitted(self, entries: list) -> None:
        with self._lock:
            for entry in entries:
                key = (entry["rule"], entry["subject"], entry["reason"])
                if key in self._omitted_keys:
                    continue
                self._omitted_keys.add(key)
                self._omitted.append(dict(entry))

    def add_error(self, message: str) -> None:
        with self._lock:
            self._errors.append(message)

    def mark_superseded(self, utterance_id_: str) -> dict | None:
        with self._lock:
            record = self._utterances.get(utterance_id_)
            if record is None or record["script_status"] != "worded":
                return None
            record["script_status"] = "superseded"
            return dict(record)

    def mark_tts(self, utterance_id_: str, status: str, audio_file, error) -> dict | None:
        with self._lock:
            record = self._utterances.get(utterance_id_)
            if record is None:
                return None
            record["tts_status"] = status
            record["audio_file"] = audio_file
            record["tts_error"] = error
            return dict(record)

    def snapshot(self) -> tuple[list, list, list]:
        with self._lock:
            utterances = [dict(self._utterances[key]) for key in self._order]
            return utterances, list(self._omitted), list(self._errors)


class StreamingPipeline:
    """Own the script + TTS consumer threads for one streaming run.

    ``script_client`` makes the bounded script LLM calls (one worker
    thread only); ``tts_client`` synthesizes utterances (one worker
    thread only) unless ``tts`` is None (audio not requested). Clients
    are caller-owned: constructed and closed outside the pipeline, never
    shared across threads. ``on_script_segment``/``on_tts_segment``
    report validated events (the worker forwards them as NDJSON); their
    exceptions are contained so reporting never breaks a stage.
    """

    def __init__(
        self,
        *,
        script_path: Path,
        commentary_path: Path,
        audio_dir: Path | None,
        tts_config: tuple | None,
        pack=None,
        on_script_segment=None,
        on_tts_segment=None,
        script_client=None,
        tts_client=None,
        obs_queue_size: int = DEFAULT_OBSERVATION_QUEUE_SIZE,
        seg_queue_size: int = DEFAULT_SEGMENT_QUEUE_SIZE,
        window_min_observations: int = WINDOW_MIN_OBSERVATIONS,
    ):
        self._script_path = Path(script_path)
        self._commentary_path = Path(commentary_path)
        self._audio_dir = Path(audio_dir) if audio_dir is not None else None
        self._tts_config = tts_config
        self._pack = pack
        self._on_script_segment = on_script_segment
        self._on_tts_segment = on_tts_segment
        self._script_client = script_client
        self._tts_client = tts_client
        self._obs_queue = ObservationQueue(maxsize=obs_queue_size)
        self._seg_queue = PrioritySegmentQueue(maxsize=seg_queue_size)
        self._window_min = max(1, window_min_observations)
        self._ledger = StreamLedger()
        self._claims_by_id: dict = {}
        self._sources: list = []
        self._script_thread: threading.Thread | None = None
        self._tts_thread: threading.Thread | None = None
        self._utterance_seq = 0

    # -- producer API (called from the vision loop thread) ---------------

    def submit_observation(self, timestamp, source: str, validated: dict, speed: str) -> None:
        """Queue one validated observation (blocks on backpressure)."""
        self._obs_queue.put_observation((timestamp, source, validated, speed))

    def finish_vision(self) -> None:
        """Signal end of the vision stream; consumers drain and stop."""
        try:
            self._obs_queue.close()
        except _Closed:
            pass

    def halt(self) -> None:
        """Unblock every waiter for an abnormal shutdown."""
        self._obs_queue.halt()
        self._seg_queue.halt()

    # -- lifecycle ---------------------------------------------------------

    def start(self) -> None:
        """Start the consumer threads (idempotent per pipeline)."""
        if self._script_thread is not None:
            return
        self._script_thread = threading.Thread(
            target=self._script_loop, name="stream-script", daemon=True
        )
        self._script_thread.start()
        if self._tts_config is not None:
            self._tts_thread = threading.Thread(
                target=self._tts_loop, name="stream-tts", daemon=True
            )
            self._tts_thread.start()

    def wait(self) -> dict:
        """Join consumers, finalize artifacts, and return stage results."""
        if self._script_thread is not None:
            self._script_thread.join()
        if self._tts_thread is not None:
            self._tts_thread.join()
        return self._finalize()

    # -- script consumer ---------------------------------------------------

    def _report(self, callback, payload: dict) -> None:
        if callback is None:
            return
        try:
            callback(dict(payload))
        except Exception as exc:  # reporting must never break a stage
            print(f"Streaming report hook failed: {exc}", file=sys.stderr)

    def _script_loop(self) -> None:
        try:
            self._run_script_windows()
        except _Closed:
            pass
        except Exception as exc:  # never hang the TTS stage on a crash
            self._ledger.add_error(f"script stage failed: {exc}")
            print(f"Streaming script stage failed: {exc}", file=sys.stderr)
        finally:
            self._seg_queue.close()

    def _run_script_windows(self) -> None:
        prior_claims, prior_texts = load_prior_script(self._script_path)
        _prior_ids, _prior_seq, prior_commentary_texts = load_prior_commentary(
            self._commentary_path
        )
        seen: set = set(prior_claims)
        history: list = (prior_commentary_texts + prior_texts)[-SCRIPT_MAX_HISTORY_LINES:]
        observations: list = []
        pending = 0
        while True:
            item = self._obs_queue.get()
            if item is None:
                break
            timestamp, source, validated, speed = item
            observations.append((timestamp, source, validated))
            self._sources.append(source)
            pending += 1
            if pending >= self._window_min or speed == "HIGH":
                self._run_window(observations, history, seen)
                pending = 0
        if pending > 0:
            self._run_window(observations, history, seen)

    def _run_window(self, observations: list, history: list, seen: set) -> None:
        utterances, omitted, fresh, error = run_script_window(
            list(observations), list(history), seen, self._script_client, self._pack
        )
        for claim in fresh:
            self._claims_by_id[claim["claim_id"]] = claim
        self._ledger.add_omitted(omitted)
        if error is not None:
            self._ledger.add_error(error)
            print(f"Streaming script window: {error}", file=sys.stderr)
        for utterance in utterances:
            uid = utterance_id(self._utterance_seq)
            self._utterance_seq += 1
            record = {
                "utterance_id": uid,
                "timestamp": utterance["timestamp"],
                "text": utterance["text"],
                "source_claim_ids": list(utterance["source_claim_ids"]),
                "priority": utterance["priority"],
                "script_status": "worded",
                "tts_status": "pending" if self._tts_config is not None else "not-requested",
                "audio_file": None,
                "tts_error": None,
            }
            self._ledger.append_utterance(record)
            history.append(utterance["text"])
            del history[:-SCRIPT_MAX_HISTORY_LINES]
            self._report(
                self._on_script_segment,
                {
                    "utterance_id": uid,
                    "timestamp_seconds": utterance["timestamp"],
                    "text": utterance["text"],
                    "source_claim_ids": list(utterance["source_claim_ids"]),
                    "priority": utterance["priority"],
                    "status": "worded",
                },
            )
            if self._tts_config is not None:
                # High-priority utterances pre-empt lower-priority ones
                # still waiting for synthesis; in-flight audio is never
                # recalled.
                if utterance["priority"] == PRIORITY_HIGH:
                    for dropped in self._seg_queue.supersede(PRIORITY_HIGH):
                        marked = self._ledger.mark_superseded(dropped["utterance_id"])
                        if marked is not None:
                            self._report(
                                self._on_script_segment,
                                {
                                    "utterance_id": marked["utterance_id"],
                                    "timestamp_seconds": marked["timestamp"],
                                    "text": marked["text"],
                                    "source_claim_ids": list(marked["source_claim_ids"]),
                                    "priority": marked["priority"],
                                    "status": "superseded",
                                },
                            )
                try:
                    self._seg_queue.put(utterance["priority"], record)
                except _Closed:
                    return

    # -- TTS consumer ------------------------------------------------------

    def _tts_loop(self) -> None:
        assert self._tts_config is not None and self._tts_client is not None
        model, voice, direction = self._tts_config
        segments_dir = self._audio_dir / TTS_SEGMENTS_DIRNAME
        while True:
            try:
                item = self._seg_queue.get()
            except _Closed:
                return
            if item is None:
                return
            uid = item["utterance_id"]
            marked = self._ledger.mark_tts(uid, "started", None, None)
            if marked is not None:
                self._report(self._on_tts_segment, self._tts_event(marked))
            try:
                wav = self._tts_client.synthesize(
                    item["text"], voice=voice, style=direction
                )
            except Exception as exc:
                message = " ".join(str(exc or type(exc).__name__).split())
                marked = self._ledger.mark_tts(uid, "error", None, message)
                print(f"Streaming TTS utterance {uid} failed: {message}", file=sys.stderr)
                if marked is not None:
                    self._report(self._on_tts_segment, self._tts_event(marked))
                continue
            if not wav_bytes_valid(wav):
                message = "TTS returned invalid audio bytes."
                marked = self._ledger.mark_tts(uid, "error", None, message)
                print(f"Streaming TTS utterance {uid} failed: {message}", file=sys.stderr)
                if marked is not None:
                    self._report(self._on_tts_segment, self._tts_event(marked))
                continue
            try:
                filename = sanitize_segment_filename(uid) + ".wav"
                write_bytes_atomic(segments_dir / filename, bytes(wav))
            except (OSError, ValueError, TypeError) as exc:
                message = " ".join(str(exc).split())
                marked = self._ledger.mark_tts(uid, "error", None, message)
                print(f"Streaming TTS utterance {uid} failed: {message}", file=sys.stderr)
                if marked is not None:
                    self._report(self._on_tts_segment, self._tts_event(marked))
                continue
            marked = self._ledger.mark_tts(uid, "success", audio_relpath(filename), None)
            if marked is not None:
                self._report(self._on_tts_segment, self._tts_event(marked))

    @staticmethod
    def _tts_event(record: dict) -> dict:
        return {
            "utterance_id": record["utterance_id"],
            "timestamp_seconds": record["timestamp"],
            "status": record["tts_status"],
            "error": record["tts_error"],
        }

    # -- finalization ------------------------------------------------------

    def _finalize(self) -> dict:
        utterances, omitted, errors = self._ledger.snapshot()
        if not self._sources:
            # No observation ever arrived (immediate stop or empty
            # video): nothing to word, nothing to write. The worker
            # reports the run from the vision termination instead.
            return {
                "script_status": "skipped",
                "script_ok": True,
                "tts_status": "skipped",
                "tts_ok": True,
                "segments": 0,
                "utterances": 0,
                "superseded": 0,
                "window_errors": list(errors),
                "script_path": None,
                "tts_path": None,
            }
        spoken = [u for u in utterances if u["script_status"] == "worded"]
        spoken.sort(key=lambda u: (u["timestamp"], u["source_claim_ids"]))
        for record in utterances:
            if record["script_status"] == "superseded":
                omitted.append(
                    {
                        "rule": "superseded",
                        "subject": record["utterance_id"],
                        "reason": (
                            "a higher-priority utterance arrived while this one "
                            "was still queued for synthesis."
                        ),
                    }
                )
        accepted_names = sorted(set(self._sources))
        segments = []
        for position, record in enumerate(spoken):
            segments.append(
                {
                    "segment_id": script_segment_id(position),
                    "timestamp_seconds": record["timestamp"],
                    "text": record["text"],
                    "source_claim_ids": list(record["source_claim_ids"]),
                }
            )
        generated_from = {
            "observations": accepted_names,
            "match_state": MATCH_STATE_FILENAME,
            "events": EVENTS_FILENAME,
        }
        if segments:
            script_status: str = "success"
            script_error = None
        elif errors:
            script_status = "error"
            script_error = f"script generation failed: {errors[0]}"
        else:
            script_status = "silence"
            script_error = None
        script_doc = {
            "schema_version": SCRIPT_SCHEMA_VERSION,
            "status": script_status,
            "generated_from": generated_from,
            "segments": segments,
            "omitted": omitted,
            "error": script_error,
        }
        script_ok = True
        try:
            validate_script(script_doc, self._claims_by_id)
        except ObservationError as exc:
            script_ok = False
            print(f"Streaming script validation failed: {exc}", file=sys.stderr)
            script_doc = {
                "schema_version": SCRIPT_SCHEMA_VERSION,
                "status": "error",
                "generated_from": generated_from,
                "segments": [],
                "omitted": omitted
                + [
                    {
                        "rule": "model-output",
                        "subject": "script-request",
                        "reason": f"final script failed validation: {exc}",
                    }
                ],
                "error": f"script generation failed: {exc}",
            }
            validate_script(script_doc)
        self._script_path.parent.mkdir(parents=True, exist_ok=True)
        write_json_atomic(self._script_path, script_doc)
        # Map utterances to final segments for the TTS manifest.
        utterance_to_segment = {}
        for segment in script_doc["segments"]:
            for record in spoken:
                if (
                    record["timestamp"] == segment["timestamp_seconds"]
                    and record["source_claim_ids"] == segment["source_claim_ids"]
                    and record["utterance_id"] not in utterance_to_segment
                ):
                    utterance_to_segment[record["utterance_id"]] = segment["segment_id"]
                    break
        tts_status = "skipped"
        tts_ok = True
        if self._tts_config is not None and script_ok and self._script_path.is_file():
            tts_status, tts_ok = self._finalize_tts(
                script_doc, spoken, utterance_to_segment, utterances
            )
        elif self._tts_config is not None and not script_ok:
            tts_status = "error"
            tts_ok = False
        return {
            "script_status": script_doc["status"],
            "script_ok": script_ok and script_doc["status"] != "error",
            "tts_status": tts_status,
            "tts_ok": tts_ok,
            "segments": len(script_doc["segments"]),
            "utterances": len(utterances),
            "superseded": sum(1 for u in utterances if u["script_status"] == "superseded"),
            "window_errors": list(errors),
            "script_path": str(self._script_path) if self._script_path.is_file() else None,
            "tts_path": (
                str(self._audio_dir / TTS_MANIFEST_FILENAME)
                if self._tts_config is not None
                and (self._audio_dir / TTS_MANIFEST_FILENAME).is_file()
                else None
            ),
        }

    def _finalize_tts(
        self, script_doc: dict, spoken: list, utterance_to_segment: dict, utterances: list
    ) -> tuple[str, bool]:
        model, voice, direction = self._tts_config
        segments_dir = self._audio_dir / TTS_SEGMENTS_DIRNAME
        by_utterance = {u["utterance_id"]: u for u in utterances}
        entries = []
        for segment in script_doc["segments"]:
            utterance = next(
                (
                    by_utterance[uid]
                    for uid, sid in utterance_to_segment.items()
                    if sid == segment["segment_id"]
                ),
                None,
            )
            if utterance is None or utterance["tts_status"] != "success":
                entries.append(
                    {
                        "segment_id": segment["segment_id"],
                        "timestamp_seconds": segment["timestamp_seconds"],
                        "text": segment["text"],
                        "source_claim_ids": list(segment["source_claim_ids"]),
                        "audio_file": None,
                        "status": "error",
                        "error": (
                            (utterance or {}).get("tts_error")
                            or "utterance audio was not synthesized."
                        ),
                    }
                )
                continue
            # Rename the utterance WAV to the final segment id so the
            # finished layout matches the sequential runner exactly.
            try:
                source_name = sanitize_segment_filename(utterance["utterance_id"]) + ".wav"
                target_name = sanitize_segment_filename(segment["segment_id"]) + ".wav"
                os.replace(segments_dir / source_name, segments_dir / target_name)
                audio_file: str | None = audio_relpath(target_name)
                status, error = "success", None
            except OSError as exc:
                audio_file, status, error = None, "error", " ".join(str(exc).split())
            entries.append(
                {
                    "segment_id": segment["segment_id"],
                    "timestamp_seconds": segment["timestamp_seconds"],
                    "text": segment["text"],
                    "source_claim_ids": list(segment["source_claim_ids"]),
                    "audio_file": audio_file,
                    "status": status,
                    "error": error,
                }
            )
        script_bytes = self._script_path.read_bytes()
        manifest = build_tts_manifest(
            generation_id=generation_identity(script_bytes, model, voice, direction),
            model=model,
            voice=voice,
            voice_direction=direction,
            script_name=self._script_path.name,
            script_status=script_doc["status"],
            entries=entries,
        )
        validate_tts_manifest(manifest)
        self._audio_dir.mkdir(parents=True, exist_ok=True)
        write_json_atomic(self._audio_dir / TTS_MANIFEST_FILENAME, manifest)
        status = manifest["status"]
        return status, status in ("success", "silence")
