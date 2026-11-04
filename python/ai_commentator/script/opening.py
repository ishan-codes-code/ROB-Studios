"""Project-aware opening introduction for one commentary session.

The opening is the first spoken line of a session, worded once from the
persisted project configuration (game, match type, mode, map, category,
teams, tournament, stage, language, notes) plus the active game pack's
broadcast style. It cites a synthetic timestamp-0 claim so the standard
script provenance checks apply unchanged: the line must validate via
:func:`script_text_valid`, segments stay chronological, and the opening
claim id feeds the same already-emitted suppression as every other
claim — retries never duplicate the introduction.

One bounded model call words the line; any failure falls back to a
deterministic template built verbatim from the configured fields (never
invented details). Runs without project configuration skip the opening
entirely, preserving the historical no-metadata behavior.
"""

from __future__ import annotations

import sys

from ..commentary.writer import claim_id_of, request_writer_text
from ..config import (
    SCRIPT_MAX_HISTORY_LINES,
    project_opening_metadata,
    stylistic_prompt_suffix,
)
from .generation import parse_script_segments, script_text_valid

OPENING_CLAIM_TYPE = "opening"
OPENING_TEMPLATE = "opening_intro"
OPENING_TIMESTAMP = 0

#: Cap for the deterministic fallback so long configured values can
#: never push it past the script text limits; trailing sentences drop.
OPENING_TEMPLATE_MAX_CHARS = 500


def opening_available(metadata: dict | None = None) -> bool:
    """Whether a project configuration exists to introduce.

    ``None`` reads the run environment. Bare CLI runs without settings
    return False and keep the historical behavior (no opening line).
    """
    meta = project_opening_metadata() if metadata is None else metadata
    if not isinstance(meta, dict):
        return False
    if isinstance(meta.get("game_id"), str) and meta["game_id"].strip():
        return True
    for key in (
        "match_type", "mode", "map", "category",
        "tournament", "stage", "additional_context",
    ):
        if isinstance(meta.get(key), str) and meta[key].strip():
            return True
    teams = meta.get("teams", [])
    return isinstance(teams, list) and any(
        isinstance(entry, str) and entry.strip() for entry in teams
    )


def _clean_value(text: str) -> str:
    """Strip TTS/markdown-significant characters from one metadata value."""
    cleaned = text.replace("`", "").replace("*", "")
    cleaned = cleaned.replace("claim_id", "claim id")
    cleaned = cleaned.replace("source_claim_ids", "source claim ids")
    return " ".join(cleaned.split())


def sanitized_metadata(metadata: dict) -> dict:
    """Return a metadata copy safe to interpolate into spoken text."""
    clean = dict(metadata)
    for key in (
        "match_type", "mode", "map", "category",
        "tournament", "stage", "additional_context",
    ):
        value = clean.get(key, "")
        clean[key] = _clean_value(value) if isinstance(value, str) else ""
    teams = clean.get("teams", [])
    clean["teams"] = [
        _clean_value(entry)
        for entry in teams
        if isinstance(entry, str) and _clean_value(entry)
    ] if isinstance(teams, list) else []
    return clean


def build_opening_claim(metadata: dict, game_label: str) -> dict:
    """Build the synthetic timestamp-0 claim the opening cites.

    Evidence phrases quote only configured values (plus the pack's game
    label); missing fields leave no phrase behind. The claim id derived
    from this dict via :func:`claim_id_of` is the once-per-session key.
    """
    meta = sanitized_metadata(metadata)
    label = game_label.strip() if isinstance(game_label, str) else ""
    evidence = [f"Game: {label}." if label else "Game: match."]
    if meta["match_type"]:
        evidence.append(f"Match: {meta['match_type']}.")
    if meta["mode"]:
        evidence.append(f"Mode: {meta['mode']}.")
    if meta["map"]:
        evidence.append(f"Map: {meta['map']}.")
    if meta["category"]:
        evidence.append(f"Category: {meta['category']}.")
    if meta["tournament"]:
        evidence.append(f"Tournament: {meta['tournament']}.")
    if meta["stage"]:
        evidence.append(f"Stage: {meta['stage']}.")
    if meta["teams"]:
        evidence.append(f"Teams: {' vs '.join(meta['teams'])}.")
    if meta["additional_context"]:
        evidence.append(f"Notes: {meta['additional_context']}")
    return {
        "type": OPENING_CLAIM_TYPE,
        "template": OPENING_TEMPLATE,
        "evidence": evidence,
        "source_ids": [],
        "timestamp": OPENING_TIMESTAMP,
        "confidence": "high",
        "qualification": None,
    }


def build_opening_prompt(
    claim: dict,
    claim_id: str,
    metadata: dict,
    history_texts: list,
    pack=None,
) -> str:
    """Build the bounded prompt for the opening model call.

    The model sees the pack broadcast style, the project match details,
    and the single opening claim; it must return JSON mapping the claim
    id to exactly one spoken line. Wording rules mirror the
    deterministic validator so compliant lines always pass it.
    """
    from ..prompts import coerce_pack, effective_game_context

    resolved = coerce_pack(pack)
    fields = resolved["fields"]
    meta = sanitized_metadata(metadata)
    match_context = effective_game_context(resolved)
    details = []
    if meta["tournament"]:
        details.append(f"tournament '{meta['tournament']}'")
    if meta["stage"]:
        details.append(f"stage '{meta['stage']}'")
    if meta["map"]:
        details.append(f"map '{meta['map']}'")
    if meta["teams"]:
        details.append(f"teams {', '.join(repr(t) for t in meta['teams'])}")
    if meta["match_type"]:
        details.append(f"match '{meta['match_type']}'")
    if meta["mode"]:
        details.append(f"mode '{meta['mode']}'")
    known = "; ".join(details) if details else "no further details"
    language = meta.get("language", "")
    parts = [
        fields["script_persona"] + " ",
        (match_context + " " if match_context else ""),
        "Word ONE opening spoken line introducing this match. ",
        f"Known project details: {known}. ",
        "Use only those details with natural broadcast wording in the "
        "game's vocabulary. Never invent tournament names, team names, "
        "scores, stakes, counts, or gameplay. Never predict action, "
        "never state kills, zones, outcomes, or tactics, and never use "
        "causal or intent claims. ",
        "Respond with ONLY a single JSON object, no markdown fences, no ",
        "commentary, matching this shape: ",
        '{"segments": [{"source_claim_ids": [<the id below>], ',
        '"text": <the spoken line>}]}. ',
        fields["script_closing"] + " ",
        f"Claim {claim_id} (at 0s, opening introduction, "
        f"evidence: {' / '.join(claim['evidence'])}). ",
    ]
    if language:
        parts.append(f"Write the line in {language}. ")
    if history_texts:
        parts.append("Already said (do not repeat this information): ")
        parts.append(" | ".join(history_texts[-SCRIPT_MAX_HISTORY_LINES:]))
    return "".join(parts) + stylistic_prompt_suffix()


def render_opening_template(metadata: dict, game_label: str) -> str:
    """Render the deterministic fallback introduction (verbatim fields).

    Sentences use only configured values in broadcast order — event,
    map, teams, format — so the line stays factual when the model call
    fails. Trailing sentences drop past the length cap; at least the
    welcome sentence always remains.
    """
    meta = sanitized_metadata(metadata)
    label = game_label.strip() if isinstance(game_label, str) else ""
    if meta["tournament"]:
        sentences = [f"Welcome to {meta['tournament']}."]
        if meta["stage"]:
            sentences.append(f"This is the {meta['stage']}.")
    elif label:
        sentences = [f"Welcome to this {label} match."]
    else:
        sentences = ["Welcome to this match."]
    if meta["map"]:
        sentences.append(f"We are on {meta['map']}.")
    teams = meta["teams"]
    if len(teams) == 1:
        sentences.append(f"Featuring {teams[0]}.")
    elif len(teams) >= 2:
        joined = ", ".join(teams[:-1]) + f" and {teams[-1]}"
        sentences.append(f"{joined} are in action.")
    format_bits = " ".join(
        part for part in (meta["match_type"], meta["mode"]) if part
    )
    if format_bits:
        sentences.append(f"We have {format_bits} coming up.")
    while len(" ".join(sentences)) > OPENING_TEMPLATE_MAX_CHARS and len(sentences) > 1:
        sentences.pop()
    return " ".join(sentences)


def run_opening(
    client,
    pack,
    prior_claim_ids: set,
    history_texts: list,
    metadata: dict | None = None,
    api_key: str | None = None,
) -> tuple:
    """Word the session opening; return (utterance, omitted, claim).

    ``utterance`` is ``{"timestamp", "text", "source_claim_ids"}`` at
    timestamp 0 (callers assign queue priority and segment ids).
    ``omitted`` is a suppression record (or None), and ``claim`` the
    opening claim keyed for provenance (or None when nothing was
    worded). A claim id already in ``prior_claim_ids`` suppresses with
    ``already-emitted`` so retries never duplicate the introduction.
    Model trouble falls back to the deterministic template; only a
    template that fails validation (unconfigured edge) omits.
    """
    from ..prompts import coerce_pack

    meta = project_opening_metadata() if metadata is None else metadata
    if not opening_available(meta):
        return None, None, None
    label = coerce_pack(pack)["fields"].get("game_label", "") or ""
    claim = build_opening_claim(meta, label)
    claim_id = claim_id_of(claim)
    if claim_id in prior_claim_ids:
        return (
            None,
            {
                "rule": "already-emitted",
                "subject": claim_id,
                "reason": "opening already worded in this session.",
            },
            None,
        )
    wording = None
    if client is not None:
        try:
            prompt = build_opening_prompt(claim, claim_id, meta, history_texts, pack)
            raw = request_writer_text(client, prompt, api_key=api_key, purpose="script")
            parsed = parse_script_segments(raw, {claim_id: claim})
            if parsed:
                candidate = parsed[0][1]
                if script_text_valid(candidate, [claim]):
                    wording = candidate.strip()
        except Exception as exc:
            # The opening is auxiliary: any model trouble falls back to
            # the deterministic template instead of failing the run.
            print(f"Opening model call failed ({exc}); using template.", file=sys.stderr)
    if wording is None:
        template = render_opening_template(meta, label)
        if script_text_valid(template, [claim]):
            wording = template
    if wording is None:
        return (
            None,
            {
                "rule": "unsupported-wording",
                "subject": claim_id,
                "reason": "opening wording not grounded in project details.",
            },
            None,
        )
    utterance = {
        "timestamp": OPENING_TIMESTAMP,
        "text": wording,
        "source_claim_ids": [claim_id],
    }
    return utterance, None, dict(claim, claim_id=claim_id)
