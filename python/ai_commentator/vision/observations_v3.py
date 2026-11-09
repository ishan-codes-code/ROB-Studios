"""Strict parsing and validation for observation-v3 documents.

v3 reads the frame as a broadcast overlay (HUD values plus visible
cues) instead of prose observations. Unknown is always explicit null,
never a sentence about absence. See
``docs/contracts/observation-v3.md``. Legacy v1/v2 behavior is
untouched: this module only reuses the shared JSON/fence parsing and
field helpers.
"""

import math
import re

from ..config import (
    OBSERVATION_SCHEMA_VERSION_V3,
    OBSERVATION_V3_CONFIDENCES,
    OBSERVATION_V3_CUES,
    OBSERVATION_V3_SCENES,
    OBSERVATION_V3_STATES,
)
from ..errors import ObservationError
from .observations import (
    _reject_extra,
    _require_non_empty_string,
    parse_observation,
)

#: Round clock shape: MM:SS with a one- or two-digit minute field.
TIMER_RE = re.compile(r"^\d{1,2}:\d{2}$")

#: Maximum characters for the optional one-sentence note.
NOTES_MAX_CHARS = 140

#: Maximum words for one cue evidence phrase.
EVIDENCE_MAX_WORDS = 12


def parse_observation_v3(text):
    """Parse one model-output document; same JSON/fence rules as v1/v2."""
    return parse_observation(text)


def _require_int_or_null(mapping, field, where):
    """Return an int-or-null field; reject bools, floats, and strings."""
    if field not in mapping:
        raise ObservationError(f"{where} requires field '{field}'.")
    value = mapping[field]
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise ObservationError(
            f"{where} field '{field}' must be an integer or null."
        )
    return value


def _require_bool(mapping, field, where):
    if field not in mapping:
        raise ObservationError(f"{where} requires field '{field}'.")
    value = mapping[field]
    if not isinstance(value, bool):
        raise ObservationError(f"{where} field '{field}' must be a boolean.")
    return value


def _require_null_or_non_empty_string(mapping, field, where):
    if field not in mapping:
        raise ObservationError(f"{where} requires field '{field}'.")
    value = mapping[field]
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise ObservationError(
            f"{where} field '{field}' must be a non-empty string or null."
        )
    return value


def _check_round(value):
    where = "round"
    if not isinstance(value, dict):
        raise ObservationError("Observation v3 requires 'round' as an object.")
    _reject_extra(value, ("timer", "timer_red", "round_no"), "Observation v3 round")
    if "timer" not in value:
        raise ObservationError("Observation v3 round requires field 'timer'.")
    timer = value["timer"]
    if timer is not None and (
        not isinstance(timer, str) or not TIMER_RE.match(timer)
    ):
        raise ObservationError(
            "Observation v3 round field 'timer' must match MM:SS or be null."
        )
    _require_bool(value, "timer_red", "Observation v3 round")
    _require_int_or_null(value, "round_no", "Observation v3 round")


def _check_teams(value):
    if not isinstance(value, list):
        raise ObservationError(
            "Observation v3 requires field 'teams' as a list."
        )
    seen = set()
    for index, item in enumerate(value):
        where = f"teams[{index}]"
        if not isinstance(item, dict):
            raise ObservationError(f"Observation v3 {where} must be an object.")
        _reject_extra(
            item, ("id", "color", "score", "alive", "total"),
            f"Observation v3 {where}",
        )
        team_id = _require_non_empty_string(
            item, "id", f"Observation v3 {where}"
        )
        if team_id in seen:
            raise ObservationError(
                f"Observation v3 {where} duplicates team id '{team_id}'."
            )
        seen.add(team_id)
        _require_non_empty_string(item, "color", f"Observation v3 {where}")
        _require_int_or_null(item, "score", f"Observation v3 {where}")
        alive = _require_int_or_null(item, "alive", f"Observation v3 {where}")
        total = _require_int_or_null(item, "total", f"Observation v3 {where}")
        if alive is not None and total is not None and alive > total:
            raise ObservationError(
                f"Observation v3 {where} requires 'alive' <= 'total'."
            )


def _check_focus(value):
    if value is None:
        return
    if not isinstance(value, dict):
        raise ObservationError(
            "Observation v3 requires 'focus' as an object or null."
        )
    _reject_extra(
        value, ("name", "team", "weapon", "state", "hp_pct"),
        "Observation v3 focus",
    )
    _require_null_or_non_empty_string(value, "name", "Observation v3 focus")
    _require_null_or_non_empty_string(value, "team", "Observation v3 focus")
    _require_null_or_non_empty_string(value, "weapon", "Observation v3 focus")
    if value.get("state") not in OBSERVATION_V3_STATES:
        raise ObservationError(
            "Observation v3 focus has unsupported state "
            f"'{value.get('state')}'; expected one of: "
            f"{', '.join(OBSERVATION_V3_STATES)}."
        )
    hp_pct = _require_int_or_null(value, "hp_pct", "Observation v3 focus")
    if hp_pct is not None and not 0 <= hp_pct <= 100:
        raise ObservationError(
            "Observation v3 focus field 'hp_pct' must be within 0-100."
        )


def _check_in_view(value):
    if not isinstance(value, list):
        raise ObservationError(
            "Observation v3 requires field 'in_view' as a list."
        )
    for index, item in enumerate(value):
        where = f"in_view[{index}]"
        if not isinstance(item, dict):
            raise ObservationError(f"Observation v3 {where} must be an object.")
        _reject_extra(
            item, ("name", "team", "state"), f"Observation v3 {where}"
        )
        _require_null_or_non_empty_string(
            item, "name", f"Observation v3 {where}"
        )
        _require_null_or_non_empty_string(
            item, "team", f"Observation v3 {where}"
        )
        if item.get("state") not in OBSERVATION_V3_STATES:
            raise ObservationError(
                f"Observation v3 {where} has unsupported state "
                f"'{item.get('state')}'; expected one of: "
                f"{', '.join(OBSERVATION_V3_STATES)}."
            )


def _check_cues(value, allowed_cues):
    if not isinstance(value, list):
        raise ObservationError(
            "Observation v3 requires field 'cues' as a list."
        )
    for index, item in enumerate(value):
        where = f"cues[{index}]"
        if not isinstance(item, dict):
            raise ObservationError(f"Observation v3 {where} must be an object.")
        _reject_extra(item, ("cue", "evidence"), f"Observation v3 {where}")
        if item.get("cue") not in allowed_cues:
            raise ObservationError(
                f"Observation v3 {where} has unsupported cue "
                f"'{item.get('cue')}'; expected one of: "
                f"{', '.join(allowed_cues)}."
            )
        evidence = _require_non_empty_string(
            item, "evidence", f"Observation v3 {where}"
        )
        if len(evidence.split()) > EVIDENCE_MAX_WORDS:
            raise ObservationError(
                f"Observation v3 {where} field 'evidence' must be at most "
                f"{EVIDENCE_MAX_WORDS} words."
            )


def validate_observation_v3(data, allowed_cues=None):
    """Strictly validate an observation-v3 document; reject anything else.

    ``allowed_cues`` is the effective cue enum (pack-configurable);
    callers that pass nothing get the ``OBSERVATION_V3_CUES`` default.
    Raises ObservationError with a precise message on any violation;
    returns the document unchanged when valid.
    """
    if allowed_cues is None:
        allowed_cues = OBSERVATION_V3_CUES
    if not isinstance(data, dict):
        raise ObservationError("Observation v3 must be a JSON object.")
    _reject_extra(
        data,
        (
            "schema_version",
            "timestamp",
            "scene",
            "round",
            "teams",
            "focus",
            "in_view",
            "cues",
            "notes",
            "confidence",
        ),
        "Observation v3",
    )
    if data.get("schema_version") != OBSERVATION_SCHEMA_VERSION_V3:
        raise ObservationError(
            "Observation v3 requires schema_version "
            f"'{OBSERVATION_SCHEMA_VERSION_V3}'."
        )
    if "timestamp" not in data:
        raise ObservationError("Observation v3 requires field 'timestamp'.")
    timestamp = data["timestamp"]
    if (
        isinstance(timestamp, bool)
        or not isinstance(timestamp, (int, float))
        or (isinstance(timestamp, float) and not math.isfinite(timestamp))
    ):
        raise ObservationError("Observation v3 field 'timestamp' must be a number.")
    if data.get("scene") not in OBSERVATION_V3_SCENES:
        raise ObservationError(
            "Observation v3 has unsupported scene "
            f"'{data.get('scene')}'; expected one of: "
            f"{', '.join(OBSERVATION_V3_SCENES)}."
        )
    if "round" not in data:
        raise ObservationError("Observation v3 requires field 'round'.")
    _check_round(data["round"])
    if "teams" not in data:
        raise ObservationError("Observation v3 requires field 'teams'.")
    _check_teams(data["teams"])
    if "focus" not in data:
        raise ObservationError("Observation v3 requires field 'focus'.")
    _check_focus(data["focus"])
    if "in_view" not in data:
        raise ObservationError("Observation v3 requires field 'in_view'.")
    _check_in_view(data["in_view"])
    if "cues" not in data:
        raise ObservationError("Observation v3 requires field 'cues'.")
    _check_cues(data["cues"], tuple(allowed_cues))
    if "notes" not in data:
        raise ObservationError("Observation v3 requires field 'notes'.")
    notes = data["notes"]
    if notes is not None:
        if not isinstance(notes, str) or not notes.strip():
            raise ObservationError(
                "Observation v3 field 'notes' must be a non-empty string "
                "or null."
            )
        if len(notes) > NOTES_MAX_CHARS:
            raise ObservationError(
                "Observation v3 field 'notes' must be at most "
                f"{NOTES_MAX_CHARS} characters."
            )
    if data.get("confidence") not in OBSERVATION_V3_CONFIDENCES:
        raise ObservationError(
            "Observation v3 has unsupported confidence "
            f"'{data.get('confidence')}'; expected one of: "
            f"{', '.join(OBSERVATION_V3_CONFIDENCES)}."
        )
    return data
