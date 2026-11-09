"""Gameplay event intelligence: engagement, knockdown, revive, cover, zone.

Offline fixture tests for the additive events-v1 gameplay rules. The
pre-existing kill-feed and elimination-counter rules are preserved
unchanged (see test_event_detection.py); these tests cover only the new
rules plus their interaction with confidence, contested evidence, and
significance ordering. No live API calls.
"""

import unittest
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))

from main import (
    EVENT_SIGNIFICANCE_RANK,
    build_match_state,
    detect_events,
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


def _detect(*docs):
    accepted = _accepted(*docs)
    state = build_match_state(accepted)
    events, _ = detect_events(accepted, state)
    return events


def _types(events):
    return sorted(event["type"] for event in events["events"])


class EngagementTests(unittest.TestCase):
    def test_engagement_fires_across_two_timestamps(self):
        events = _detect(
            _doc(
                0,
                [
                    _entry(
                        "combat",
                        "AG.BAROS firing at the ridge.",
                        "Muzzle flashes from AG.BAROS.",
                        subjects=[{"label": "AG.BAROS", "kind": "player"}],
                    )
                ],
            ),
            _doc(
                6,
                [
                    _entry(
                        "character",
                        "EVOS.RAJ returning fire behind cover.",
                        "Tracer from EVOS.RAJ position.",
                        subjects=[{"label": "EVOS.RAJ", "kind": "player"}],
                    )
                ],
            ),
        )
        engagements = [
            event for event in events["events"]
            if event["type"] == "combat_engagement"
        ]
        self.assertEqual(len(engagements), 1)
        event = engagements[0]
        self.assertEqual(event["timestamp"], 6)
        self.assertEqual(event["status"], "candidate")
        self.assertEqual(event["rule"], "combat_engagement/v1")
        self.assertIn("participants, outcome, and cause are not established",
                      event["detail"])

    def test_single_combat_sighting_is_not_an_engagement(self):
        events = _detect(
            _doc(
                0,
                [_entry("combat", "Distant gunfire flashes.", "Flashes.")],
            ),
            _doc(30, [_entry("environment", "Quiet ridge.", "Empty ridge.")]),
        )
        self.assertNotIn("combat_engagement", _types(events))

    def test_sightings_beyond_window_do_not_cluster(self):
        events = _detect(
            _doc(0, [_entry("combat", "Gunfire at the ridge.", "Flashes.")]),
            _doc(60, [_entry("combat", "Gunfire at the compound.", "Flashes.")]),
        )
        self.assertNotIn("combat_engagement", _types(events))

    def test_generic_visibility_is_not_a_sighting(self):
        events = _detect(
            _doc(
                0,
                [_entry("character", "A player near the rock.", "Figure.")],
            ),
            _doc(
                6,
                [_entry("character", "A player near the wall.", "Figure.")],
            ),
        )
        self.assertNotIn("combat_engagement", _types(events))

    def test_low_confidence_combat_suppressed(self):
        events = _detect(
            _doc(
                0,
                [
                    _entry(
                        "combat", "Gunfire at the ridge.", "Flashes.",
                        confidence="low",
                    )
                ],
            ),
            _doc(6, [_entry("combat", "Gunfire continues.", "Flashes.")]),
        )
        self.assertNotIn("combat_engagement", _types(events))


class KnockdownTests(unittest.TestCase):
    def test_knockdown_fires_on_explicit_wording(self):
        events = _detect(
            _doc(
                0,
                [
                    _entry(
                        "character",
                        "AG.BAROS knocked down behind cover.",
                        "AG.BAROS prone behind cover.",
                        subjects=[{"label": "AG.BAROS", "kind": "player"}],
                    )
                ],
            )
        )
        knocks = [
            event for event in events["events"]
            if event["type"] == "knockdown_observed"
        ]
        self.assertEqual(len(knocks), 1)
        self.assertIn("elimination is not established", knocks[0]["detail"])
        self.assertEqual(knocks[0]["confidence"], "high")

    def test_knockdown_suppressed_when_elim_wording_present(self):
        events = _detect(
            _doc(
                0,
                [
                    _entry(
                        "character",
                        "AG.BAROS knocked down then eliminated.",
                        "AG.BAROS down, elimination confirmed on screen.",
                    )
                ],
            )
        )
        self.assertNotIn("knockdown_observed", _types(events))

    def test_persistent_knockdown_wording_fires_once(self):
        doc = lambda ts: _doc(
            ts,
            [
                _entry(
                    "character",
                    "AG.BAROS knocked down behind cover.",
                    "AG.BAROS prone behind cover.",
                )
            ],
        )
        events = _detect(doc(0), doc(6), doc(12))
        knocks = [
            event for event in events["events"]
            if event["type"] == "knockdown_observed"
        ]
        self.assertEqual(len(knocks), 1)
        self.assertEqual(knocks[0]["timestamp"], 0)

    def test_lying_without_knock_words_is_not_a_knockdown(self):
        events = _detect(
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
        self.assertNotIn("knockdown_observed", _types(events))


class ReviveCoverZoneTests(unittest.TestCase):
    def test_revive_fires_on_explicit_wording(self):
        events = _detect(
            _doc(
                0,
                [
                    _entry(
                        "character",
                        "EVOS.RAJ reviving a knocked teammate.",
                        "Revive progress ring visible.",
                    )
                ],
            )
        )
        self.assertIn("revive_observed", _types(events))

    def test_reappearance_without_revive_words_never_fires(self):
        events = _detect(
            _doc(
                0,
                [
                    _entry(
                        "character",
                        "AG.BAROS near the rock.",
                        "AG.BAROS by the rock.",
                        subjects=[{"label": "AG.BAROS", "kind": "player"}],
                    )
                ],
            ),
            _doc(30, [_entry("environment", "Empty ridge.", "No figures.")]),
            _doc(
                60,
                [
                    _entry(
                        "character",
                        "AG.BAROS at the ridge.",
                        "AG.BAROS at the ridge.",
                        subjects=[{"label": "AG.BAROS", "kind": "player"}],
                    )
                ],
            ),
        )
        self.assertNotIn("revive_observed", _types(events))

    def test_blue_wall_fires_on_cover_wording(self):
        for description in (
            "Blue Wall deployed at the ridge.",
            "Gloo Wall blocking the doorway.",
        ):
            with self.subTest(description=description):
                events = _detect(
                    _doc(0, [_entry("combat", description, f"Visible: {description}")])
                )
                self.assertIn("blue_wall_use", _types(events))

    def test_bare_shield_is_not_a_blue_wall(self):
        events = _detect(
            _doc(
                0,
                [_entry("combat", "A shield wall glows blue.", "Blue glow.")],
            )
        )
        self.assertNotIn("blue_wall_use", _types(events))

    def test_zone_pressure_fires_on_zone_wording(self):
        events = _detect(
            _doc(
                0,
                [
                    _entry(
                        "hud",
                        "Minimap shows the safe zone shrinking.",
                        "Zone circle closing on the minimap.",
                    )
                ],
            )
        )
        self.assertIn("zone_pressure", _types(events))

    def test_new_rules_share_confidence_and_contest_gates(self):
        events = _detect(
            _doc(
                0,
                [
                    _entry(
                        "character",
                        "A player knocked down mid-field.",
                        "Down player.",
                        confidence="low",
                    )
                ],
            )
        )
        self.assertNotIn("knockdown_observed", _types(events))


class SignificanceRankTests(unittest.TestCase):
    def test_rank_orders_gameplay_rules(self):
        rank = list(EVENT_SIGNIFICANCE_RANK)
        self.assertLess(rank.index("combat_engagement"), rank.index("zone_pressure"))
        self.assertLess(rank.index("knockdown_observed"), rank.index("kill_feed_entry"))
        self.assertLess(rank.index("feed_cluster"), rank.index("combat_engagement"))
        # The v1 subsequence keeps its relative order.
        self.assertLess(rank.index("feed_cluster"), rank.index("elim_streak"))
        self.assertLess(rank.index("elim_streak"), rank.index("elim_count_increased"))
        self.assertLess(
            rank.index("elim_count_increased"), rank.index("kill_feed_entry")
        )

    def test_new_and_legacy_rules_fire_together(self):
        events = _detect(
            _doc(
                0,
                [
                    _entry(
                        "hud",
                        "Team AG panel header Elim 4, bottom-left.",
                        "Header text Elim 4 in the team AG panel.",
                    ),
                    _entry(
                        "combat",
                        "AG.BAROS firing at the ridge.",
                        "Muzzle flashes from AG.BAROS.",
                    ),
                ],
            ),
            _doc(
                6,
                [
                    _entry(
                        "hud",
                        "Team AG panel header Elim 5, bottom-left.",
                        "Header text Elim 5 in the team AG panel.",
                    ),
                    _entry(
                        "combat",
                        "Exchange continues at the ridge.",
                        "Tracers both ways.",
                    ),
                ],
            ),
        )
        self.assertIn("elim_count_increased", _types(events))
        self.assertIn("combat_engagement", _types(events))


if __name__ == "__main__":
    unittest.main()
