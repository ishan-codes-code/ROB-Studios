"""Gameplay intelligence analyst: facts, reads, hypotheses, unknowns.

:func:`analyze_match` is a pure deterministic function over validated
gameplay (``gameplay-v1``), match state, and detected events. It covers
rotations, positioning, cover usage, pressure, and momentum — each only
when the evidence supports it:

- ``observed_facts``: directly quoted developments (movement with
  differing positions, quoted cover/zone/counter evidence).
- ``interpretations``: grounded reads phrased with suggests/appears
  language and their supporting quotes.
- ``hypotheses``: explicitly hedged possibilities (may/might/could) —
  never phrased as fact.
- ``unknown``: identities, outcomes, and causes the evidence does not
  establish.

No model calls: every entry derives from validated text via fixed
rules. Game-specific knowledge (Clash Squad rounds, revives, survival)
comes from :mod:`caster.games`; structural reads run for every game.
"""

from __future__ import annotations

from ..errors import ObservationError
from ..state.gameplay import validate_gameplay
from . import games


ANALYST_KEYS = ("observed_facts", "interpretations", "hypotheses", "unknown")

#: Uncertainty markers every hypothesis must carry (checked by tests and
#: by construction: hypotheses are only built from these templates).
HYPOTHESIS_MARKERS = ("may", "might", "could", "possibly", "perhaps")

_LOW_POSTURES = ("crouched", "crouching", "prone", "kneeling")
_PRESSURE_EVENTS = ("zone_pressure", "combat_engagement")
_MOMENTUM_EVENTS = ("elim_streak", "elim_count_increased", "feed_cluster")


def _entry(text: str, evidence: list, confidence: str) -> dict:
    return {
        "text": text,
        "evidence": list(evidence),
        "confidence": confidence,
    }


def _labeled_tracks(gameplay: dict) -> list:
    """Exact-label entity tracks in deterministic order."""
    return sorted(
        (
            track
            for track in gameplay.get("entities", [])
            if isinstance(track, dict)
            and track.get("identity") == "exact-label"
        ),
        key=lambda track: (track.get("first_seen", 0), track.get("ref", "")),
    )


def _track_confidence(track: dict) -> str:
    confidence = track.get("tracking_confidence", "medium")
    if confidence not in ("high", "medium", "low"):
        return "medium"
    return confidence


def _rotation_read(gameplay: dict) -> dict:
    """Rotations from confirmed track movement; cues stay hypotheses."""
    observed, interpretations, hypotheses, unknown = [], [], [], []
    for track in _labeled_tracks(gameplay):
        ref = track["ref"]
        movement = track.get("movement")
        if isinstance(movement, dict):
            observed.append(
                _entry(
                    f"{ref} repositioned from '{movement['from']}' to "
                    f"'{movement['to']}'.",
                    [movement["from"], movement["to"]],
                    _track_confidence(track),
                )
            )
            interpretations.append(
                _entry(
                    f"{ref} appears to be rotating; differing quoted "
                    f"positions across sightings suggest deliberate "
                    f"repositioning.",
                    [movement["from"], movement["to"]],
                    "medium",
                )
            )
            continue
        cues = [
            sighting
            for sighting in track.get("sightings", [])
            if isinstance(sighting, dict)
            and "movement" in sighting.get("observed", [])
        ]
        if cues:
            quote = cues[0].get("spatial") or cues[0].get("action") or ref
            hypotheses.append(
                _entry(
                    f"{ref} may be rotating; a single movement cue "
                    f"without a confirmed position change could be "
                    f"repositioning or camera motion.",
                    [quote],
                    "low",
                )
            )
            unknown.append(
                _entry(
                    f"Whether {ref} changed position is unknown; only "
                    f"one quoted position supports movement.",
                    [quote],
                    "low",
                )
            )
    return {
        "observed_facts": observed,
        "interpretations": interpretations,
        "hypotheses": hypotheses,
        "unknown": unknown,
    }


def _positioning_read(gameplay: dict) -> dict:
    """Positioning from last-known positions and postures."""
    observed, interpretations = [], []
    for track in _labeled_tracks(gameplay):
        ref = track["ref"]
        position = track.get("last_known_position")
        if isinstance(position, str) and position:
            observed.append(
                _entry(
                    f"{ref} last observed at '{position}'.",
                    [position],
                    _track_confidence(track),
                )
            )
        posture = track.get("posture")
        if isinstance(posture, str) and posture:
            observed.append(
                _entry(
                    f"{ref} observed in posture '{posture}'.",
                    [posture],
                    _track_confidence(track),
                )
            )
        if (
            isinstance(position, str)
            and position
            and posture in _LOW_POSTURES
        ):
            interpretations.append(
                _entry(
                    f"{ref} appears to be holding position at "
                    f"'{position}' in a low posture.",
                    [position, posture],
                    "medium",
                )
            )
    return {
        "observed_facts": observed,
        "interpretations": interpretations,
        "hypotheses": [],
        "unknown": [],
    }


def _sighting_quotes(track: dict, tag: str) -> list:
    """Verbatim spatial/action quotes from sightings carrying ``tag``."""
    quotes = []
    for sighting in track.get("sightings", []):
        if not isinstance(sighting, dict):
            continue
        if tag not in sighting.get("observed", []):
            continue
        for field in ("spatial", "action"):
            quote = sighting.get(field)
            if quote and quote not in quotes:
                quotes.append(quote)
    return quotes


def _cover_read(gameplay: dict) -> dict:
    """Cover usage from quoted Blue Wall wording on entity tracks."""
    observed, interpretations, hypotheses = [], [], []
    for track in _labeled_tracks(gameplay):
        quotes = _sighting_quotes(track, "blue_wall")
        if not quotes:
            continue
        ref = track["ref"]
        observed.append(
            _entry(
                f"Blue Wall cover observed with {ref}: '{quotes[0]}'.",
                quotes[:1],
                _track_confidence(track),
            )
        )
        if track.get("posture") in _LOW_POSTURES:
            interpretations.append(
                _entry(
                    f"{ref} appears to be using Blue Wall cover while "
                    f"holding a low posture.",
                    quotes[:1],
                    "medium",
                )
            )
        else:
            hypotheses.append(
                _entry(
                    f"{ref} may be staging behind the observed Blue "
                    f"Wall cover.",
                    quotes[:1],
                    "low",
                )
            )
    return {
        "observed_facts": observed,
        "interpretations": interpretations,
        "hypotheses": hypotheses,
        "unknown": [],
    }


def _pressure_read(gameplay: dict, events: dict) -> dict:
    """Pressure from zone/combat evidence, never invented."""
    observed, interpretations, hypotheses, unknown = [], [], [], []
    zone_events = sorted(
        (
            event
            for event in events.get("events", [])
            if isinstance(event, dict) and event.get("type") in _PRESSURE_EVENTS
        ),
        key=lambda event: (event.get("timestamp", 0), event.get("id", "")),
    )
    for event in zone_events:
        evidence = [str(quote) for quote in event.get("evidence", [])]
        observed.append(
            _entry(
                f"Pressure evidence ({event['type']}) observed at "
                f"{event.get('timestamp')}s.",
                evidence,
                event.get("confidence", "medium"),
            )
        )
    zone_entities = sorted(
        {
            track["ref"]
            for track in _labeled_tracks(gameplay)
            if _sighting_quotes(track, "zone")
        }
    )
    if zone_events and zone_entities:
        evidence = [str(quote) for quote in zone_events[0].get("evidence", [])]
        interpretations.append(
            _entry(
                f"Pressure appears to be building on "
                f"{', '.join(zone_entities)}; zone wording coincides "
                f"with their quoted positions.",
                evidence[:1],
                "medium",
            )
        )
    elif zone_events:
        evidence = [str(quote) for quote in zone_events[0].get("evidence", [])]
        hypotheses.append(
            _entry(
                "The zone may force movement; no quoted entity "
                "position coincides with the zone wording yet.",
                evidence[:1],
                "low",
            )
        )
        unknown.append(
            _entry(
                "Who is affected by the zone development is unknown.",
                evidence[:1],
                "low",
            )
        )
    return {
        "observed_facts": observed,
        "interpretations": interpretations,
        "hypotheses": hypotheses,
        "unknown": unknown,
    }


def _momentum_read(events: dict) -> dict:
    """Momentum from quoted counter/feed evidence, hedged beyond that."""
    observed, interpretations, hypotheses, unknown = [], [], [], []
    scored = sorted(
        (
            event
            for event in events.get("events", [])
            if isinstance(event, dict) and event.get("type") in _MOMENTUM_EVENTS
        ),
        key=lambda event: (event.get("timestamp", 0), event.get("id", "")),
    )
    for event in scored:
        evidence = [str(quote) for quote in event.get("evidence", [])]
        observed.append(
            _entry(
                f"Scoring evidence ({event['type']}) observed at "
                f"{event.get('timestamp')}s.",
                evidence,
                event.get("confidence", "medium"),
            )
        )
    if scored:
        lead = [str(quote) for quote in scored[0].get("evidence", [])][:1]
        interpretations.append(
            _entry(
                "One side appears to hold elimination momentum; "
                "quoted counters or feed entries favor them.",
                lead,
                "medium",
            )
        )
        hypotheses.append(
            _entry(
                "The leading side may press the advantage while "
                "momentum holds.",
                lead,
                "low",
            )
        )
        unknown.append(
            _entry(
                "Whether the momentum decides the match is unknown; "
                "no quoted outcome establishes it.",
                lead,
                "low",
            )
        )
    return {
        "observed_facts": observed,
        "interpretations": interpretations,
        "hypotheses": hypotheses,
        "unknown": unknown,
    }


def _validate_entry(entry: dict, where: str) -> None:
    if not isinstance(entry, dict):
        raise ObservationError(f"{where} must be an object.")
    if set(entry) != {"text", "evidence", "confidence"}:
        raise ObservationError(
            f"{where} requires exactly text/evidence/confidence."
        )
    if (
        not isinstance(entry["text"], str)
        or not entry["text"].strip()
        or "\n" in entry["text"]
    ):
        raise ObservationError(f"{where} field 'text' must be one line.")
    if not isinstance(entry["evidence"], list) or any(
        not isinstance(quote, str) or not quote.strip()
        for quote in entry["evidence"]
    ):
        raise ObservationError(
            f"{where} requires 'evidence' as a list of non-empty strings."
        )
    if entry["confidence"] not in ("high", "medium", "low"):
        raise ObservationError(
            f"{where} has invalid confidence '{entry['confidence']}'."
        )


def analyze_match(gameplay: dict, state: dict, events: dict) -> dict:
    """Analyze validated gameplay, state, and events into four readings.

    Pure and deterministic: gameplay is strictly validated, state and
    events are read defensively (missing keys yield fewer entries, never
    guesses), every list sorts by text before return, and game-specific
    knowledge merges from :mod:`caster.games` with a generic fallback.
    """
    validate_gameplay(gameplay)
    if not isinstance(state, dict):
        raise ObservationError("Analyst requires state as a JSON object.")
    if not isinstance(events, dict):
        raise ObservationError("Analyst requires events as a JSON object.")
    merged = {key: [] for key in ANALYST_KEYS}
    game_module = games.select_game(gameplay, state)
    for part in (
        _rotation_read(gameplay),
        _positioning_read(gameplay),
        _cover_read(gameplay),
        _pressure_read(gameplay, events),
        _momentum_read(events),
        game_module.analyze(gameplay, state, events),
    ):
        if not isinstance(part, dict):
            raise ObservationError("Analyst part must be a JSON object.")
        for key in ANALYST_KEYS:
            entries = part.get(key, [])
            if not isinstance(entries, list):
                raise ObservationError(f"Analyst part key '{key}' must be a list.")
            merged[key].extend(entries)
    for key in ANALYST_KEYS:
        for index, entry in enumerate(merged[key]):
            _validate_entry(entry, f"{key}[{index}]")
        merged[key].sort(key=lambda entry: entry["text"])
    return merged
