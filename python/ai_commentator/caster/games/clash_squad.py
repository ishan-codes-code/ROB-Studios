"""Clash Squad match knowledge (Free Fire round play).

Deterministic reads over validated wording only: round progression
from ``round_state``-tagged facts, Blue Wall cover usage, revive
wording, and survival tracking from elim/counter evidence. Every entry
quotes its evidence; round scores, winners, and causes are unknown
unless quoted verbatim. Hypotheses are always hedged (may/might/could)
and never phrased as fact.
"""

from __future__ import annotations

import re


GAME_ID = "clash_squad"

_MATCH_POINT_RE = re.compile(r"match[-\s]?point|matchpoint", re.IGNORECASE)
_SCORE_RE = re.compile(r"\b\d+\s*[-:]\s*\d+\b")


def _tagged_facts(gameplay: dict, tag: str) -> list:
    """Fact-signal items carrying ``tag``, in sorted description order."""
    return sorted(
        (
            item
            for item in gameplay.get("fact_signals", [])
            if isinstance(item, dict) and tag in item.get("observed", [])
        ),
        key=lambda item: (item.get("category", ""), item.get("description", "")),
    )


def _confidence_for(gameplay: dict, descriptions: list) -> str:
    """Weakest track confidence behind descriptions, defaulting to medium.

    Gameplay tracks carry weakest-link tracking confidence; facts quoted
    here inherit the weakest track that cites the same wording. Facts
    with no citing track keep ``medium`` — quoted but unattributed.
    """
    rank = {"high": 0, "medium": 1, "low": 2}
    wanted = {description.strip() for description in descriptions if description}
    weakest = "medium"
    for track in gameplay.get("entities", []):
        if not isinstance(track, dict):
            continue
        confidence = track.get("tracking_confidence", "medium")
        for sighting in track.get("sightings", []):
            if not isinstance(sighting, dict):
                continue
            key = sighting.get("fact_key", [])
            quoted = str(key[1]).strip() if len(key) == 2 else ""
            if quoted and quoted in wanted:
                if rank.get(confidence, 1) > rank[weakest]:
                    weakest = confidence
                break
    return weakest


def _round_progression(gameplay: dict) -> dict:
    """Round markers: observed quotes, no invented scores or winners."""
    observed, interpretations, hypotheses, unknown = [], [], [], []
    rounds = _tagged_facts(gameplay, "round_state")
    for item in rounds:
        description = item["description"]
        observed.append(
            {
                "text": f"Round marker observed: '{description}'",
                "evidence": [description],
                "confidence": _confidence_for(gameplay, [description]),
            }
        )
    if len(rounds) >= 2:
        observed_texts = sorted(item["description"] for item in rounds)
        interpretations.append(
            {
                "text": "The match follows a round structure; quoted "
                "markers reference rounds or round outcomes.",
                "evidence": observed_texts[:2],
                "confidence": "medium",
            }
        )
    for item in rounds:
        if _MATCH_POINT_RE.search(item["description"]):
            hypotheses.append(
                {
                    "text": "The match may be at match point; the next "
                    "round could decide it.",
                    "evidence": [item["description"]],
                    "confidence": "low",
                }
            )
            break
    if rounds and not any(
        _SCORE_RE.search(item["description"]) for item in rounds
    ):
        unknown.append(
            {
                "text": "The current round score is unknown; no quoted "
                "scoreline establishes it.",
                "evidence": [rounds[0]["description"]],
                "confidence": "low",
            }
        )
    return {
        "observed_facts": observed,
        "interpretations": interpretations,
        "hypotheses": hypotheses,
        "unknown": unknown,
    }


def _cover_read(gameplay: dict) -> dict:
    """Blue Wall cover: observed placement, hedged posture reads."""
    observed, interpretations, hypotheses = [], [], []
    walls = _tagged_facts(gameplay, "blue_wall")
    for item in walls:
        description = item["description"]
        observed.append(
            {
                "text": f"Blue Wall cover observed: '{description}'",
                "evidence": [description],
                "confidence": _confidence_for(gameplay, [description]),
            }
        )
    crouched = [
        track
        for track in gameplay.get("entities", [])
        if isinstance(track, dict)
        and track.get("posture") in ("crouched", "crouching", "prone")
        and any(
            "blue_wall" in sighting.get("observed", [])
            for sighting in track.get("sightings", [])
            if isinstance(sighting, dict)
        )
    ]
    for track in sorted(crouched, key=lambda item: item["ref"]):
        quote = track["last_known_position"] or track["ref"]
        interpretations.append(
            {
                "text": f"{track['ref']} appears to be holding behind "
                f"cover in a low posture.",
                "evidence": [quote],
                "confidence": "medium",
            }
        )
    if walls and not crouched:
        hypotheses.append(
            {
                "text": "A player may be staging behind the observed "
                "Blue Wall cover.",
                "evidence": [walls[0]["description"]],
                "confidence": "low",
            }
        )
    return {
        "observed_facts": observed,
        "interpretations": interpretations,
        "hypotheses": hypotheses,
        "unknown": [],
    }


def _revive_read(gameplay: dict, events: dict) -> dict:
    """Revives: quoted wording only; reappearance is never a revive."""
    observed, interpretations, hypotheses, unknown = [], [], [], []
    revives = _tagged_facts(gameplay, "revive")
    for item in revives:
        description = item["description"]
        observed.append(
            {
                "text": f"Revive wording observed: '{description}'",
                "evidence": [description],
                "confidence": _confidence_for(gameplay, [description]),
            }
        )
    knockdowns = _tagged_facts(gameplay, "knockdown")
    if revives and knockdowns:
        interpretations.append(
            {
                "text": "Knockdown and revive wording were both observed; "
                "a down player may have been picked back up.",
                "evidence": [
                    knockdowns[0]["description"],
                    revives[0]["description"],
                ],
                "confidence": "medium",
            }
        )
    reappeared = sorted(
        track["ref"]
        for track in gameplay.get("entities", [])
        if isinstance(track, dict)
        and track.get("status") == "reappeared"
        and track.get("identity") == "exact-label"
    )
    if reappeared and not revives:
        unknown.append(
            {
                "text": f"{', '.join(reappeared)} reappeared without "
                f"revive wording; whether a revive happened is unknown.",
                "evidence": [],
                "confidence": "low",
            }
        )
    _ = events
    return {
        "observed_facts": observed,
        "interpretations": interpretations,
        "hypotheses": hypotheses,
        "unknown": unknown,
    }


def _survival_read(gameplay: dict, events: dict) -> dict:
    """Survival tracking: quoted counters and streaks, hedged momentum."""
    observed, interpretations, hypotheses, unknown = [], [], [], []
    phases = _tagged_facts(gameplay, "match_phase")
    for item in phases:
        description = item["description"]
        observed.append(
            {
                "text": f"Match-phase marker observed: '{description}'",
                "evidence": [description],
                "confidence": _confidence_for(gameplay, [description]),
            }
        )
    streaks = sorted(
        (
            event
            for event in events.get("events", [])
            if isinstance(event, dict)
            and event.get("type") in ("elim_streak", "elim_count_increased")
        ),
        key=lambda event: (event.get("timestamp", 0), event.get("id", "")),
    )
    for event in streaks:
        evidence = [str(quote) for quote in event.get("evidence", [])]
        observed.append(
            {
                "text": f"Elimination counter evidence observed at "
                f"{event.get('timestamp')}s.",
                "evidence": evidence,
                "confidence": event.get("confidence", "medium"),
            }
        )
        detail = str(event.get("detail", ""))
        scope = "a team"
        if "Team " in detail:
            scope = "Team " + detail.split("Team ", 1)[1].split()[0]
        interpretations.append(
            {
                "text": f"{scope} is building elimination momentum.",
                "evidence": evidence[:1],
                "confidence": "medium",
            }
        )
        hypotheses.append(
            {
                "text": f"{scope} may press the advantage while momentum "
                f"holds.",
                "evidence": evidence[:1],
                "confidence": "low",
            }
        )
    if streaks:
        unknown.append(
            {
                "text": "Who was eliminated, by whom, and by what means "
                "are unknown; counters quote totals, not kills.",
                "evidence": [],
                "confidence": "low",
            }
        )
    return {
        "observed_facts": observed,
        "interpretations": interpretations,
        "hypotheses": hypotheses,
        "unknown": unknown,
    }


def analyze(gameplay: dict, state: dict, events: dict) -> dict:
    """Clash Squad read over validated gameplay, state, and events.

    Pure and deterministic: fact lists sort before reading, so the same
    inputs always yield the same entries. ``state`` is accepted for the
    shared game-module signature; this module reads gameplay and events.
    """
    _ = state
    merged = {
        "observed_facts": [],
        "interpretations": [],
        "hypotheses": [],
        "unknown": [],
    }
    for part in (
        _round_progression(gameplay),
        _cover_read(gameplay),
        _revive_read(gameplay, events),
        _survival_read(gameplay, events),
    ):
        for key in merged:
            merged[key].extend(part[key])
    return merged
