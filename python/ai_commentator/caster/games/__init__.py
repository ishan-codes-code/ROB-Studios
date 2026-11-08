"""Game-specific match knowledge for the caster analyst.

Each game module exposes ``GAME_ID`` and ``analyze(gameplay, state,
events)`` returning the four analyst keys (``observed_facts``,
``interpretations``, ``hypotheses``, ``unknown``) with entry dicts of
``text``/``evidence``/``confidence``. Game selection is a deterministic
heuristic over validated wording only; anything unrecognized falls back
to the generic module, which reports direct developments without
round-structure reads.
"""

from __future__ import annotations

import re

from . import clash_squad, generic


#: Whole-word round-structure markers that select Clash Squad. Bare
#: outcome words (``winner``, ``victory``) are deliberately excluded: a
#: battle-royale end screen is not a round match.
_CLASH_SQUAD_RE = re.compile(
    r"clash squad|\bclash\b|\bround\b|match[-\s]?point|matchpoint|\bbooyah\b",
    re.IGNORECASE,
)

GAME_MODULES = (clash_squad, generic)


def select_game(gameplay: dict, state: dict):
    """Return the game module matching validated wording, else generic.

    Pure and deterministic: fact descriptions are scanned in sorted
    order, so the same inputs always select the same module.
    """
    descriptions = [
        item.get("description", "")
        for item in gameplay.get("fact_signals", [])
        if isinstance(item, dict)
    ]
    for fact in state.get("facts", []):
        if isinstance(fact, dict) and isinstance(fact.get("description"), str):
            descriptions.append(fact["description"])
    for description in sorted(set(descriptions)):
        if _CLASH_SQUAD_RE.search(description):
            return clash_squad
    return generic
