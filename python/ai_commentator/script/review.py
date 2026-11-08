"""Caster-quality review: the editorial pass over factual-valid lines.

The factual validator (:func:`script.generation.script_text_valid`)
decides what is TRUE; this module decides what is GOOD broadcast
speech. :func:`review_caster_quality` flags professional defects —
screenshot narration, repetition, generic filler, missing continuity,
leaked validation language, unnatural hype — and
:func:`repair_beat_line` performs at most one deterministic rewrite to
a safe grounded line (or drops the beat). No model calls: the repair
restates beat evidence verbatim and always re-passes the factual
validator before it is accepted.
"""

from __future__ import annotations

import re

from ..commentary.writer import contains_leaked_validation_language
from ..config import SCRIPT_UNCERTAINTY_MARKERS
from .generation import script_text_valid


#: Screenshot narration: describing the frame, HUD text, or template
#: shapes instead of the developing play.
SCREENSHOT_PATTERNS = (
    re.compile(r"\bscreenshot\b", re.IGNORECASE),
    re.compile(r"\b(image|picture|frame) shows\b", re.IGNORECASE),
    re.compile(r"\bin this frame\b", re.IGNORECASE),
    re.compile(r"\bvisible\s*:", re.IGNORECASE),
    re.compile(r"\bhud reads\b", re.IGNORECASE),
    re.compile(r"^(new development|update)\s*:", re.IGNORECASE),
)

#: Lines that are nothing but a conversational opener or empty chatter.
FILLER_PATTERNS = (
    re.compile(
        r"^(well|alright|okay|here we go|let'?s go|what a moment)"
        r"[\s.!]*$",
        re.IGNORECASE,
    ),
    re.compile(r"\bladies and gentlemen\b", re.IGNORECASE),
    re.compile(r"\b(uh|um)\b.*\b(uh|um)\b", re.IGNORECASE),
)

#: Hype words that need an energized beat behind them.
HYPE_WORDS = (
    "unbelievable",
    "incredible",
    "insane",
    "amazing",
    "spectacular",
    "unreal",
    "phenomenal",
)

#: Markers that connect a follow-up beat to the developing situation.
CONTINUITY_MARKERS = (
    "still",
    "continues",
    "continuing",
    "another",
    "again",
    "meanwhile",
    "keeps",
    "holding",
    "remains",
    "answers",
    "responds",
)

#: Cautious tail that grounds an event-echo repair without leaking.
REPAIR_UNCERTAINTY_TAIL = " Possible development, details still unclear."


def _review_norm(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip().lower())


def _has_continuity(text: str, beat: dict) -> bool:
    lowered = text.lower()
    for participant in beat.get("participants") or []:
        if participant.strip() and participant.lower() in lowered:
            return True
    return any(marker in lowered for marker in CONTINUITY_MARKERS)


def _is_hype(text: str, beat: dict) -> bool:
    delivery = beat.get("delivery")
    if text.count("!") >= 2:
        return True
    if "!" in text and delivery == "calm":
        return True
    if delivery in ("calm", "measured"):
        lowered = text.lower()
        return any(
            re.search(rf"\b{re.escape(word)}\b", lowered)
            for word in HYPE_WORDS
        )
    return False


def review_caster_quality(text: str, beat: dict | None, history: list) -> list:
    """Review one factual-valid line; return issue strings (empty = clean).

    ``beat`` is the producer beat the line words (``related_to``,
    ``participants``, ``delivery`` guide the continuity and hype
    checks; None skips beat-guided checks). ``history`` holds
    already-spoken lines for the repetition check. Deterministic:
    fixed patterns over the text, no model calls.
    """
    issues = []
    beat = beat if isinstance(beat, dict) else {}
    history = history if isinstance(history, list) else []
    if any(pattern.search(text) for pattern in SCREENSHOT_PATTERNS):
        issues.append(
            "screenshot narration: describe the developing play, "
            "not the frame or HUD text."
        )
    normalized = _review_norm(text)
    for line in history:
        if not isinstance(line, str):
            continue
        other = _review_norm(line)
        if not other:
            continue
        if normalized in other or other in normalized:
            issues.append(
                "repetition: the line restates already-spoken commentary."
            )
            break
    if any(pattern.search(text.strip()) for pattern in FILLER_PATTERNS):
        issues.append(
            "generic filler: the line carries no beat-specific development."
        )
    if beat.get("related_to") and history and not _has_continuity(text, beat):
        issues.append(
            "missing continuity: a follow-up beat should connect to the "
            "developing situation."
        )
    if contains_leaked_validation_language(text):
        issues.append(
            "leaked validation language: internal uncertainty notes must "
            "never be spoken."
        )
    if _is_hype(text, beat):
        issues.append("unnatural hype: energy exceeds the beat's delivery.")
    return issues


def repair_beat_line(
    text: str,
    beat: dict,
    cited_claims: list,
    must_not_claim: list | None = None,
    history: list | None = None,
) -> str | None:
    """Rewrite one flagged line deterministically; None drops the beat.

    A single bounded repair, never a second model call: repetition
    drops (the substance was already spoken), anything else simplifies
    to the beat's verbatim evidence sentence with a cautious tail for
    event echoes. The candidate is returned only when it re-passes
    :func:`script_text_valid` with the beat's guards; otherwise None.
    """
    issues = review_caster_quality(text, beat, history or [])
    if not issues:
        return text
    if any(issue.startswith("repetition:") for issue in issues):
        return None
    guards = (
        list(must_not_claim)
        if must_not_claim is not None
        else list(beat.get("must_not_claim") or [])
    )
    base = re.sub(r"\s+", " ", (beat.get("what") or "").strip())
    if not base:
        return None
    candidate = base
    if any(claim.get("type") == "event_echo" for claim in cited_claims):
        if not any(
            marker in candidate.lower()
            for marker in SCRIPT_UNCERTAINTY_MARKERS
        ):
            candidate = base + REPAIR_UNCERTAINTY_TAIL
    if not script_text_valid(candidate, cited_claims, must_not_claim=guards):
        return None
    return candidate
