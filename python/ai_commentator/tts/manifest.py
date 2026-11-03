"""TTS manifest (``tts-v1``): schema assembly and strict validation.

The manifest records the relationship between ``script-v1`` segments
and the WAV files synthesized for them, so a future audio player can
reconstruct the commentary sequence without touching the script.
See ``docs/contracts/tts-v1.md``.
"""

from __future__ import annotations

from ..errors import ObservationError
from .config import (
    TTS_ENTRY_STATUSES,
    TTS_MODELS,
    TTS_RUN_STATUSES,
    TTS_SCHEMA_VERSION,
    TTS_SEGMENTS_DIRNAME,
)

_MANIFEST_FIELDS = (
    "schema_version",
    "status",
    "generation_id",
    "model",
    "voice",
    "voice_direction",
    "generated_from",
    "entries",
)
_ENTRY_FIELDS = (
    "segment_id",
    "timestamp_seconds",
    "text",
    "source_claim_ids",
    "audio_file",
    "status",
    "error",
)


def audio_relpath(filename: str) -> str:
    """Return the manifest-relative audio path for a segment WAV file."""
    return f"{TTS_SEGMENTS_DIRNAME}/{filename}"


def _status_from_entries(entries: list) -> str:
    """Derive the run status for a non-silent run from its entries."""
    if any(entry["status"] == "error" for entry in entries):
        if any(entry["status"] == "success" for entry in entries):
            return "partial"
        return "error"
    return "success"


def tts_run_status(*, script_status: str, entries: list) -> str:
    """Derive the manifest run status from the script status and entries."""
    if script_status == "silence":
        return "silence"
    if script_status != "success":
        raise ValueError(f"Cannot derive a TTS status from script status {script_status!r}.")
    return _status_from_entries(entries)


def build_tts_manifest(
    *,
    generation_id: str,
    model: str,
    voice: str,
    voice_direction: str,
    script_name: str,
    script_status: str,
    entries: list,
) -> dict:
    """Assemble a ``tts-v1`` manifest document (validated before writing)."""
    return {
        "schema_version": TTS_SCHEMA_VERSION,
        "status": tts_run_status(script_status=script_status, entries=entries),
        "generation_id": generation_id,
        "model": model,
        "voice": voice,
        "voice_direction": voice_direction,
        "generated_from": {"script": script_name},
        "entries": [dict(entry) for entry in entries],
    }


def _reject_extra(data: dict, allowed: tuple, where: str) -> None:
    for key in data:
        if key not in allowed:
            raise ObservationError(f"{where} has unknown field '{key}'.")


def _require_non_empty_string(data: dict, field: str, where: str) -> str:
    value = data.get(field)
    if not isinstance(value, str) or not value.strip():
        raise ObservationError(f"{where} requires '{field}' as a non-empty string.")
    return value


def _require_finite_timestamp(value, where: str) -> None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ObservationError(f"{where} field 'timestamp_seconds' must be a number.")
    if isinstance(value, float):
        import math

        if not math.isfinite(value):
            raise ObservationError(
                f"{where} field 'timestamp_seconds' must be a number."
            )


def validate_tts_manifest(data: dict) -> dict:
    """Strictly validate a ``tts-v1`` manifest; reject anything else."""
    if not isinstance(data, dict):
        raise ObservationError("TTS manifest must be a JSON object.")
    _reject_extra(data, _MANIFEST_FIELDS, "TTS manifest")
    if data.get("schema_version") != TTS_SCHEMA_VERSION:
        raise ObservationError(
            f"TTS manifest requires schema_version '{TTS_SCHEMA_VERSION}'."
        )
    if data.get("status") not in TTS_RUN_STATUSES:
        raise ObservationError(
            f"TTS manifest has invalid status '{data.get('status')}'."
        )
    generation_id = data.get("generation_id")
    if (
        not isinstance(generation_id, str)
        or len(generation_id) != 64
        or any(char not in "0123456789abcdef" for char in generation_id)
    ):
        raise ObservationError(
            "TTS manifest requires 'generation_id' as 64 lowercase hex chars."
        )
    if data.get("model") not in TTS_MODELS:
        raise ObservationError(
            f"TTS manifest has unsupported model '{data.get('model')}'."
        )
    _require_non_empty_string(data, "voice", "TTS manifest")
    _require_non_empty_string(data, "voice_direction", "TTS manifest")
    generated = data.get("generated_from")
    if not isinstance(generated, dict):
        raise ObservationError("TTS manifest requires 'generated_from' as an object.")
    _reject_extra(generated, ("script",), "TTS manifest generated_from")
    _require_non_empty_string(generated, "script", "TTS manifest generated_from")
    if "entries" not in data or not isinstance(data["entries"], list):
        raise ObservationError("TTS manifest requires 'entries' as a list.")
    seen_ids: set = set()
    last_timestamp = None
    for index, entry in enumerate(data["entries"]):
        where = f"entries[{index}]"
        if not isinstance(entry, dict):
            raise ObservationError(f"{where} must be an object.")
        _reject_extra(entry, _ENTRY_FIELDS, where)
        _require_non_empty_string(entry, "segment_id", where)
        if entry["segment_id"] in seen_ids:
            raise ObservationError(f"{where} duplicates segment id.")
        seen_ids.add(entry["segment_id"])
        _require_finite_timestamp(entry.get("timestamp_seconds"), where)
        if last_timestamp is not None and entry["timestamp_seconds"] < last_timestamp:
            raise ObservationError(f"{where} breaks chronological ordering.")
        last_timestamp = entry["timestamp_seconds"]
        _require_non_empty_string(entry, "text", where)
        claim_ids = entry.get("source_claim_ids")
        if (
            not isinstance(claim_ids, list)
            or not claim_ids
            or any(not isinstance(i, str) or not i.strip() for i in claim_ids)
        ):
            raise ObservationError(
                f"{where} requires 'source_claim_ids' as a non-empty list."
            )
        entry_status = entry.get("status")
        if entry_status not in TTS_ENTRY_STATUSES:
            raise ObservationError(f"{where} has invalid status '{entry_status}'.")
        audio_file = entry.get("audio_file")
        error = entry.get("error")
        if entry_status == "success":
            if (
                not isinstance(audio_file, str)
                or not audio_file.startswith(f"{TTS_SEGMENTS_DIRNAME}/")
                or not audio_file.endswith(".wav")
                or ".." in audio_file
            ):
                raise ObservationError(
                    f"{where} requires 'audio_file' as a segments/ WAV path."
                )
            if error is not None:
                raise ObservationError(f"{where} with status 'success' requires a null error.")
        else:
            if audio_file is not None:
                raise ObservationError(
                    f"{where} with status '{entry_status}' requires a null audio_file."
                )
            if entry_status == "error":
                if not isinstance(error, str) or not error.strip():
                    raise ObservationError(
                        f"{where} with status 'error' requires an error message."
                    )
            elif error is not None:
                raise ObservationError(
                    f"{where} with status 'skipped' requires a null error."
                )
    status = data.get("status")
    entries = data["entries"]
    if not entries:
        if status != "silence":
            raise ObservationError("TTS manifest with no entries requires status 'silence'.")
    elif status == "silence":
        raise ObservationError("TTS manifest status 'silence' requires no entries.")
    elif status != _status_from_entries(entries):
        raise ObservationError(
            f"TTS manifest status '{status}' does not match its entries."
        )
    return data
