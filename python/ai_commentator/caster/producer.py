"""Caster producer: gated claims to a chronological beat sheet.

:func:`produce_beats` is a pure deterministic function over validated
gameplay, match state, detected events, gated commentary claims, and
previously spoken history texts. It wraps meaningful developments only
— event echoes and development claims; static scene description stays
silent — with priority, delivery, pacing, and repeat suppression:

- **Chronological**: beats sort by (timestamp, priority, id).
- **Pacing cap**: at most one non-critical beat per 5-second window;
  critical beats always speak (they interrupt, and they do not open
  suppression windows of their own).
- **Silence**: no worthy claims means an empty list, never filler.
- **No-repeat**: a candidate whose normalized wording is contained in
  (or contains) a normalized history line is dropped.
- **Grounding**: every beat quotes claim evidence verbatim, names only
  participants quoted in that evidence, and lists what the evidence
  does not support in ``must_not_claim``.

No model calls: wording comes from fixed templates over validated
text, and tactical significance reuses the analyst's grounded reads.
"""

from __future__ import annotations

import re

from ..commentary.writer import claim_id_of
from ..config import COMMENTARY_QUALIFIERS, EVENT_NAME_RE
from ..errors import ObservationError
from ..state.gameplay import validate_gameplay
from .analyst import analyze_match
from .beats import beat_id_for, validate_beat


#: Pacing window in seconds: non-critical beats keep this gap.
BEAT_PACING_WINDOW_S = 5.0

#: Priority per wrapped claim kind. Critical is rare by design: only
#: multi-sighting scoring runs interrupt the sheet.
BEAT_PRIORITY_BY_RULE = {
    "elim_streak": "critical",
    "feed_cluster": "critical",
    "combat_engagement": "high",
    "knockdown_observed": "high",
    "elim_count_increased": "high",
    "kill_feed_entry": "high",
    "revive_observed": "normal",
    "blue_wall_use": "normal",
    "zone_pressure": "normal",
    "development": "normal",
}

BEAT_DELIVERY_BY_PRIORITY = {
    "critical": "energized",
    "high": "measured",
    "normal": "measured",
    "low": "calm",
}

_BEAT_PRIORITY_RANK = {"critical": 0, "high": 1, "normal": 2, "low": 3}

_SENTENCE_END_RE = re.compile(r"(.+?[.!?])(?:\s+[A-Z0-9\"'(]|$)", re.DOTALL)


def normalize_history_text(text: str) -> str:
    """Normalize wording for containment checks: lower, single spaces."""
    return re.sub(r"\s+", " ", text.strip().lower())


def _first_sentence(text: str) -> str:
    """Lead sentence of a verbatim quote (quotes are one line)."""
    cleaned = re.sub(r"\s+", " ", text.strip())
    match = _SENTENCE_END_RE.match(cleaned)
    if match:
        return match.group(1).strip()
    return cleaned


def _validate_claim(claim: dict, where: str) -> None:
    if not isinstance(claim, dict):
        raise ObservationError(f"{where} must be an object.")
    for field in ("type", "template", "timestamp", "evidence", "source_ids"):
        if field not in claim:
            raise ObservationError(f"{where} requires field '{field}'.")
    if claim["type"] not in ("scene", "development", "event_echo"):
        raise ObservationError(
            f"{where} has invalid type '{claim['type']}'."
        )
    if (
        not isinstance(claim["template"], str)
        or not claim["template"].strip()
    ):
        raise ObservationError(f"{where} requires a template name.")
    timestamp = claim["timestamp"]
    if isinstance(timestamp, bool) or not isinstance(timestamp, (int, float)):
        raise ObservationError(f"{where} field 'timestamp' must be a number.")
    for field in ("evidence", "source_ids"):
        values = claim[field]
        if (
            not isinstance(values, list)
            or not values
            or any(
                not isinstance(item, str) or not item.strip()
                for item in values
            )
        ):
            raise ObservationError(
                f"{where} requires '{field}' as a non-empty string list."
            )
    confidence = claim.get("confidence", "medium")
    if confidence not in ("high", "medium", "low"):
        raise ObservationError(
            f"{where} has invalid confidence '{confidence}'."
        )


def _beat_kind(claim: dict, events_by_id: dict) -> str:
    """Construction-time beat kind for identity and priority."""
    if claim["type"] == "development":
        return "development"
    rule = claim.get("rule")
    if isinstance(rule, str) and rule.strip():
        return rule.split("/")[0]
    event = events_by_id.get(claim.get("event_id"), {})
    rule = event.get("rule", "") if isinstance(event, dict) else ""
    if isinstance(rule, str) and rule.strip():
        return rule.split("/")[0]
    event_type = event.get("type", "") if isinstance(event, dict) else ""
    if isinstance(event_type, str) and event_type.strip():
        return event_type
    return "event_echo"


def _must_not_claim(kind: str, claim: dict) -> list:
    """Per-beat guards: what the evidence does not support."""
    qualifier = claim.get("qualification")
    if not isinstance(qualifier, str) or not qualifier.strip():
        qualifier = COMMENTARY_QUALIFIERS.get(kind, (
            "details beyond the quoted evidence are not established"
        ))
    guards = [qualifier]
    if kind in ("elim_streak", "elim_count_increased", "feed_cluster",
                "kill_feed_entry", "combat_engagement"):
        guards.append("the match outcome is not established")
    else:
        guards.append("cause and match outcome are not established")
    return guards


def _tactical_significance(analysis: dict, evidence: list) -> str | None:
    """Best analyst read sharing verbatim evidence, else null.

    Interpretations win over hypotheses; within a tier the
    analyst's text-sorted first match wins, so the pick is stable.
    """
    quoted = set(evidence)
    for tier in ("interpretations", "hypotheses"):
        for entry in analysis.get(tier, []):
            if quoted & set(entry.get("evidence", [])):
                return entry["text"]
    return None


def _repeated(what: str, history: list) -> bool:
    """Normalized containment either direction (empty lines never match)."""
    normalized = normalize_history_text(what)
    if not normalized:
        return False
    for line in history:
        other = normalize_history_text(line)
        if not other:
            continue
        if normalized in other or other in normalized:
            return True
    return False


def produce_beats(
    gameplay: dict,
    state: dict,
    events: dict,
    claims: list,
    history_texts: list,
) -> list:
    """Produce the chronological caster beat sheet for gated claims.

    Pure and deterministic: inputs validate first (gameplay strictly,
    claims for gate-output shape, history as strings), candidates wrap
    event-echo and development claims only, repeats drop before pacing,
    pacing keeps chronological order, and every emitted beat validates
    (including its content-bound id) before return.
    """
    validate_gameplay(gameplay)
    if not isinstance(state, dict):
        raise ObservationError("Producer requires state as a JSON object.")
    if not isinstance(events, dict):
        raise ObservationError("Producer requires events as a JSON object.")
    if not isinstance(claims, list):
        raise ObservationError("Producer requires claims as a list.")
    if not isinstance(history_texts, list) or any(
        not isinstance(line, str) for line in history_texts
    ):
        raise ObservationError(
            "Producer requires history_texts as a list of strings."
        )
    for index, claim in enumerate(claims):
        _validate_claim(claim, f"claims[{index}]")
    events_by_id = {
        event["id"]: event
        for event in events.get("events", [])
        if isinstance(event, dict) and isinstance(event.get("id"), str)
    }
    analysis = analyze_match(gameplay, state, events)
    candidates = []
    for claim in claims:
        if claim["type"] == "scene":
            continue
        kind = _beat_kind(claim, events_by_id)
        evidence = [str(quote) for quote in claim["evidence"]]
        what = _first_sentence(evidence[0])
        if _repeated(what, history_texts):
            continue
        priority = BEAT_PRIORITY_BY_RULE.get(kind, "normal")
        participants = sorted(
            {
                match.group(0)
                for quote in evidence
                for match in EVENT_NAME_RE.finditer(quote)
            }
        )
        claim_id = claim_id_of(claim)
        candidates.append(
            {
                "kind": kind,
                "timestamp": claim["timestamp"],
                "priority": priority,
                "what": what,
                "participants": participants,
                "evidence": evidence,
                "significance": _tactical_significance(analysis, evidence),
                "confidence": claim.get("confidence", "medium"),
                "guards": _must_not_claim(kind, claim),
                "claim_id": claim_id,
            }
        )
    candidates.sort(
        key=lambda item: (
            item["timestamp"],
            _BEAT_PRIORITY_RANK[item["priority"]],
            item["claim_id"],
        )
    )
    kept = []
    last_spoken = None
    for candidate in candidates:
        if (
            candidate["priority"] != "critical"
            and last_spoken is not None
            and candidate["timestamp"] - last_spoken < BEAT_PACING_WINDOW_S
        ):
            continue
        kept.append(candidate)
        if candidate["priority"] != "critical":
            last_spoken = candidate["timestamp"]
    beats = []
    for candidate in kept:
        beat_id = beat_id_for(
            candidate["kind"],
            candidate["timestamp"],
            candidate["evidence"],
            [candidate["claim_id"]],
        )
        beats.append((candidate, beat_id))
    sheets = []
    for index, (candidate, beat_id) in enumerate(beats):
        prior_ids = [earlier for _, earlier in beats[:index]]
        shared: set = set()
        for earlier_candidate, earlier_id in beats[:index]:
            if set(candidate["participants"]) & set(
                earlier_candidate["participants"]
            ):
                shared.add(earlier_id)
            if candidate["claim_id"] == earlier_candidate["claim_id"]:
                shared.add(earlier_id)
        related = [ref for ref in prior_ids if ref in shared]
        beat = {
            "beat_id": beat_id,
            "timestamp": candidate["timestamp"],
            "window_end": candidate["timestamp"] + BEAT_PACING_WINDOW_S,
            "what": candidate["what"],
            "participants": candidate["participants"],
            "evidence": candidate["evidence"],
            "tactical_significance": candidate["significance"],
            "related_to": related,
            "confidence": candidate["confidence"],
            "priority": candidate["priority"],
            "delivery": BEAT_DELIVERY_BY_PRIORITY[candidate["priority"]],
            "must_not_claim": candidate["guards"],
            "source_claim_ids": [candidate["claim_id"]],
        }
        sheets.append(validate_beat(beat, beat_type=candidate["kind"]))
    return sheets
