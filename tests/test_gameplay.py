"""Gameplay interpretation layer: signals, entity tracks, gameplay-v1."""

import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))

from main import (
    ObservationError,
    build_entity_tracks,
    build_gameplay_state,
    build_match_state,
    entity_track_for_label,
    entry_signals,
    fact_signal_tags,
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


class EntrySignalTests(unittest.TestCase):
    def test_v2_structured_keys_contribute(self):
        signals = entry_signals(
            _entry(
                "character",
                "AG.BAROS firing near the ridge.",
                "AG.BAROS with muzzle flash at the ridge.",
                subjects=[{"label": "AG.BAROS", "kind": "player"}],
                action="firing",
                spatial="near the ridge",
            )
        )
        self.assertIn("entity_mention", signals["observed"])
        self.assertIn("action_quoted", signals["observed"])
        self.assertIn("spatial_quoted", signals["observed"])
        self.assertIn("combat", signals["observed"])
        self.assertEqual(
            signals["entities"], [{"label": "AG.BAROS", "kind": "player"}]
        )

    def test_bare_name_tokens_become_token_entities(self):
        signals = entry_signals(
            _entry(
                "hud",
                "Kill feed shows RRQ.JEEK over EVOS.RAJ.",
                "Feed line RRQ.JEEK over EVOS.RAJ.",
            )
        )
        labels = [entity["label"] for entity in signals["entities"]]
        self.assertEqual(labels, ["EVOS.RAJ", "RRQ.JEEK"])
        self.assertIn("entity_mention", signals["observed"])

    def test_v1_entries_without_optional_keys_work(self):
        signals = entry_signals(
            _entry("environment", "Grass field and a road.", "Green field, grey road.")
        )
        self.assertIn("scenery", signals["observed"])
        self.assertEqual(signals["entities"], [])
        self.assertIsNone(signals["posture"])

    def test_posture_and_knockdown_words(self):
        signals = entry_signals(
            _entry(
                "character",
                "A knocked player is crawling in the center.",
                "Player prone, crawling in the center.",
            )
        )
        self.assertIn("knockdown", signals["observed"])
        self.assertIn("posture", signals["observed"])
        self.assertNotIn("elim", signals["observed"])
        self.assertEqual(signals["posture"], "crawling")

    def test_knockdown_never_matches_elim(self):
        signals = entry_signals(
            _entry(
                "character",
                "AG.BAROS knocked down behind cover.",
                "AG.BAROS down behind cover.",
            )
        )
        self.assertIn("knockdown", signals["observed"])
        self.assertNotIn("elim", signals["observed"])

    def test_blue_wall_grenade_smoke_vehicle_zone(self):
        cases = {
            "Blue Wall deployed at the ridge.": "blue_wall",
            "Gloo Wall blocking the doorway.": "blue_wall",
            "A grenade arcs over the wall.": "grenade",
            "Smoke covers the revive attempt.": "smoke",
            "A bike speeds down the road.": "vehicle",
            "The safe zone is shrinking fast.": "zone",
        }
        for description, tag in cases.items():
            with self.subTest(description=description):
                signals = entry_signals(
                    _entry("combat", description, f"Visible: {description}")
                )
                self.assertIn(tag, signals["observed"])

    def test_blue_wall_is_not_a_shield_match(self):
        signals = entry_signals(
            _entry("combat", "A shield wall glows blue.", "Blue glow effect.")
        )
        self.assertNotIn("blue_wall", signals["observed"])

    def test_inferred_cues_require_entity_plus_context(self):
        combat_only = entry_signals(
            _entry("combat", "Distant gunfire flashes.", "Flashes on the ridge.")
        )
        self.assertIn("combat", combat_only["observed"])
        self.assertNotIn("possible_engagement_cue", combat_only["inferred"])
        combat_entity = entry_signals(
            _entry(
                "combat",
                "AG.BAROS firing at the ridge.",
                "AG.BAROS muzzle flashes.",
                subjects=[{"label": "AG.BAROS", "kind": "player"}],
            )
        )
        self.assertIn("possible_engagement_cue", combat_entity["inferred"])


class EntityTrackTests(unittest.TestCase):
    def test_exact_label_groups_sightings(self):
        accepted = _accepted(
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
        tracks = build_entity_tracks(accepted)
        self.assertEqual(len(tracks), 1)
        track = tracks[0]
        self.assertEqual(track["ref"], "AG.BAROS")
        self.assertEqual(track["identity"], "exact-label")
        self.assertEqual(track["status"], "observed")
        self.assertEqual(
            track["movement"], {"from": "near the rock", "to": "behind the wall"}
        )

    def test_similar_labels_never_merge(self):
        accepted = _accepted(
            _doc(
                0,
                [
                    _entry(
                        "character",
                        "AG.BAROS near the rock.",
                        "AG.BAROS by the rock.",
                        subjects=[{"label": "AG.BAROS", "kind": "player"}],
                    ),
                    _entry(
                        "character",
                        "AG.BARON near the rock.",
                        "AG.BARON by the rock.",
                        subjects=[{"label": "AG.BARON", "kind": "player"}],
                    ),
                ],
            )
        )
        tracks = build_entity_tracks(accepted)
        self.assertEqual(
            sorted(track["ref"] for track in tracks), ["AG.BARON", "AG.BAROS"]
        )

    def test_unlabeled_sightings_never_link(self):
        accepted = _accepted(
            _doc(
                0,
                [_entry("character", "A player near the rock.", "Figure by rock.")],
            ),
            _doc(
                3,
                [_entry("character", "A player near the rock.", "Figure by rock.")],
            ),
        )
        tracks = build_entity_tracks(accepted)
        self.assertEqual(len(tracks), 2)
        self.assertTrue(all(track["identity"] == "unknown" for track in tracks))
        self.assertTrue(all(len(track["sightings"]) == 1 for track in tracks))

    def test_gap_means_occluded_not_eliminated(self):
        accepted = _accepted(
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
            _doc(
                30,
                [_entry("environment", "Empty ridge.", "No figures visible.")],
            ),
        )
        tracks = build_entity_tracks(accepted)
        labeled = [track for track in tracks if track["identity"] == "exact-label"]
        self.assertEqual(len(labeled), 1)
        self.assertEqual(labeled[0]["status"], "occluded")

    def test_return_after_gap_is_reappeared(self):
        accepted = _accepted(
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
            _doc(
                30,
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
        tracks = build_entity_tracks(accepted)
        labeled = [track for track in tracks if track["identity"] == "exact-label"]
        self.assertEqual(labeled[0]["status"], "reappeared")

    def test_identical_spatial_is_not_movement(self):
        accepted = _accepted(
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
                        "AG.BAROS still near the rock.",
                        "AG.BAROS by the rock.",
                        subjects=[{"label": "AG.BAROS", "kind": "player"}],
                        spatial="near the rock",
                    )
                ],
            ),
        )
        tracks = build_entity_tracks(accepted)
        self.assertEqual(len(tracks), 1)
        self.assertIsNone(tracks[0]["movement"])

    def test_tracks_are_order_independent(self):
        docs = [
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
            _doc(
                3,
                [_entry("environment", "Empty ridge.", "No figures visible.")],
            ),
        ]
        forward = build_entity_tracks(_accepted(*docs))
        backward = build_entity_tracks(_accepted(*reversed(docs)))
        self.assertEqual(forward, backward)


class GameplayStateTests(unittest.TestCase):
    def test_build_gameplay_state_validates_and_indexes_fact_keys(self):
        accepted = _accepted(
            _doc(
                0,
                [
                    _entry(
                        "character",
                        "AG.BAROS firing near the ridge.",
                        "AG.BAROS muzzle flash.",
                        subjects=[{"label": "AG.BAROS", "kind": "player"}],
                        action="firing",
                    )
                ],
            )
        )
        state = build_match_state(accepted)
        gameplay = build_gameplay_state(accepted, state)
        self.assertEqual(gameplay["schema_version"], "gameplay-v1")
        tags = fact_signal_tags(
            gameplay, "character", "AG.BAROS firing near the ridge."
        )
        self.assertIn("combat", tags["observed"])
        self.assertIn("entity_mention", tags["observed"])
        self.assertEqual(gameplay["summary"]["entity_count"], 1)
        self.assertTrue(gameplay["summary"]["combat_active"])
        track = entity_track_for_label(gameplay, "AG.BAROS")
        self.assertIsNotNone(track)
        self.assertIsNone(entity_track_for_label(gameplay, "AG.BARON"))

    def test_unknown_fact_key_yields_empty_tags(self):
        accepted = _accepted(_doc(0, [_entry("hud", "Elim 4.", "Elim 4.")]))
        state = build_match_state(accepted)
        gameplay = build_gameplay_state(accepted, state)
        self.assertEqual(
            fact_signal_tags(gameplay, "character", "Never seen."),
            {"observed": [], "inferred": [], "entities": []},
        )

    def test_gameplay_document_is_deterministic(self):
        docs = [
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
            _doc(3, [_entry("environment", "Empty ridge.", "No figures.")]),
        ]
        first = build_gameplay_state(
            _accepted(*docs), build_match_state(_accepted(*docs))
        )
        second = build_gameplay_state(
            _accepted(*reversed(docs)), build_match_state(_accepted(*reversed(docs)))
        )
        self.assertEqual(first, second)

    def test_validate_gameplay_rejects_bad_documents(self):
        with self.assertRaises(ObservationError):
            validate_gameplay({"schema_version": "gameplay-v1"})
        with self.assertRaises(ObservationError):
            validate_gameplay(
                {
                    "schema_version": "gameplay-v1",
                    "latest_timestamp": None,
                    "fact_signals": [],
                    "entities": [
                        {
                            "ref": "AG.BAROS",
                            "kind": "player",
                            "identity": "exact-label",
                            "first_seen": 0,
                            "last_seen": 3,
                            "status": "eliminated",
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
                    ],
                    "summary": {
                        "entity_count": 1,
                        "unknown_sightings": 0,
                        "combat_active": False,
                        "moved_entities": [],
                        "reappeared_entities": [],
                        "occluded_entities": [],
                    },
                }
            )


if __name__ == "__main__":
    unittest.main()
