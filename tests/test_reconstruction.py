"""Temporal match reconstruction: new signals, tracks, timelines.

Targeted coverage for the Stage A/B perception extensions only: the
equipment/weapon and round-state/HUD-phase signal tags, per-track
last-known positions, position-change sequences, engagement timelines,
and weakest-link tracking confidence. Existing gameplay behavior stays
covered by ``test_gameplay.py``.
"""

import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))

from main import (
    ObservationError,
    build_entity_tracks,
    build_gameplay_state,
    build_match_state,
    entry_signals,
    validate_gameplay,
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


def _tracked(*docs):
    accepted = _accepted(*docs)
    return build_entity_tracks(accepted)


def _labeled(tracks, ref="AG.BAROS"):
    matches = [
        track for track in tracks
        if track["ref"] == ref and track["identity"] == "exact-label"
    ]
    assert len(matches) == 1, f"expected one track for {ref}"
    return matches[0]


def _named_entry(description, evidence, label="AG.BAROS", **extra):
    return _entry(
        "character",
        description,
        evidence,
        subjects=[{"label": label, "kind": "player"}],
        **extra,
    )


class WeaponSignalTests(unittest.TestCase):
    def test_weapon_terms_fire(self):
        cases = {
            "AG.BAROS firing an AK rifle near the ridge.": "rifle prose",
            "AG.BAROS reloading behind cover with low ammo.": "reload/ammo",
            "A sniper watches the compound from the tower.": "sniper",
            "An MP40 and an M1014 lie on the crate.": "model names",
            "A grenade launcher points at the doorway.": "launcher overlap",
        }
        for description, _ in cases.items():
            with self.subTest(description=description):
                signals = entry_signals(
                    _entry("combat", description, f"Visible: {description}")
                )
                self.assertIn("weapon", signals["observed"])

    def test_grenade_launcher_tags_both_weapon_and_grenade(self):
        signals = entry_signals(
            _entry(
                "combat",
                "A grenade launcher points at the doorway.",
                "Tube weapon at the doorway.",
            )
        )
        self.assertIn("weapon", signals["observed"])
        self.assertIn("grenade", signals["observed"])

    def test_weapon_terms_ignore_substrings_and_names(self):
        combat_only = entry_signals(
            _entry("combat", "Distant gunfire flashes.", "Flashes on the ridge.")
        )
        self.assertIn("combat", combat_only["observed"])
        self.assertNotIn("weapon", combat_only["observed"])
        begun = entry_signals(
            _entry("hud", "The fight has begun.", "Timer running.")
        )
        self.assertNotIn("weapon", begun["observed"])
        gamertag = entry_signals(
            _named_entry(
                "SCAR.FACE looting near the rock.",
                "SCAR.FACE by the rock.",
                label="SCAR.FACE",
            )
        )
        self.assertIn("entity_mention", gamertag["observed"])
        self.assertNotIn("weapon", gamertag["observed"])
        jump = entry_signals(
            _entry("character", "A player jumps over the bump.", "Figure mid-jump.")
        )
        self.assertNotIn("weapon", jump["observed"])


class EquipmentSignalTests(unittest.TestCase):
    def test_equipment_terms_fire(self):
        cases = [
            "A helmet and vest lie next to a medkit.",
            "AG.BAROS checks the loadout inventory.",
            "Loot crates glow near the airdrop.",
            "A flare arcs over the compound.",
        ]
        for description in cases:
            with self.subTest(description=description):
                signals = entry_signals(
                    _entry("character", description, f"Visible: {description}")
                )
                self.assertIn("equipment", signals["observed"])

    def test_blue_wall_stays_cover_not_equipment(self):
        signals = entry_signals(
            _entry(
                "combat",
                "Blue Wall deployed at the ridge.",
                "Blue Wall panels at the ridge.",
            )
        )
        self.assertIn("blue_wall", signals["observed"])
        self.assertNotIn("equipment", signals["observed"])
        self.assertNotIn("weapon", signals["observed"])
        shield = entry_signals(
            _entry("combat", "A shield wall glows blue.", "Blue glow effect.")
        )
        self.assertNotIn("blue_wall", shield["observed"])
        self.assertNotIn("equipment", shield["observed"])


class RoundStateSignalTests(unittest.TestCase):
    def test_round_state_terms_fire(self):
        cases = [
            "Round 3 begins on the main stage.",
            "Match point for the defending squad.",
            "Booyah! The arena erupts.",
            "Winner Winner Chicken Dinner on the final screen.",
            "The scoreboard shows two rounds to one.",
        ]
        for description in cases:
            with self.subTest(description=description):
                signals = entry_signals(
                    _entry("hud", description, f"Visible: {description}")
                )
                self.assertIn("round_state", signals["observed"])

    def test_round_state_ignores_lookalikes(self):
        for description in (
            "AG.BAROS looks around the rock.",
            "A crate sits on the ground.",
            "He has 30 rounds left in the magazine.",
        ):
            with self.subTest(description=description):
                signals = entry_signals(
                    _entry("character", description, f"Visible: {description}")
                )
                self.assertNotIn("round_state", signals["observed"])

    def test_gamertag_winner_does_not_fire_round_state(self):
        signals = entry_signals(
            _named_entry(
                "WINNER.JOE holds the doorway.",
                "WINNER.JOE at the doorway.",
                label="WINNER.JOE",
            )
        )
        self.assertIn("entity_mention", signals["observed"])
        self.assertNotIn("round_state", signals["observed"])


class MatchPhaseSignalTests(unittest.TestCase):
    def test_match_phase_terms_fire(self):
        cases = [
            "Squads wait in the lobby before the flight.",
            "A player parachuting over the drop zone.",
            "Timer 08:30 with 34 alive.",
            "HUD header reads Elim 4.",
            "The end screen fades to the results.",
        ]
        for description in cases:
            with self.subTest(description=description):
                signals = entry_signals(
                    _entry("hud", description, f"Visible: {description}")
                )
                self.assertIn("match_phase", signals["observed"])

    def test_elim_counter_is_phase_not_outcome(self):
        signals = entry_signals(
            _entry("hud", "HUD header reads Elim 4.", "Header text Elim 4.")
        )
        self.assertIn("match_phase", signals["observed"])
        self.assertNotIn("elim", signals["observed"])
        outcome = entry_signals(
            _entry(
                "combat",
                "RRQ.JEEK eliminated OG.IQOOPAWDI.",
                "Feed line RRQ.JEEK over OG.IQOOPAWDI.",
            )
        )
        self.assertIn("elim", outcome["observed"])
        self.assertNotIn("match_phase", outcome["observed"])

    def test_match_phase_ignores_lookalikes(self):
        for description in (
            "A planet poster hangs on the wall.",
            "AG.BAROS dropped behind the crates.",
            "He keeps landing his shots on the runner.",
            "She scored 3 kills in the late game.",
        ):
            with self.subTest(description=description):
                signals = entry_signals(
                    _entry("character", description, f"Visible: {description}")
                )
                self.assertNotIn("match_phase", signals["observed"])


class AdditiveTagTests(unittest.TestCase):
    def test_existing_tags_still_fire(self):
        cases = {
            "A knocked player is crawling in the center.": (
                "knockdown", "posture",
            ),
            "AG.BAROS firing near the ridge.": ("combat",),
            "The revive beam glows over the downed player.": ("revive",),
            "Blue Wall deployed at the ridge.": ("blue_wall",),
            "A grenade arcs over the wall.": ("grenade",),
            "Smoke covers the revive attempt.": ("smoke",),
            "A bike speeds down the road.": ("vehicle",),
            "The safe zone is shrinking fast.": ("zone",),
            "RRQ.JEEK eliminated OG.IQOOPAWDI.": ("elim",),
            "The squad is rotating to the next compound.": ("movement",),
            "Grass field and a road.": ("scenery",),
        }
        for description, tags in cases.items():
            with self.subTest(description=description):
                signals = entry_signals(
                    _entry("character", description, f"Visible: {description}")
                )
                for tag in tags:
                    self.assertIn(tag, signals["observed"])

    def test_entity_action_spatial_markers_still_fire(self):
        signals = entry_signals(
            _named_entry(
                "AG.BAROS firing near the ridge.",
                "AG.BAROS with muzzle flash at the ridge.",
                action="firing",
                spatial="near the ridge",
            )
        )
        self.assertIn("entity_mention", signals["observed"])
        self.assertIn("action_quoted", signals["observed"])
        self.assertIn("spatial_quoted", signals["observed"])


class PositionReconstructionTests(unittest.TestCase):
    def test_last_known_position_and_change_sequence(self):
        tracks = _tracked(
            _doc(
                0,
                [
                    _named_entry(
                        "AG.BAROS near the rock.",
                        "AG.BAROS by the rock.",
                        spatial="near the rock",
                    )
                ],
            ),
            _doc(
                3,
                [
                    _named_entry(
                        "AG.BAROS still Near the Rock.",
                        "AG.BAROS by the rock.",
                        spatial="Near the Rock",
                    )
                ],
            ),
            _doc(
                6,
                [
                    _named_entry(
                        "AG.BAROS behind the wall.",
                        "AG.BAROS behind the wall.",
                        spatial="behind the wall",
                    )
                ],
            ),
        )
        track = _labeled(tracks)
        self.assertEqual(track["last_known_position"], "behind the wall")
        self.assertEqual(
            [position["spatial"] for position in track["positions"]],
            ["near the rock", "behind the wall"],
        )
        self.assertEqual(
            [position["timestamp"] for position in track["positions"]], [0, 6]
        )
        self.assertEqual(
            track["movement"],
            {"from": "near the rock", "to": "behind the wall"},
        )

    def test_no_positions_when_nothing_quoted(self):
        tracks = _tracked(
            _doc(
                0,
                [
                    _named_entry(
                        "AG.BAROS near the rock.", "AG.BAROS by the rock."
                    )
                ],
            )
        )
        track = _labeled(tracks)
        self.assertIsNone(track["last_known_position"])
        self.assertEqual(track["positions"], [])
        self.assertIsNone(track["movement"])

    def test_occluded_track_keeps_last_known_position(self):
        tracks = _tracked(
            _doc(
                0,
                [
                    _named_entry(
                        "AG.BAROS near the rock.",
                        "AG.BAROS by the rock.",
                        spatial="near the rock",
                    )
                ],
            ),
            _doc(30, [_entry("environment", "Empty ridge.", "No figures.")]),
        )
        track = _labeled(tracks)
        self.assertEqual(track["status"], "occluded")
        self.assertEqual(track["last_known_position"], "near the rock")
        self.assertEqual(
            [position["spatial"] for position in track["positions"]],
            ["near the rock"],
        )


class EngagementTimelineTests(unittest.TestCase):
    def test_engagements_summarize_sightings_chronologically(self):
        tracks = _tracked(
            _doc(
                6,
                [
                    _named_entry(
                        "AG.BAROS firing behind the wall.",
                        "AG.BAROS muzzle flash.",
                        action="firing",
                        spatial="behind the wall",
                    )
                ],
            ),
            _doc(
                0,
                [
                    _named_entry(
                        "AG.BAROS crouching near the rock.",
                        "AG.BAROS by the rock.",
                        action="crouching",
                        spatial="near the rock",
                    )
                ],
            ),
        )
        track = _labeled(tracks)
        engagements = track["engagements"]
        self.assertEqual(
            [item["timestamp"] for item in engagements], [0, 6]
        )
        self.assertEqual(engagements[0]["action"], "crouching")
        self.assertEqual(engagements[0]["spatial"], "near the rock")
        self.assertEqual(engagements[0]["posture"], "crouching")
        self.assertIn("posture", engagements[0]["observed"])
        self.assertEqual(engagements[1]["action"], "firing")
        self.assertEqual(engagements[1]["spatial"], "behind the wall")
        self.assertIn("combat", engagements[1]["observed"])

    def test_unknown_tracks_get_single_item_timelines(self):
        tracks = _tracked(
            _doc(
                0,
                [_entry("character", "A player near the rock.", "Figure by rock.")],
            ),
            _doc(
                3,
                [_entry("character", "A player near the rock.", "Figure by rock.")],
            ),
        )
        self.assertEqual(len(tracks), 2)
        for track in tracks:
            self.assertEqual(track["identity"], "unknown")
            self.assertEqual(len(track["engagements"]), 1)
            self.assertEqual(
                track["engagements"][0]["timestamp"], track["first_seen"]
            )


class TrackingConfidenceTests(unittest.TestCase):
    def test_sightings_carry_entry_confidence(self):
        tracks = _tracked(
            _doc(
                0,
                [
                    _named_entry(
                        "AG.BAROS near the rock.",
                        "AG.BAROS by the rock.",
                        confidence="medium",
                    )
                ],
            )
        )
        track = _labeled(tracks)
        self.assertEqual(
            track["sightings"][0]["tracking_confidence"], "medium"
        )
        self.assertEqual(track["tracking_confidence"], "medium")

    def test_track_confidence_is_weakest_link(self):
        tracks = _tracked(
            _doc(
                0,
                [
                    _named_entry(
                        "AG.BAROS near the rock.",
                        "AG.BAROS by the rock.",
                        confidence="high",
                    )
                ],
            ),
            _doc(
                3,
                [
                    _named_entry(
                        "AG.BAROS behind the wall.",
                        "AG.BAROS behind the wall.",
                        confidence="low",
                    )
                ],
            ),
        )
        track = _labeled(tracks)
        self.assertEqual(
            [item["tracking_confidence"] for item in track["sightings"]],
            ["high", "low"],
        )
        self.assertEqual(track["tracking_confidence"], "low")

    def test_missing_confidence_fails_closed(self):
        accepted = _accepted(
            _doc(
                0,
                [
                    {
                        "category": "character",
                        "description": "AG.BAROS near the rock.",
                        "evidence": "AG.BAROS by the rock.",
                        "subjects": [
                            {"label": "AG.BAROS", "kind": "player"}
                        ],
                    }
                ],
            )
        )
        track = _labeled(build_entity_tracks(accepted))
        self.assertEqual(
            track["sightings"][0]["tracking_confidence"], "low"
        )
        self.assertEqual(track["tracking_confidence"], "low")


class ReconstructionCompatTests(unittest.TestCase):
    def test_reconstruction_is_order_independent(self):
        docs = [
            _doc(
                0,
                [
                    _named_entry(
                        "AG.BAROS firing near the rock.",
                        "AG.BAROS muzzle flash.",
                        action="firing",
                        spatial="near the rock",
                        confidence="medium",
                    )
                ],
            ),
            _doc(3, [_entry("environment", "Empty ridge.", "No figures.")]),
        ]
        forward = build_gameplay_state(
            _accepted(*docs), build_match_state(_accepted(*docs))
        )
        backward = build_gameplay_state(
            _accepted(*reversed(docs)), build_match_state(_accepted(*reversed(docs)))
        )
        self.assertEqual(forward, backward)

    def _old_shaped_track(self, **overrides):
        track = {
            "ref": "AG.BAROS",
            "kind": "player",
            "identity": "exact-label",
            "first_seen": 0,
            "last_seen": 3,
            "status": "observed",
            "posture": None,
            "movement": None,
            "sightings": [
                {
                    "timestamp": 0,
                    "source": "frame_00000.json",
                    "fact_key": ["character", "x"],
                    "spatial": "",
                    "action": "",
                    "posture": None,
                    "observed": [],
                }
            ],
        }
        track.update(overrides)
        return {
            "schema_version": "gameplay-v1",
            "latest_timestamp": 3,
            "fact_signals": [],
            "entities": [track],
            "summary": {
                "entity_count": 1,
                "unknown_sightings": 0,
                "combat_active": False,
                "moved_entities": [],
                "reappeared_entities": [],
                "occluded_entities": [],
            },
        }

    def test_old_shaped_tracks_still_validate(self):
        document = self._old_shaped_track()
        self.assertEqual(validate_gameplay(document), document)

    def test_new_fields_validated_when_present(self):
        with self.assertRaises(ObservationError):
            validate_gameplay(
                self._old_shaped_track(tracking_confidence="bogus")
            )
        with self.assertRaises(ObservationError):
            validate_gameplay(
                self._old_shaped_track(last_known_position=42)
            )
        with self.assertRaises(ObservationError):
            validate_gameplay(
                self._old_shaped_track(
                    positions=[
                        {
                            "timestamp": 0,
                            "source": "frame_00000.json",
                            "spatial": "",
                        }
                    ]
                )
            )
        with self.assertRaises(ObservationError):
            validate_gameplay(
                self._old_shaped_track(engagements="not-a-list")
            )
        bad_sighting = self._old_shaped_track()
        bad_sighting["entities"][0]["sightings"][0]["tracking_confidence"] = (
            "bogus"
        )
        with self.assertRaises(ObservationError):
            validate_gameplay(bad_sighting)


if __name__ == "__main__":
    unittest.main()
