"""Broadcast-significance gating: worthy gameplay spoken, scenery silent.

Confidence is not significance: a high-confidence description of grass
is still grass. These tests prove the gate suppresses standalone
scenery, generic sightings, and HUD trivia while keeping gameplay
developments, event echoes, entity changes, and event-linked context.
No live API calls.
"""

import contextlib
import io
import json
import tempfile
import unittest
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))

from main import (
    build_match_state,
    detect_events,
    gate_commentary_claims,
    run_generate_commentary,
)


def _entry(category, description, evidence, confidence="high", **extra):
    item = {
        "category": category,
        "description": description,
        "confidence": confidence,
        "evidence": evidence,
    }
    item.update(extra)
    return item


def _doc(timestamp, entries, version="observation-v2"):
    return {
        "schema_version": version,
        "timestamp": timestamp,
        "observations": entries,
        "uncertainties": [],
    }


def _accepted(*docs):
    return [
        (doc["timestamp"], f"frame_{doc['timestamp']:05d}.json", doc)
        for doc in docs
    ]


def _gate(*docs):
    accepted = _accepted(*docs)
    state = build_match_state(accepted)
    events, _ = detect_events(accepted, state)
    claims, suppressed = gate_commentary_claims(list(accepted), state, events)
    return claims, suppressed


def _suppression_rules(suppressed):
    return {entry["rule"] for entry in suppressed}


def _run(*docs):
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        obs_dir = root / "observations"
        obs_dir.mkdir()
        accepted = []
        for doc in docs:
            name = f"frame_{doc['timestamp']:05d}.json"
            (obs_dir / name).write_text(json.dumps(doc), encoding="utf-8")
            accepted.append((doc["timestamp"], name, doc))
        state = build_match_state(list(accepted))
        state_path = obs_dir / "match_state.json"
        state_path.write_text(json.dumps(state), encoding="utf-8")
        events, _ = detect_events(list(accepted), state)
        events_path = root / "events.json"
        events_path.write_text(json.dumps(events), encoding="utf-8")
        out_path = root / "commentary.json"
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = run_generate_commentary(
                observations_dir=obs_dir,
                state_path=state_path,
                events_path=events_path,
                commentary_path=out_path,
            )
        assert code == 0, err.getvalue()
        return json.loads(out_path.read_text(encoding="utf-8"))


class ScenerySuppressionTests(unittest.TestCase):
    def test_billboard_sighting_suppressed(self):
        claims, suppressed = _gate(
            _doc(
                0,
                [
                    _entry(
                        "character",
                        "A player standing near the billboard.",
                        "Figure by the billboard.",
                    )
                ],
            )
        )
        self.assertEqual(claims, [])
        self.assertIn("no-broadcast-significance", _suppression_rules(suppressed))

    def test_grass_road_billboard_suppressed(self):
        claims, suppressed = _gate(
            _doc(
                0,
                [
                    _entry(
                        "character",
                        "A player standing on the grass by the billboard "
                        "next to the road.",
                        "Figure on grass by the billboard.",
                    )
                ],
            )
        )
        self.assertEqual(claims, [])

    def test_prone_figure_without_knock_words_suppressed(self):
        claims, _ = _gate(
            _doc(
                0,
                [
                    _entry(
                        "character",
                        "A player is lying in the center of the screen.",
                        "Prone figure center screen.",
                    )
                ],
            )
        )
        self.assertEqual(claims, [])

    def test_named_sighting_still_suppressed(self):
        # A named entity at high confidence with no gameplay link is a
        # generic sighting, not a development.
        claims, _ = _gate(
            _doc(
                0,
                [
                    _entry(
                        "character",
                        "AG.BAROS near the rock.",
                        "AG.BAROS by the rock.",
                        subjects=[{"label": "AG.BAROS", "kind": "player"}],
                        spatial="near the rock",
                    )
                ],
            )
        )
        self.assertEqual(claims, [])

    def test_hud_trivia_suppressed(self):
        document = _run(
            _doc(
                0,
                [_entry("hud", "Timer 08:30 with 34 alive.", "Timer text.")],
            )
        )
        self.assertEqual(document["lines"], [])
        self.assertIn(
            "no-broadcast-significance",
            _suppression_rules(document["suppressed"]),
        )


class GameplayKeptTests(unittest.TestCase):
    def test_combat_development_kept(self):
        claims, _ = _gate(
            _doc(
                0,
                [
                    _entry(
                        "character",
                        "AG.BAROS firing near the ridge.",
                        "AG.BAROS muzzle flash.",
                        subjects=[{"label": "AG.BAROS", "kind": "player"}],
                    )
                ],
            )
        )
        self.assertTrue(claims)
        self.assertTrue(
            all("combat" in claim["gameplay"]["tags"] for claim in claims)
        )

    def test_knockdown_echo_kept_and_qualified(self):
        claims, _ = _gate(
            _doc(
                0,
                [
                    _entry(
                        "character",
                        "AG.BAROS knocked down behind cover.",
                        "AG.BAROS prone behind cover.",
                    )
                ],
            )
        )
        echoes = [claim for claim in claims if claim["type"] == "event_echo"]
        self.assertEqual(len(echoes), 1)
        self.assertIn("elimination is not established", echoes[0]["qualification"])

    def test_engagement_echo_outranks_quiet_claims(self):
        claims, _ = _gate(
            _doc(
                0,
                [
                    _entry(
                        "combat",
                        "AG.BAROS firing at the ridge.",
                        "Muzzle flashes.",
                    ),
                    _entry(
                        "environment",
                        "Grass swaying by the road.",
                        "Green grass, grey road.",
                    ),
                ],
            ),
            _doc(
                6,
                [
                    _entry(
                        "combat",
                        "Exchange continues at the ridge.",
                        "Tracers both ways.",
                    ),
                    _entry(
                        "environment",
                        "Grass swaying by the road.",
                        "Green grass, grey road.",
                    ),
                ],
            ),
        )
        by_type = {}
        for claim in claims:
            by_type.setdefault(claim["type"], []).append(claim)
        self.assertIn("event_echo", by_type)
        # The persisting grass is stale description, never a claim.
        for claim in claims:
            self.assertNotIn("Grass swaying", claim["evidence"])

    def test_moved_entity_keeps_plain_sighting(self):
        claims, _ = _gate(
            _doc(
                0,
                [
                    _entry(
                        "character",
                        "AG.BAROS near the rock.",
                        "AG.BAROS by the rock.",
                        subjects=[{"label": "AG.BAROS", "kind": "player"}],
                        spatial="near the rock",
                    )
                ],
            ),
            _doc(
                3,
                [
                    _entry(
                        "character",
                        "AG.BAROS behind the wall.",
                        "AG.BAROS behind the wall.",
                        subjects=[{"label": "AG.BAROS", "kind": "player"}],
                        spatial="behind the wall",
                    )
                ],
            ),
        )
        texts = [claim["evidence"] for claim in claims]
        self.assertTrue(
            any("AG.BAROS behind the wall." in evidence for evidence in texts)
        )

    def test_blue_wall_claim_kept_as_tactical(self):
        claims, _ = _gate(
            _doc(
                0,
                [
                    _entry(
                        "character",
                        "Two players are visible near the Blue Walls.",
                        "Two figures by Blue Walls.",
                    )
                ],
            )
        )
        self.assertTrue(claims)
        self.assertTrue(
            any(
                "blue_wall" in claim["gameplay"]["tags"]
                for claim in claims
            )
        )

    def test_zone_development_kept(self):
        claims, _ = _gate(
            _doc(
                0,
                [
                    _entry(
                        "hud",
                        "Minimap shows the safe zone shrinking.",
                        "Zone circle closing.",
                    )
                ],
            )
        )
        self.assertTrue(claims)

    def test_gameplay_context_travels_with_claims(self):
        claims, _ = _gate(
            _doc(
                0,
                [
                    _entry(
                        "character",
                        "AG.BAROS firing near the ridge.",
                        "AG.BAROS muzzle flash.",
                        subjects=[{"label": "AG.BAROS", "kind": "player"}],
                    )
                ],
            )
        )
        self.assertTrue(claims)
        for claim in claims:
            context = claim["gameplay"]
            self.assertIn("tags", context)
            self.assertIn("entities", context)
            self.assertIn("AG.BAROS", context["entities"])


if __name__ == "__main__":
    unittest.main()
