"""Caster beat schema: validation and deterministic identity.

A beat is the producer's unit of commentary: one newsworthy development
wrapping one or more gated claims. Beats carry exactly the contract
keys; anything else is rejected, never guessed.

The beat id binds the beat's construction-time kind (an event rule base
such as ``combat_engagement`` or ``development``), its window-start
timestamp, its verbatim evidence, and its wrapped claim ids. The kind
is an input to the id hash only — it is not stored on the beat, which
keeps exactly the contract keys — so full identity verification needs
the kind passed alongside (the producer does this at construction).
"""

from __future__ import annotations

import hashlib
import json
import math
import re

from ..errors import ObservationError
from ..vision.observations import _reject_extra, _require_non_empty_string


#: Exact beat keys. Order is documentation only; validation is set-based.
BEAT_KEYS = (
    "beat_id",
    "timestamp",
    "window_end",
    "what",
    "participants",
    "evidence",
    "tactical_significance",
    "related_to",
    "confidence",
    "priority",
    "delivery",
    "must_not_claim",
    "source_claim_ids",
)

BEAT_CONFIDENCES = ("high", "medium", "low")
BEAT_PRIORITIES = ("critical", "high", "normal", "low")
BEAT_DELIVERIES = ("calm", "measured", "energized")

BEAT_ID_RE = re.compile(r"^beat-[0-9a-f]{12}$")
CLAIM_ID_RE = re.compile(r"^clm-[0-9a-f]{12}$")


def beat_id_for(beat_type: str, timestamp, evidence: list, source_ids: list) -> str:
    """Deterministic beat id over kind, timestamp, evidence, and claims.

    ``beat_type`` is the construction-time kind (an event rule base or
    ``development``); ``evidence`` keeps order (first quote is the lead);
    claim ids sort so wrapping order never changes the id. The same
    inputs always yield the same ``beat-`` + 12 hex id.
    """
    canonical = json.dumps(
        {
            "type": beat_type,
            "timestamp": timestamp,
            "evidence": list(evidence),
            "sources": sorted(source_ids),
        },
        sort_keys=True,
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return "beat-" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:12]


def _require_number(data: dict, field: str, where: str):
    value = data.get(field)
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or (isinstance(value, float) and not math.isfinite(value))
    ):
        raise ObservationError(f"{where} field '{field}' must be a number.")
    return value


def _require_string_list(data: dict, field: str, where: str, *, allow_empty: bool):
    values = data.get(field)
    if not isinstance(values, list) or any(
        not isinstance(item, str) or not item.strip() for item in values
    ):
        raise ObservationError(
            f"{where} requires '{field}' as a list of non-empty strings."
        )
    if not allow_empty and not values:
        raise ObservationError(
            f"{where} requires '{field}' as a non-empty list of strings."
        )
    return values


def validate_beat(beat: dict, beat_type: str | None = None) -> dict:
    """Strictly validate one caster beat; reject anything else.

    Shape, enums, id formats, and the window bound (``window_end`` at or
    after ``timestamp``) are always checked. When ``beat_type`` is
    supplied, the stored ``beat_id`` must equal the recomputed
    :func:`beat_id_for` value — a beat is never stronger than its
    construction inputs.
    """
    where = "Beat"
    if not isinstance(beat, dict):
        raise ObservationError("Beat must be a JSON object.")
    _reject_extra(beat, BEAT_KEYS, where)
    for field in BEAT_KEYS:
        if field not in beat:
            raise ObservationError(f"{where} requires field '{field}'.")
    beat_id = beat.get("beat_id")
    if not isinstance(beat_id, str) or not BEAT_ID_RE.match(beat_id):
        raise ObservationError(
            f"{where} field 'beat_id' must match 'beat-' + 12 hex chars."
        )
    timestamp = _require_number(beat, "timestamp", where)
    window_end = _require_number(beat, "window_end", where)
    if window_end < timestamp:
        raise ObservationError(
            f"{where} field 'window_end' must not precede 'timestamp'."
        )
    what = beat.get("what")
    if not isinstance(what, str) or not what.strip() or "\n" in what:
        raise ObservationError(
            f"{where} field 'what' must be a non-empty single-line sentence."
        )
    _require_string_list(beat, "participants", where, allow_empty=True)
    evidence = _require_string_list(beat, "evidence", where, allow_empty=False)
    significance = beat.get("tactical_significance")
    if significance is not None and (
        not isinstance(significance, str) or not significance.strip()
    ):
        raise ObservationError(
            f"{where} field 'tactical_significance' must be a non-empty "
            f"string or null."
        )
    related = _require_string_list(beat, "related_to", where, allow_empty=True)
    for ref in related:
        if not BEAT_ID_RE.match(ref):
            raise ObservationError(
                f"{where} field 'related_to' must hold beat ids "
                f"('beat-' + 12 hex chars)."
            )
    if beat.get("confidence") not in BEAT_CONFIDENCES:
        raise ObservationError(
            f"{where} has invalid confidence '{beat.get('confidence')}'."
        )
    if beat.get("priority") not in BEAT_PRIORITIES:
        raise ObservationError(
            f"{where} has invalid priority '{beat.get('priority')}'."
        )
    if beat.get("delivery") not in BEAT_DELIVERIES:
        raise ObservationError(
            f"{where} has invalid delivery '{beat.get('delivery')}'."
        )
    _require_non_empty_string(beat, "what", where)
    _require_string_list(beat, "must_not_claim", where, allow_empty=True)
    claim_ids = _require_string_list(
        beat, "source_claim_ids", where, allow_empty=False
    )
    for claim_id in claim_ids:
        if not CLAIM_ID_RE.match(claim_id):
            raise ObservationError(
                f"{where} field 'source_claim_ids' must hold gated claim ids "
                f"('clm-' + 12 hex chars)."
            )
    if beat_type is not None:
        expected = beat_id_for(beat_type, timestamp, evidence, claim_ids)
        if beat_id != expected:
            raise ObservationError(
                f"{where} id '{beat_id}' does not match its content "
                f"(expected '{expected}')."
            )
    return beat
