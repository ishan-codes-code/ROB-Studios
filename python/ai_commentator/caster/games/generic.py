"""Generic fallback match knowledge (unknown game).

Reports nothing game-specific: round structure, revival rules, and win
conditions vary by title and mode, so the only honest entry is the
standing unknown. Direct developments (knocks, cover, zone, counters)
are covered by the structural analyst, which runs regardless of game.
"""

from __future__ import annotations


GAME_ID = "generic"


def analyze(gameplay: dict, state: dict, events: dict) -> dict:
    """Return the generic game read: no round claims, one standing unknown."""
    return {
        "observed_facts": [],
        "interpretations": [],
        "hypotheses": [],
        "unknown": [
            {
                "text": "Game-specific round structure is unknown; only "
                "directly quoted developments are reported.",
                "evidence": [],
                "confidence": "low",
            }
        ],
    }
