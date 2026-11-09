"""Deterministic fixtures for observation-v3 parsing and validation.

No live API calls. The legacy v1/v2 pipeline is untouched: v1/v2
fixtures still validate, and v3 documents are rejected by the legacy
validator.
"""

import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))

from ai_commentator.config import (
    OBSERVATION_SCHEMA_VERSIONS,
    OBSERVATION_V3_CONFIDENCES,
    OBSERVATION_V3_CUES,
    OBSERVATION_V3_SCENES,
    OBSERVATION_V3_STATES,
)
from ai_commentator.errors import ObservationError
from ai_commentator.prompts import get_factory_pack
from ai_commentator.vision.observations import validate_observation
from ai_commentator.vision.observations_v3 import (
    parse_observation_v3,
    validate_observation_v3,
)

VALID = {
    "schema_version": "observation-v3",
    "timestamp": 12.5,
    "scene": "gameplay",
    "round": {"timer": "01:23", "timer_red": False, "round_no": 2},
    "teams": [
        {"id": "A", "color": "blue", "score": 1, "alive": 4, "total": 4},
        {"id": "B", "color": "red", "score": 0, "alive": 3, "total": 4},
    ],
    "focus": {
        "name": "VORCA_Raj",
        "team": "A",
        "weapon": "M1887",
        "state": "alive",
        "hp_pct": 80,
    },
    "in_view": [{"name": None, "team": "B", "state": "alive"}],
    "cues": [{"cue": "muzzle_flash", "evidence": "yellow flash at weapon muzzle"}],
    "notes": "VORCA_Raj holds the lane with an M1887.",
    "confidence": "high",
}

LOBBY = {
    "schema_version": "observation-v3",
    "timestamp": 0.0,
    "scene": "lobby",
    "round": {"timer": None, "timer_red": False, "round_no": None},
    "teams": [],
    "focus": None,
    "in_view": [],
    "cues": [],
    "notes": None,
    "confidence": "high",
}

V1 = {
    "schema_version": "observation-v1",
    "timestamp": 0,
    "observations": [
        {
            "category": "hud",
            "description": "Kill counter in the top bar.",
            "confidence": "medium",
            "evidence": "Digits in the top-center bar.",
        }
    ],
    "uncertainties": [],
}

V2 = {
    "schema_version": "observation-v2",
    "timestamp": 3,
    "observations": [
        {
            "category": "hud",
            "description": "Team AG panel header Elim 4, bottom-left.",
            "confidence": "high",
            "evidence": "Header text Elim 4 in the team AG panel.",
            "subjects": [{"label": "AG", "kind": "team"}],
            "action": "Elim 4",
            "spatial": "bottom-left",
        }
    ],
    "uncertainties": [],
}


def valid():
    return copy.deepcopy(VALID)


class ParseV3Tests(unittest.TestCase):
    def test_valid_json_object(self):
        doc = parse_observation_v3(
            '{"schema_version": "observation-v3", "timestamp": 1.5, '
            '"scene": "menu", "round": {"timer": null, "timer_red": false, '
            '"round_no": null}, "teams": [], "focus": null, "in_view": [], '
            '"cues": [], "notes": null, "confidence": "low"}'
        )
        self.assertEqual(validate_observation_v3(doc)["scene"], "menu")

    def test_fenced_json_tolerated(self):
        doc = parse_observation_v3(
            '```json\n{"schema_version": "observation-v3", '
            '"timestamp": 1.5, "scene": "menu", "round": {"timer": null, '
            '"timer_red": false, "round_no": null}, "teams": [], '
            '"focus": null, "in_view": [], "cues": [], "notes": null, '
            '"confidence": "low"}\n```'
        )
        self.assertEqual(validate_observation_v3(doc)["confidence"], "low")

    def test_empty_text_rejected(self):
        with self.assertRaises(ObservationError):
            parse_observation_v3("   ")


class ValidV3Tests(unittest.TestCase):
    def test_mid_fight_example_passes(self):
        self.assertEqual(validate_observation_v3(valid()), VALID)

    def test_quiet_lobby_example_passes(self):
        self.assertEqual(
            validate_observation_v3(copy.deepcopy(LOBBY)), LOBBY
        )

    def test_boundary_values_pass(self):
        doc = valid()
        doc["timestamp"] = 0
        doc["round"]["timer"] = "1:23"
        doc["teams"][0]["alive"] = 4
        doc["teams"][0]["total"] = 4
        doc["focus"]["hp_pct"] = 0
        doc["in_view"].append({"name": "ZED.KA", "team": None, "state": "dead"})
        doc["cues"].append(
            {"cue": "smoke", "evidence": "one two three four five six seven eight nine ten eleven twelve"}
        )
        doc["notes"] = "x" * 140
        self.assertEqual(validate_observation_v3(doc)["focus"]["hp_pct"], 0)

    def test_hp_hundred_passes(self):
        doc = valid()
        doc["focus"]["hp_pct"] = 100
        validate_observation_v3(doc)


class RejectionTests(unittest.TestCase):
    def test_wrong_schema_version_rejected(self):
        doc = valid()
        doc["schema_version"] = "observation-v2"
        with self.assertRaises(ObservationError):
            validate_observation_v3(doc)

    def test_top_level_extra_field_rejected(self):
        doc = valid()
        doc["observations"] = []
        with self.assertRaises(ObservationError):
            validate_observation_v3(doc)

    def test_missing_top_level_field_rejected(self):
        doc = valid()
        del doc["confidence"]
        with self.assertRaises(ObservationError):
            validate_observation_v3(doc)

    def test_bad_timestamp_rejected(self):
        for bad in (True, "12.5", float("nan")):
            with self.subTest(bad=bad):
                doc = valid()
                doc["timestamp"] = bad
                with self.assertRaises(ObservationError):
                    validate_observation_v3(doc)

    def test_bad_scene_rejected(self):
        doc = valid()
        doc["scene"] = "gameplay2"
        with self.assertRaises(ObservationError):
            validate_observation_v3(doc)

    def test_round_must_be_object(self):
        doc = valid()
        doc["round"] = None
        with self.assertRaises(ObservationError):
            validate_observation_v3(doc)

    def test_round_extra_field_rejected(self):
        doc = valid()
        doc["round"]["overtime"] = False
        with self.assertRaises(ObservationError):
            validate_observation_v3(doc)

    def test_bad_timer_rejected(self):
        for bad in ("123", "1:2", "01:234", 83):
            with self.subTest(bad=bad):
                doc = valid()
                doc["round"]["timer"] = bad
                with self.assertRaises(ObservationError):
                    validate_observation_v3(doc)

    def test_non_bool_timer_red_rejected(self):
        for bad in (1, "false", None):
            with self.subTest(bad=bad):
                doc = valid()
                doc["round"]["timer_red"] = bad
                with self.assertRaises(ObservationError):
                    validate_observation_v3(doc)

    def test_non_int_round_no_rejected(self):
        for bad in (2.5, True, "2"):
            with self.subTest(bad=bad):
                doc = valid()
                doc["round"]["round_no"] = bad
                with self.assertRaises(ObservationError):
                    validate_observation_v3(doc)

    def test_teams_must_be_list(self):
        doc = valid()
        doc["teams"] = {}
        with self.assertRaises(ObservationError):
            validate_observation_v3(doc)

    def test_team_extra_field_rejected(self):
        doc = valid()
        doc["teams"][0]["coach"] = "x"
        with self.assertRaises(ObservationError):
            validate_observation_v3(doc)

    def test_empty_team_id_rejected(self):
        doc = valid()
        doc["teams"][0]["id"] = "  "
        with self.assertRaises(ObservationError):
            validate_observation_v3(doc)

    def test_duplicate_team_ids_rejected(self):
        doc = valid()
        doc["teams"][1]["id"] = "A"
        with self.assertRaises(ObservationError):
            validate_observation_v3(doc)

    def test_empty_team_color_rejected(self):
        doc = valid()
        doc["teams"][0]["color"] = ""
        with self.assertRaises(ObservationError):
            validate_observation_v3(doc)

    def test_non_int_team_numbers_rejected(self):
        for field, bad in (("score", 1.5), ("alive", True), ("total", "4")):
            with self.subTest(field=field, bad=bad):
                doc = valid()
                doc["teams"][0][field] = bad
                with self.assertRaises(ObservationError):
                    validate_observation_v3(doc)

    def test_alive_above_total_rejected(self):
        doc = valid()
        doc["teams"][0]["alive"] = 5
        with self.assertRaises(ObservationError):
            validate_observation_v3(doc)

    def test_focus_must_be_object_or_null(self):
        doc = valid()
        doc["focus"] = "VORCA_Raj"
        with self.assertRaises(ObservationError):
            validate_observation_v3(doc)

    def test_focus_extra_field_rejected(self):
        doc = valid()
        doc["focus"]["kills"] = 0
        with self.assertRaises(ObservationError):
            validate_observation_v3(doc)

    def test_bad_focus_state_rejected(self):
        doc = valid()
        doc["focus"]["state"] = "flying"
        with self.assertRaises(ObservationError):
            validate_observation_v3(doc)

    def test_hp_out_of_range_rejected(self):
        for bad in (-1, 101):
            with self.subTest(bad=bad):
                doc = valid()
                doc["focus"]["hp_pct"] = bad
                with self.assertRaises(ObservationError):
                    validate_observation_v3(doc)

    def test_non_int_hp_rejected(self):
        for bad in (80.5, True, "80"):
            with self.subTest(bad=bad):
                doc = valid()
                doc["focus"]["hp_pct"] = bad
                with self.assertRaises(ObservationError):
                    validate_observation_v3(doc)

    def test_in_view_must_be_list(self):
        doc = valid()
        doc["in_view"] = {}
        with self.assertRaises(ObservationError):
            validate_observation_v3(doc)

    def test_in_view_entry_shape_rejected(self):
        doc = valid()
        doc["in_view"][0]["state"] = "ghost"
        with self.assertRaises(ObservationError):
            validate_observation_v3(doc)
        doc = valid()
        doc["in_view"][0]["extra"] = 1
        with self.assertRaises(ObservationError):
            validate_observation_v3(doc)

    def test_cues_must_be_list(self):
        doc = valid()
        doc["cues"] = {}
        with self.assertRaises(ObservationError):
            validate_observation_v3(doc)

    def test_cue_entry_extra_field_rejected(self):
        doc = valid()
        doc["cues"][0]["at"] = 1.0
        with self.assertRaises(ObservationError):
            validate_observation_v3(doc)

    def test_bad_cue_rejected(self):
        doc = valid()
        doc["cues"][0]["cue"] = "explosion"
        with self.assertRaises(ObservationError):
            validate_observation_v3(doc)

    def test_bad_evidence_rejected(self):
        doc = valid()
        doc["cues"][0]["evidence"] = "  "
        with self.assertRaises(ObservationError):
            validate_observation_v3(doc)
        doc = valid()
        doc["cues"][0]["evidence"] = " ".join(f"w{i}" for i in range(13))
        with self.assertRaises(ObservationError):
            validate_observation_v3(doc)

    def test_bad_notes_rejected(self):
        doc = valid()
        doc["notes"] = ""
        with self.assertRaises(ObservationError):
            validate_observation_v3(doc)
        doc = valid()
        doc["notes"] = "x" * 141
        with self.assertRaises(ObservationError):
            validate_observation_v3(doc)

    def test_bad_confidence_rejected(self):
        doc = valid()
        doc["confidence"] = "certain"
        with self.assertRaises(ObservationError):
            validate_observation_v3(doc)


class CueEnumTests(unittest.TestCase):
    def test_default_enum_matches_contract(self):
        self.assertEqual(
            OBSERVATION_V3_CUES,
            (
                "muzzle_flash", "tracer", "knock_indicator",
                "elimination_banner", "kill_feed_entry", "damage_numbers",
                "grenade", "smoke", "zone_shrinking", "revive", "vehicle",
                "victory_banner", "defeat_banner", "round_start", "round_end",
            ),
        )
        self.assertEqual(
            OBSERVATION_V3_SCENES,
            (
                "gameplay", "spectate", "lobby", "loading", "results",
                "menu", "cutscene", "unknown",
            ),
        )
        self.assertEqual(
            OBSERVATION_V3_STATES, ("alive", "knocked", "spectating", "dead")
        )
        self.assertEqual(OBSERVATION_V3_CONFIDENCES, ("high", "medium", "low"))

    def test_pack_configured_enum_overrides_default(self):
        doc = valid()
        doc["cues"] = [{"cue": "airstrike", "evidence": "jet streak overhead"}]
        with self.assertRaises(ObservationError):
            validate_observation_v3(doc)
        validate_observation_v3(doc, allowed_cues=("airstrike",))
        with self.assertRaises(ObservationError):
            validate_observation_v3(valid(), allowed_cues=("airstrike",))


class LegacySeparationTests(unittest.TestCase):
    def test_v1_and_v2_still_validate(self):
        self.assertEqual(
            validate_observation(copy.deepcopy(V1))["schema_version"],
            "observation-v1",
        )
        self.assertEqual(
            validate_observation(copy.deepcopy(V2))["schema_version"],
            "observation-v2",
        )

    def test_v3_rejected_by_legacy_validator(self):
        with self.assertRaises(ObservationError):
            validate_observation(valid())

    def test_v1_rejected_by_v3_validator(self):
        with self.assertRaises(ObservationError):
            validate_observation_v3(copy.deepcopy(V1))

    def test_v3_not_in_legacy_version_tuple(self):
        self.assertNotIn("observation-v3", OBSERVATION_SCHEMA_VERSIONS)


class PackFieldTests(unittest.TestCase):
    def test_broadcast_prompt_present_in_every_pack(self):
        for pack_id in ("free-fire", "cod", "bgmi"):
            with self.subTest(pack=pack_id):
                text = get_factory_pack(pack_id)["fields"][
                    "broadcast_vision_prompt"
                ]
                self.assertIn("You are reading a broadcast overlay.", text)
                self.assertIn("Output ONLY the JSON schema.", text)
                self.assertIn("Use null when a value is not visible", text)


if __name__ == "__main__":
    unittest.main()
