"""Script-to-audio orchestration: ``script-v1`` segments to WAV files.

Reads the existing final casting script (never modifies it), synthesizes
each eligible segment sequentially with the shared :class:`GeminiTTSClient`,
writes one WAV per segment under ``audio/segments/``, and records the
outcome in the ``tts-v1`` manifest (``audio/tts.json``).

Failure policy: one failed segment never corrupts the others — successes
are preserved, every outcome is recorded, and the run exits non-zero
unless every entry succeeded (or the script was silent).
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

from ..config import PROJECT_ROOT, SCRIPT_PATH
from ..script.generation import validate_script
from ..storage import write_bytes_atomic, write_json_atomic
from .client import GeminiTTSClient
from .config import (
    DEFAULT_TTS_MODEL,
    DEFAULT_TTS_VOICE,
    DEFAULT_TTS_VOICE_DIRECTION,
    TTS_API_KEY_ENV_VAR,
    TTS_AUDIO_DIRNAME,
    TTS_MANIFEST_FILENAME,
    TTS_MAX_ERROR_CHARS,
    TTS_SEGMENTS_DIRNAME,
    generation_identity,
    validate_tts_config,
)
from .manifest import (
    audio_relpath,
    build_tts_manifest,
    validate_tts_manifest,
)

_FILENAME_UNSAFE_RE = re.compile(r"[^A-Za-z0-9_.-]")


def sanitize_segment_filename(segment_id: str) -> str:
    """Derive a stable, traversal-free basename from a segment id.

    Unsafe characters become underscores; empty or dot-only results are
    rejected. The ``.wav`` suffix is added by the caller.
    """
    if not isinstance(segment_id, str):
        raise ValueError("Segment id must be a string.")
    name = _FILENAME_UNSAFE_RE.sub("_", segment_id.strip())
    if not name or not name.strip("."):
        raise ValueError(f"Segment id {segment_id!r} cannot form a safe filename.")
    return name


def _redact(text: str, api_key: str) -> str:
    if api_key and api_key in text:
        text = text.replace(api_key, "[REDACTED]")
    return text


def _shorten(text: str) -> str:
    collapsed = " ".join(str(text).split())
    if len(collapsed) > TTS_MAX_ERROR_CHARS:
        collapsed = collapsed[:TTS_MAX_ERROR_CHARS] + "...(truncated)"
    return collapsed


def run_generate_tts(
    script_path: Path | None = None,
    audio_dir: Path | None = None,
    api_key: str | None = None,
    model: str | None = None,
    voice: str | None = None,
    voice_direction: str | None = None,
    client=None,
) -> int:
    """Synthesize every script segment to WAV; return exit code.

    Paid and opt-in: one TTS request per segment, sequential, no
    retries. The script is only read; the audio tree is written with
    atomic file replacement. Exit 0 when every entry succeeded (or the
    script was silent), exit 1 otherwise — with the manifest and all
    successful WAVs preserved either way.
    """
    script_file = SCRIPT_PATH if script_path is None else Path(script_path)
    out_dir = (
        PROJECT_ROOT / "output" / TTS_AUDIO_DIRNAME
        if audio_dir is None
        else Path(audio_dir)
    )
    key = api_key if api_key is not None else os.environ.get(TTS_API_KEY_ENV_VAR, "")
    if not key:
        print(
            f"Error: {TTS_API_KEY_ENV_VAR} is not set in the environment.",
            file=sys.stderr,
        )
        return 1
    try:
        clean_model, clean_voice, clean_direction = validate_tts_config(
            DEFAULT_TTS_MODEL if model is None else model,
            DEFAULT_TTS_VOICE if voice is None else voice,
            DEFAULT_TTS_VOICE_DIRECTION if voice_direction is None else voice_direction,
        )
    except ValueError as exc:
        print(f"Error: invalid TTS configuration: {_redact(str(exc), key)}.",
              file=sys.stderr)
        return 1
    try:
        script_bytes = script_file.read_bytes()
    except OSError as exc:
        print(f"Error: cannot read script {script_file}: {exc}.", file=sys.stderr)
        return 1
    try:
        script = validate_script(json.loads(script_bytes.decode("utf-8")))
    except ValueError as exc:
        print(
            f"Error: invalid script {script_file}: {_redact(str(exc), key)}.",
            file=sys.stderr,
        )
        return 1
    script_status = script["status"]
    if script_status == "error":
        detail = script.get("error") or "unknown script error"
        print(
            "Error: cannot synthesize audio from a failed script: "
            f"{_redact(_shorten(detail), key)}.",
            file=sys.stderr,
        )
        return 1
    planned: list = []
    seen_filenames: dict = {}
    for segment in script["segments"]:
        segment_id = segment["segment_id"]
        try:
            filename = sanitize_segment_filename(segment_id) + ".wav"
        except ValueError:
            print(
                f"Error: segment id {segment_id!r} cannot form a safe filename.",
                file=sys.stderr,
            )
            return 1
        if filename in seen_filenames:
            print(
                f"Error: segments {seen_filenames[filename]!r} and "
                f"{segment_id!r} collide on filename {filename!r}.",
                file=sys.stderr,
            )
            return 1
        seen_filenames[filename] = segment_id
        planned.append((segment, filename))
    manifest_path = out_dir / TTS_MANIFEST_FILENAME
    segments_dir = out_dir / TTS_SEGMENTS_DIRNAME
    generation_id = generation_identity(
        script_bytes, clean_model, clean_voice, clean_direction
    )

    entries: list = []
    if script_status == "success":
        owned = client is None
        tts = client
        if tts is None:
            try:
                tts = GeminiTTSClient(api_key=key, model=clean_model)
            except Exception as exc:
                print(
                    "Error: cannot start the TTS client: "
                    f"{_redact(_shorten(str(exc) or type(exc).__name__), key)}.",
                    file=sys.stderr,
                )
                return 1
        try:
            for segment, filename in planned:
                segment_id = segment["segment_id"]
                try:
                    wav = tts.synthesize(
                        segment["text"],
                        voice=clean_voice,
                        style=clean_direction,
                    )
                except Exception as exc:
                    message = _redact(
                        _shorten(str(exc) or type(exc).__name__), key
                    )
                    print(f"TTS segment {segment_id} failed: {message}",
                          file=sys.stderr)
                    entries.append({
                        "segment_id": segment_id,
                        "timestamp_seconds": segment["timestamp_seconds"],
                        "text": segment["text"],
                        "source_claim_ids": list(segment["source_claim_ids"]),
                        "audio_file": None,
                        "status": "error",
                        "error": message,
                    })
                    continue
                try:
                    write_bytes_atomic(segments_dir / filename, wav)
                except OSError as exc:
                    message = _redact(_shorten(str(exc)), key)
                    print(f"TTS segment {segment_id} failed: {message}",
                          file=sys.stderr)
                    entries.append({
                        "segment_id": segment_id,
                        "timestamp_seconds": segment["timestamp_seconds"],
                        "text": segment["text"],
                        "source_claim_ids": list(segment["source_claim_ids"]),
                        "audio_file": None,
                        "status": "error",
                        "error": message,
                    })
                    continue
                print(f"TTS segment {segment_id}: wrote {audio_relpath(filename)}.")
                entries.append({
                    "segment_id": segment_id,
                    "timestamp_seconds": segment["timestamp_seconds"],
                    "text": segment["text"],
                    "source_claim_ids": list(segment["source_claim_ids"]),
                    "audio_file": audio_relpath(filename),
                    "status": "success",
                    "error": None,
                })
        finally:
            if owned:
                tts.close()
    manifest = build_tts_manifest(
        generation_id=generation_id,
        model=clean_model,
        voice=clean_voice,
        voice_direction=clean_direction,
        script_name=script_file.name,
        script_status=script_status,
        entries=entries,
    )
    try:
        validate_tts_manifest(manifest)
    except ValueError as exc:
        print(f"Error: built an invalid TTS manifest: {exc}.", file=sys.stderr)
        return 1
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
        write_json_atomic(manifest_path, manifest)
    except OSError as exc:
        print(f"Error: cannot write TTS manifest {manifest_path}: {exc}.",
              file=sys.stderr)
        return 1
    succeeded = sum(1 for entry in entries if entry["status"] == "success")
    failed = sum(1 for entry in entries if entry["status"] == "error")
    print(
        f"TTS {manifest['status']}: {succeeded} succeeded, {failed} failed, "
        f"{len(entries)} segment(s); wrote {manifest_path}."
    )
    return 0 if manifest["status"] in ("success", "silence") else 1
