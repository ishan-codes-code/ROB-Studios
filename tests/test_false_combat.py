"""False-combat and scenery-spam fixes on the recorded path.

Negated wording ("No muzzle flash, ...") must not tag combat;
substring accidents ("carpet" -> vehicle) must not tag; Blue Wall
cover notes must not become producer beats; unknown tracks must not
inflate the narrative's out-of-view count. Offline, no model calls.
"""

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))

import main as engine

FIXTURE_DIR = (
    Path(__file__).resolve().parent / "fixtures" / "real_clash_squad_run1"
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


def _load_fixture():
    manifest = json.loads(
        (FIXTURE_DIR / "adaptive_run.json").read_text(encoding="utf-8")
    )
    loaded = []
    for iteration in manifest["iterations"]:
        doc = json.loads(
            (FIXTURE_DIR / iteration["observation_file"]).read_text(
                encoding="utf-8"
            )
        )
        loaded.append(
            (
                iteration["timestamp"],
                iteration["observation_file"],
                engine.validate_observation(doc),
            )
        )
    return loaded


class NegationGuardTests(unittest.TestCase):
    def test_negated_combat_list_yields_no_tags(self):
        signals = engine.entry_signals(
            _entry(
                "combat",
                "No muzzle flash, tracer, grenade, smoke or vehicle",
                "Clear view of the empty yard.",
            )
        )
        self.assertEqual(signals["observed"], [])

    def test_carpet_of_leaves_yields_no_tags(self):
        signals = engine.entry_signals(
            _entry(
                "environment",
                "A carpet of leaves covers the ground",
                "Woven carpet under fallen leaves.",
            )
        )
        self.assertEqual(signals["observed"], [])

    def test_finished_looting_has_no_elim_tag(self):
        signals = engine.entry_signals(
            _entry(
                "character",
                "The player finished looting the crate",
                "Player closing the looted crate.",
            )
        )
        self.assertNotIn("elim", signals["observed"])
        # Narrow removal: gear wording still tags equipment.
        self.assertIn("equipment", signals["observed"])

    def test_knocked_down_still_knockdown(self):
        signals = engine.entry_signals(
            _entry(
                "character",
                "Enemy knocked down near the window",
                "Enemy prone by the window.",
            )
        )
        self.assertIn("knockdown", signals["observed"])
        self.assertNotIn("elim", signals["observed"])

    def test_firing_rifle_still_combat(self):
        signals = engine.entry_signals(
            _entry(
                "combat",
                "firing a rifle toward a building",
                "Muzzle flash at the window.",
            )
        )
        self.assertIn("combat", signals["observed"])
        self.assertIn("weapon", signals["observed"])

    def test_mid_sentence_negation_list_keeps_leading_positive(self):
        signals = engine.entry_signals(
            _entry(
                "combat",
                "Bright firing glow with no clearly visible grenade "
                "arc, explosion, distinct smoke plume, or vehicle",
                "Glow at the wall base.",
            )
        )
        self.assertIn("combat", signals["observed"])
        for tag in ("grenade", "smoke", "vehicle"):
            self.assertNotIn(tag, signals["observed"])

    def test_negated_clause_after_but_still_matches(self):
        # Note: a description *opening* with "No" loses combat tags via
        # the description rule; "but" only rescues a later clause when
        # the description itself does not open negated.
        signals = engine.entry_signals(
            _entry(
                "combat",
                "The view shows no smoke, but firing continues",
                "Flashes past the wall.",
            )
        )
        self.assertIn("combat", signals["observed"])
        self.assertNotIn("smoke", signals["observed"])


class UnknownTrackTests(unittest.TestCase):
    def _bundle(self):
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
                        "A player near the rock.",
                        "Figure by rock.",
                    ),
                ],
            ),
            _doc(30, [_entry("environment", "Empty ridge.", "No figures.")]),
        )
        state = engine.build_match_state(accepted)
        events, _ = engine.detect_events(accepted, state)
        gameplay = engine.build_gameplay_state(accepted, state)
        return accepted, state, events, gameplay

    def test_unknown_tracks_excluded_from_occluded(self):
        _, _, _, gameplay = self._bundle()
        occluded = gameplay["summary"]["occluded_entities"]
        self.assertIn("AG.BAROS", occluded)
        self.assertFalse(
            [ref for ref in occluded if ref.startswith("unknown-")]
        )
        # Raw tracks are unchanged: the unknown sighting still exists.
        refs = [track["ref"] for track in gameplay["entities"]]
        self.assertTrue([ref for ref in refs if ref.startswith("unknown-")])

    def test_narrative_count_excludes_unknown(self):
        accepted, state, events, gameplay = self._bundle()
        narrative = engine.build_narrative(gameplay, state, events, [])
        situation = " ".join(narrative["situation"])
        self.assertIn("1 tracked entity out of view.", situation)


class CombatActiveNarrativeTests(unittest.TestCase):
    def test_stale_combat_wording_says_no_combat(self):
        accepted = _accepted(
            _doc(
                0,
                [
                    _entry(
                        "combat",
                        "AG.BAROS firing at the ridge.",
                        "Muzzle flashes.",
                    )
                ],
            ),
            _doc(30, [_entry("environment", "Empty ridge.", "No figures.")]),
        )
        state = engine.build_match_state(accepted)
        events, _ = engine.detect_events(accepted, state)
        gameplay = engine.build_gameplay_state(accepted, state)
        narrative = engine.build_narrative(gameplay, state, events, [])
        situation = " ".join(narrative["situation"])
        self.assertIn("No combat in the latest observations.", situation)


class EntryNegationTests(unittest.TestCase):
    def test_entry_wording_negated(self):
        negated = [
            ("No muzzle flash is visible.", "Clear sky."),
            ("Muzzle flash is not clearly visible.", "Dark ridge."),
            ("The view shows no firing.", "Dark ridge."),
        ]
        for description, evidence in negated:
            with self.subTest(description=description):
                self.assertTrue(
                    engine.entry_wording_negated(
                        _entry("combat", description, evidence)
                    )
                )
        present = [
            ("Blue Wall deployed at the ridge.", "Wall segments."),
            (
                "Bright firing glow with no clearly visible grenade.",
                "Glow at the wall base.",
            ),
        ]
        for description, evidence in present:
            with self.subTest(description=description):
                self.assertFalse(
                    engine.entry_wording_negated(
                        _entry("combat", description, evidence)
                    )
                )


class FixtureEngagementTests(unittest.TestCase):
    # combat_engagement count on the fixture before the sighting fix,
    # measured with replay_legacy.py (final window) and detect_events.
    PRE_FIX_COMBAT_ENGAGEMENTS = 4

    def test_fewer_combat_engagements_than_baseline(self):
        accepted = _load_fixture()
        state = engine.build_match_state(accepted)
        events, _ = engine.detect_events(accepted, state)
        count = sum(
            1 for event in events["events"]
            if event["type"] == "combat_engagement"
        )
        self.assertLess(count, self.PRE_FIX_COMBAT_ENGAGEMENTS)


class FixtureProducerTests(unittest.TestCase):
    def test_no_blue_wall_use_beat_on_fixture(self):
        accepted = _load_fixture()
        state = engine.build_match_state(accepted)
        events, _ = engine.detect_events(accepted, state)
        claims, _ = engine.gate_commentary_claims(accepted, state, events)
        gameplay = engine.build_gameplay_state(accepted, state)
        beats = engine.produce_beats(gameplay, state, events, claims, [])
        blue_wall_claims = {
            engine.claim_id_of(claim)
            for claim in claims
            if claim.get("rule") == "blue_wall_use"
        }
        self.assertTrue(blue_wall_claims, "fixture must still gate cover claims")
        beaten = {
            claim_id
            for beat in beats
            for claim_id in beat["source_claim_ids"]
        }
        self.assertTrue(beats, "fixture must still produce beats")
        self.assertEqual(beaten & blue_wall_claims, set())

    def test_no_negation_worded_beat_on_fixture(self):
        accepted = _load_fixture()
        state = engine.build_match_state(accepted)
        events, _ = engine.detect_events(accepted, state)
        claims, _ = engine.gate_commentary_claims(accepted, state, events)
        gameplay = engine.build_gameplay_state(accepted, state)
        beats = engine.produce_beats(gameplay, state, events, claims, [])
        self.assertTrue(beats, "fixture must still produce beats")
        negated = [
            beat["what"] for beat in beats if beat["what"].startswith("No ")
        ]
        self.assertEqual(negated, [])


if __name__ == "__main__":
    unittest.main()
