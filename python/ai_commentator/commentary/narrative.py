"""Bounded match narrative: verified situation context for wording stages.

The narrative connects developments across time: current situation,
active engagements, recent developments, unresolved uncertainty, and
what was already said. It is derived deterministically from validated
inputs (gameplay interpretation, match state, events, spoken history)
and rendered as bounded prompt context. It is context, not evidence:
wording stages may use it to connect claims, but the script validator
still grounds every line in its cited claims only.

Every bullet preserves uncertainty (candidate phrasing travels with the
developments it came from), every list is capped, and the rendered
block is character-bounded, so history can never grow unbounded in the
prompt.
"""

from __future__ import annotations

from ..config import (
    NARRATIVE_MAX_BULLET_CHARS,
    NARRATIVE_MAX_CHARS,
    NARRATIVE_MAX_DEVELOPMENTS,
    NARRATIVE_MAX_ENGAGEMENTS,
    NARRATIVE_MAX_HISTORY,
    NARRATIVE_MAX_MOVED,
    NARRATIVE_MAX_UNCERTAINTIES,
)


def _truncate(text: str, limit: int) -> str:
    """Bound one bullet; non-strings become empty."""
    if not isinstance(text, str):
        return ""
    cleaned = " ".join(text.split())
    if len(cleaned) <= limit:
        return cleaned
    return cleaned[:limit] + "…(truncated)"


def build_narrative(
    gameplay: dict,
    state: dict,
    events: dict,
    history_texts: list,
) -> dict:
    """Build the bounded narrative dict from validated inputs.

    ``gameplay`` is a ``gameplay-v1`` document, ``state`` a
    ``match-state-v1`` snapshot, ``events`` an ``events-v1`` document,
    and ``history_texts`` already-spoken lines (most recent last). All
    inputs are read defensively with ``.get`` so hand-built fixtures
    stay total; production callers pass validated documents. The result
    has exactly ``situation``, ``active_engagements``,
    ``recent_developments``, ``uncertainties``, and ``spoken`` lists of
    short grounded strings. Deterministic: same inputs, same bullets.
    """
    gameplay = gameplay if isinstance(gameplay, dict) else {}
    state = state if isinstance(state, dict) else {}
    events = events if isinstance(events, dict) else {}
    history = [text for text in (history_texts or []) if isinstance(text, str)]

    situation: list[str] = []
    summary = gameplay.get("summary") or {}
    if summary.get("combat_active"):
        situation.append("Combat is active in the latest observations.")
    else:
        situation.append("No combat in the latest observations.")
    entity_count = summary.get("entity_count", 0)
    if entity_count:
        situation.append(f"Tracking {entity_count} labeled entities.")
    moved = [
        track
        for track in gameplay.get("entities", [])
        if isinstance(track, dict) and track.get("movement") is not None
    ]
    moved.sort(key=lambda track: (track.get("last_seen", 0), track.get("ref", "")))
    for track in moved[-NARRATIVE_MAX_MOVED:]:
        movement = track["movement"] or {}
        situation.append(
            f"{track.get('ref')} repositioned from "
            f"{movement.get('from')} to {movement.get('to')}."
        )
    reappeared = sorted(summary.get("reappeared_entities", []) or [])
    for ref in reappeared[:NARRATIVE_MAX_MOVED]:
        situation.append(f"{ref} reappeared after a gap in visibility.")
    occluded = summary.get("occluded_entities", []) or []
    if occluded:
        situation.append(
            f"{len(occluded)} tracked "
            f"{'entity' if len(occluded) == 1 else 'entities'} "
            f"out of view."
        )

    engagements = [
        event
        for event in events.get("events", [])
        if isinstance(event, dict) and event.get("type") == "combat_engagement"
    ]
    engagements.sort(
        key=lambda event: (event.get("timestamp", 0), event.get("id", ""))
    )
    active_engagements = []
    for event in engagements[-NARRATIVE_MAX_ENGAGEMENTS:]:
        stamps = sorted(
            source.get("timestamp", 0) for source in event.get("sources", [])
        )
        span = (
            f"{stamps[0]}s–{stamps[-1]}s" if len(stamps) >= 2 else f"{event.get('timestamp')}s"
        )
        active_engagements.append(
            f"Engagement observed {span} across {len(stamps)} "
            f"sightings (participants unconfirmed)."
        )

    ordered_events = sorted(
        [event for event in events.get("events", []) if isinstance(event, dict)],
        key=lambda event: (event.get("timestamp", 0), event.get("id", "")),
    )
    recent_developments = []
    for event in ordered_events[-NARRATIVE_MAX_DEVELOPMENTS:]:
        recent_developments.append(
            _truncate(
                f"{event.get('rule')} at {event.get('timestamp')}s: "
                f"{event.get('detail')}",
                NARRATIVE_MAX_BULLET_CHARS,
            )
        )

    uncertainties = []
    for entry in (state.get("uncertainties", []) or [])[:NARRATIVE_MAX_UNCERTAINTIES]:
        if isinstance(entry, dict) and entry.get("text"):
            uncertainties.append(
                _truncate(entry["text"], NARRATIVE_MAX_BULLET_CHARS)
            )

    spoken = [
        _truncate(text, NARRATIVE_MAX_BULLET_CHARS)
        for text in history[-NARRATIVE_MAX_HISTORY:]
        if text.strip()
    ]

    return {
        "situation": situation,
        "active_engagements": active_engagements,
        "recent_developments": recent_developments,
        "uncertainties": uncertainties,
        "spoken": spoken,
    }


def render_narrative_block(narrative: dict) -> str:
    """Render one bounded prompt-context string from a narrative dict.

    Returns ``""`` when there is nothing beyond the default situation
    line to say. Otherwise joins labeled sections with " | " and caps
    the whole block at ``NARRATIVE_MAX_CHARS``.
    """
    if not isinstance(narrative, dict):
        return ""
    sections = []
    situation = [line for line in narrative.get("situation", []) if line]
    if situation:
        sections.append("Situation: " + " ".join(situation))
    engagements = [line for line in narrative.get("active_engagements", []) if line]
    if engagements:
        sections.append("Active engagements: " + " ".join(engagements))
    developments = [
        line for line in narrative.get("recent_developments", []) if line
    ]
    if developments:
        sections.append("Recent developments: " + " ".join(developments))
    uncertainties = [line for line in narrative.get("uncertainties", []) if line]
    if uncertainties:
        sections.append("Unresolved: " + " ".join(uncertainties))
    spoken = [line for line in narrative.get("spoken", []) if line]
    if spoken:
        sections.append("Already said: " + " ".join(spoken))
    if not sections:
        return ""
    block = " | ".join(sections)
    if len(block) > NARRATIVE_MAX_CHARS:
        block = block[:NARRATIVE_MAX_CHARS] + "…(truncated)"
    return block
