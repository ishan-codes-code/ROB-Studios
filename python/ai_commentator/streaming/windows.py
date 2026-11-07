"""Incremental script windows for the streaming pipeline.

One window rebuilds match state and events in memory from the
observations seen so far (reusing the same pure functions as the
sequential runners), gates claims, diffs against already-worded claim
ids, and issues at most one bounded script LLM call for the fresh
claims. Every worded utterance is validated deterministically before it
may flow downstream; failures are recorded as omissions, never spoken.
"""

from __future__ import annotations

from ..commentary.claims import gate_commentary_claims
from ..commentary.writer import (
    claim_id_of,
    prioritize_writer_claims,
    request_writer_text,
)
from ..config import SCRIPT_MAX_CLAIMS, SCRIPT_OUTCOME_STEMS
from ..errors import ObservationError, WriterAPIError
from ..events.detection import detect_events
from ..script.generation import (
    build_script_prompt,
    parse_script_segments,
    script_text_valid,
)
from ..state.match_state import build_match_state
from .queues import PRIORITY_HIGH, PRIORITY_LOW, PRIORITY_NORMAL

#: A script window triggers once this many new observations arrived (or a
#: HIGH-speed observation signals potentially significant gameplay, or the
#: vision stream ends).
WINDOW_MIN_OBSERVATIONS = 3


def utterance_priority(cited_claims: list) -> int:
    """App-side urgency for one utterance: echoes > developments > rest."""
    types = {claim.get("type") for claim in cited_claims}
    if "event_echo" in types:
        return PRIORITY_HIGH
    if "development" in types:
        return PRIORITY_NORMAL
    return PRIORITY_LOW


#: Delivery intensities for the script prompt, derived from evidence.
INTENSITY_LEVELS = ("low", "medium", "high", "critical")


def utterance_intensity(cited_claims: list) -> str:
    """Delivery intensity for one utterance, from cited evidence only.

    Scene-only lines stay calm, developments rise, event echoes run
    hot, and echoes whose evidence already names a match outcome
    (victory, defeat, champion, ...) peak: a small moment never shouts
    like a decisive one.
    """
    types = {claim.get("type") for claim in cited_claims}
    if "event_echo" in types:
        evidence = " ".join(
            part
            for claim in cited_claims
            for part in claim.get("evidence", [])
        ).lower()
        if any(stem in evidence for stem in SCRIPT_OUTCOME_STEMS):
            return "critical"
        return "high"
    if "development" in types:
        return "medium"
    return "low"


def run_script_window(
    observations: list,
    history_texts: list,
    seen_claim_ids: set,
    client,
    pack=None,
    api_key: str | None = None,
) -> tuple[list, list, list, str | None]:
    """Word one incremental window; return (utterances, omitted, fresh, error).

    ``observations`` is ``[(timestamp, source, validated)]`` seen so far
    (whole prefix, in any order). ``seen_claim_ids`` holds claim ids
    already worded or suppressed in earlier windows and is updated in
    place. ``utterances`` are ``{"timestamp", "text", "source_claim_ids",
    "priority"}`` dicts (utterance ids are assigned by the orchestrator).
    ``omitted`` collects suppression records; ``fresh`` the gated fresh
    claims keyed for provenance; ``error`` is a window-level failure
    message (or None) — callers continue with later windows either way.
    """
    omitted: list = []
    try:
        state = build_match_state(observations)
        events, _counts = detect_events(observations, state)
        claims, suppressed = gate_commentary_claims(observations, state, events)
    except ObservationError as exc:
        return [], [], [], f"window gating failed: {exc}"
    omitted.extend(
        {"rule": entry["rule"], "subject": entry["subject"], "reason": entry["reason"]}
        for entry in suppressed
    )
    fresh_claims = []
    for claim in claims:
        claim_id = claim_id_of(claim)
        if claim_id in seen_claim_ids:
            omitted.append(
                {
                    "rule": "already-emitted",
                    "subject": claim_id,
                    "reason": (
                        "identical claim already worded in an earlier window; "
                        "no new development."
                    ),
                }
            )
            continue
        seen_claim_ids.add(claim_id)
        fresh_claims.append(dict(claim, claim_id=claim_id))
    if not fresh_claims:
        return [], omitted, [], None
    model_claims, overflow = prioritize_writer_claims(fresh_claims)
    # Overflow claims were never sent: release them so a later window can
    # still word them (mirrors the sequential rerun behavior).
    seen_claim_ids.difference_update(claim["claim_id"] for claim in overflow)
    for claim in overflow:
        omitted.append(
            {
                "rule": "over-claim-limit",
                "subject": claim["claim_id"],
                "reason": (
                    f"claim beyond the bounded batch of {SCRIPT_MAX_CLAIMS}; "
                    "not sent to the model in this window."
                ),
            }
        )
    prompt_claims = list(model_claims)
    prompt_by_id = {claim["claim_id"]: claim for claim in prompt_claims}
    try:
        prompt = build_script_prompt(
            prompt_claims,
            history_texts,
            pack,
            intensity=utterance_intensity(prompt_claims),
        )
        raw = request_writer_text(client, prompt, api_key=api_key)
        parsed = parse_script_segments(raw, prompt_by_id)
    except (WriterAPIError, ObservationError) as exc:
        # The claims were marked seen before the model call but were
        # never worded: release them so a later window can still word
        # them (mirrors the over-claim-limit release above).
        seen_claim_ids.difference_update(
            claim["claim_id"] for claim in prompt_claims
        )
        omitted.append(
            {
                "rule": "model-output",
                "subject": "script-request",
                "reason": f"model request produced no usable output: {exc}",
            }
        )
        return [], omitted, fresh_claims, f"script request failed: {exc}"
    utterances = []
    for ids, wording in parsed:
        cited = [prompt_by_id[claim_id] for claim_id in ids]
        if not script_text_valid(wording, cited):
            omitted.append(
                {
                    "rule": "unsupported-wording",
                    "subject": "+".join(ids),
                    "reason": "model wording not grounded in cited evidence.",
                }
            )
            continue
        timestamp = max(claim["timestamp"] for claim in cited)
        utterances.append(
            {
                "timestamp": timestamp,
                "text": wording.strip(),
                "source_claim_ids": sorted(ids),
                "priority": utterance_priority(cited),
            }
        )
    utterances.sort(key=lambda item: (item["timestamp"], item["source_claim_ids"]))
    return utterances, omitted, fresh_claims, None
