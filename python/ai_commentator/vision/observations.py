import json
import math
import re

from ..config import (
    OBSERVATION_CATEGORIES,
    OBSERVATION_CONFIDENCES,
    OBSERVATION_SCHEMA_VERSION,
    OBSERVATION_SCHEMA_VERSION_V2,
    OBSERVATION_SCHEMA_VERSIONS,
    OBSERVATION_SUBJECT_KINDS,
)
from ..errors import ObservationError


def parse_observation(text):
    if not isinstance(text, str) or not text.strip():
        raise ObservationError("Baseten returned no text content.")
    cleaned = text.strip()
    if cleaned.startswith("```"):
        match = re.match(r"^```(?:json)?\s*\n?(.*?)\n?```\s*$", cleaned, re.DOTALL)
        if match is None:
            raise ObservationError("Model output is not a single JSON value.")
        cleaned = match.group(1).strip()
        if not cleaned:
            raise ObservationError("Baseten returned no text content.")
    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError as exc:
        raise ObservationError(f"Model output is not valid JSON: {exc}") from None
    if not isinstance(data, dict):
        raise ObservationError("Model output must be a JSON object.")
    return data


def _reject_extra(mapping, allowed, where):
    extra = sorted(set(mapping) - set(allowed))
    if extra:
        raise ObservationError(f"{where} has unsupported fields: {', '.join(extra)}.")


def _require_non_empty_string(mapping, field, where):
    value = mapping.get(field)
    if not isinstance(value, str) or not value.strip():
        raise ObservationError(f"{where} requires a non-empty string field '{field}'.")
    return value


def _check_entry_core(item, where):
    """Validate the v1 core fields shared by both schema versions."""
    if item.get("category") not in OBSERVATION_CATEGORIES:
        raise ObservationError(
            f"{where} has unsupported category "
            f"'{item.get('category')}'; expected one of: "
            f"{', '.join(OBSERVATION_CATEGORIES)}."
        )
    _require_non_empty_string(item, "description", where)
    if item.get("confidence") not in OBSERVATION_CONFIDENCES:
        raise ObservationError(
            f"{where} has invalid confidence '{item.get('confidence')}'; "
            f"expected one of: {', '.join(OBSERVATION_CONFIDENCES)}."
        )
    _require_non_empty_string(item, "evidence", where)


def _check_verbatim_quote(value, description, evidence, where, what):
    """Require a structured token to quote the entry's own text verbatim."""
    if value not in description and value not in evidence:
        raise ObservationError(
            f"{where} {what} must quote the entry's description "
            f"or evidence verbatim."
        )


def _validate_entry_v2(item, where):
    """Validate one observation-v2 entry: v1 core plus optional evidence."""
    _reject_extra(
        item,
        (
            "category",
            "description",
            "confidence",
            "evidence",
            "subjects",
            "action",
            "spatial",
        ),
        where,
    )
    _check_entry_core(item, where)
    description = item["description"]
    evidence = item["evidence"]
    if "subjects" in item:
        subjects = item["subjects"]
        if not isinstance(subjects, list):
            raise ObservationError(f"{where} field 'subjects' must be a list.")
        for sub_index, subject in enumerate(subjects):
            sub_where = f"{where}.subjects[{sub_index}]"
            if not isinstance(subject, dict):
                raise ObservationError(f"{sub_where} must be an object.")
            _reject_extra(subject, ("label", "kind"), sub_where)
            label = _require_non_empty_string(subject, "label", sub_where)
            if subject.get("kind") not in OBSERVATION_SUBJECT_KINDS:
                raise ObservationError(
                    f"{sub_where} has unsupported kind "
                    f"'{subject.get('kind')}'; expected one of: "
                    f"{', '.join(OBSERVATION_SUBJECT_KINDS)}."
                )
            _check_verbatim_quote(label, description, evidence, sub_where, "label")
    for field in ("action", "spatial"):
        if field not in item:
            continue
        value = item[field]
        if value is None:
            continue
        if not isinstance(value, str) or not value.strip():
            raise ObservationError(
                f"{where} field '{field}' must be a non-empty string or null."
            )
        _check_verbatim_quote(value, description, evidence, where, f"field '{field}'")


def validate_observation(data):
    if not isinstance(data, dict):
        raise ObservationError("Observation must be a JSON object.")
    _reject_extra(
        data,
        ("schema_version", "timestamp", "observations", "uncertainties"),
        "Observation",
    )
    version = data.get("schema_version")
    if version not in OBSERVATION_SCHEMA_VERSIONS:
        raise ObservationError(
            "Observation requires schema_version "
            f"'{OBSERVATION_SCHEMA_VERSION}' or "
            f"'{OBSERVATION_SCHEMA_VERSION_V2}'."
        )
    if "timestamp" not in data:
        raise ObservationError("Observation requires field 'timestamp'.")
    timestamp = data["timestamp"]
    if (
        isinstance(timestamp, bool)
        or not isinstance(timestamp, (int, float))
        or (isinstance(timestamp, float) and not math.isfinite(timestamp))
    ):
        raise ObservationError("Observation field 'timestamp' must be a number.")
    if "observations" not in data or not isinstance(data["observations"], list):
        raise ObservationError("Observation requires field 'observations' as a list.")
    for index, item in enumerate(data["observations"]):
        where = f"observations[{index}]"
        if not isinstance(item, dict):
            raise ObservationError(f"{where} must be an object.")
        if version == OBSERVATION_SCHEMA_VERSION_V2:
            _validate_entry_v2(item, where)
        else:
            _reject_extra(
                item, ("category", "description", "confidence", "evidence"), where
            )
            _check_entry_core(item, where)
    if "uncertainties" not in data or not isinstance(data["uncertainties"], list):
        raise ObservationError("Observation requires field 'uncertainties' as a list.")
    for index, entry in enumerate(data["uncertainties"]):
        if not isinstance(entry, str) or not entry.strip():
            raise ObservationError(
                f"uncertainties[{index}] must be a non-empty string."
            )
    return data
