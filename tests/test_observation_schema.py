"""Deterministic fixtures for observation-v1 parsing and validation.

No live API calls. Run natively from the repository root:
    .venv/bin/python -m unittest discover -s tests -v
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))

from main import (
    OBSERVATION_CATEGORIES,
    OBSERVATION_CONFIDENCES,
    OBSERVATION_SCHEMA_VERSION,
    OBSERVATION_SCHEMA_VERSION_V2,
    ObservationError,
    build_previous_context,
    build_vision_prompt,
    parse_observation,
    validate_observation,
    vision_frame_timestamp,
)

VALID = {
    "schema_version": "observation-v1",
    "timestamp": 0,
    "observations": [
        {
            "category": "hud",
            "description": "Kill counter in the top bar.",
            "confidence": "medium",
            "evidence": "Digits in the top-center bar, partly obscured.",
        },
        {
            "category": "environment",
            "description": "Grassy field with crates.",
            "confidence": "high",
            "evidence": "Green ground plane and wooden crates left of center.",
        },
    ],
    "uncertainties": ["Player name text is too small to read."],
}

EMPTY_VALID = {
    "schema_version": "observation-v1",
    "timestamp": 0,
    "observations": [],
    "uncertainties": ["Frame is black; nothing describable."],
}


def mutate(doc, **overrides):
    merged = dict(doc)
    merged.update(overrides)
    return merged


class ParseObservationTests(unittest.TestCase):
    def test_valid_json_object(self):
        self.assertEqual(
            parse_observation(
                '{"schema_version": "observation-v1", "timestamp": 0, '
                '"observations": [], "uncertainties": []}'
            )["schema_version"],
            "observation-v1",
        )

    def test_fenced_json_tolerated(self):
        self.assertEqual(
            validate_observation(
                parse_observation(
                    '```json\n{"schema_version": "observation-v1", '
                    '"timestamp": 0, "observations": [], '
                    '"uncertainties": []}\n```'
                )
            )["observations"],
            [],
        )

    def test_empty_output_rejected(self):
        for text in ("", "   ", None):
            with self.assertRaises(ObservationError, msg=repr(text)):
                parse_observation(text)

    def test_malformed_json_rejected(self):
        with self.assertRaises(ObservationError):
            parse_observation('{"schema_version": ')

    def test_non_object_top_level_rejected(self):
        for text in ("[1, 2]", '"just a string"', "42"):
            with self.assertRaises(ObservationError, msg=text):
                parse_observation(text)

    def test_prose_rejected(self):
        with self.assertRaises(ObservationError):
            parse_observation("The frame shows a grassy field.")


class ValidateObservationTests(unittest.TestCase):
    def test_valid_document_passes(self):
        self.assertEqual(validate_observation(VALID)["observations"][0]["category"], "hud")

    def test_empty_observations_allowed_with_reason(self):
        self.assertEqual(validate_observation(EMPTY_VALID)["uncertainties"], [
            "Frame is black; nothing describable."
        ])

    def test_missing_fields_rejected(self):
        for field in ("schema_version", "timestamp", "observations", "uncertainties"):
            doc = {k: v for k, v in VALID.items() if k != field}
            with self.assertRaises(ObservationError, msg=field):
                validate_observation(doc)

    def test_wrong_schema_version_rejected(self):
        with self.assertRaises(ObservationError):
            validate_observation(mutate(VALID, schema_version="observation-v3"))
        with self.assertRaises(ObservationError):
            validate_observation(mutate(VALID, schema_version=""))

    def test_bad_timestamp_rejected(self):
        for bad in ("0", True, None, float("nan"), [0], {"t": 0}):
            with self.assertRaises(ObservationError, msg=repr(bad)):
                validate_observation(mutate(VALID, timestamp=bad))

    def test_float_timestamp_accepted(self):
        self.assertEqual(
            validate_observation(mutate(VALID, timestamp=3.5))["timestamp"], 3.5
        )

    def test_unsupported_category_rejected(self):
        doc = dict(VALID)
        doc["observations"] = [dict(VALID["observations"][0], category="killfeed")]
        with self.assertRaises(ObservationError):
            validate_observation(doc)

    def test_invalid_confidence_rejected(self):
        doc = dict(VALID)
        doc["observations"] = [dict(VALID["observations"][0], confidence="certain")]
        with self.assertRaises(ObservationError):
            validate_observation(doc)

    def test_empty_description_or_evidence_rejected(self):
        for field in ("description", "evidence"):
            doc = dict(VALID)
            doc["observations"] = [dict(VALID["observations"][0], **{field: "  "})]
            with self.assertRaises(ObservationError, msg=field):
                validate_observation(doc)

    def test_non_object_observation_rejected(self):
        with self.assertRaises(ObservationError):
            validate_observation(mutate(VALID, observations=["hud"]))

    def test_extra_fields_rejected(self):
        with self.assertRaises(ObservationError):
            validate_observation(mutate(VALID, reasoning="extra top-level"))
        doc = dict(VALID)
        doc["observations"] = [dict(VALID["observations"][0], score=0.9)]
        with self.assertRaises(ObservationError):
            validate_observation(doc)

    def test_bad_uncertainties_rejected(self):
        with self.assertRaises(ObservationError):
            validate_observation(mutate(VALID, uncertainties="unsure"))
        with self.assertRaises(ObservationError):
            validate_observation(mutate(VALID, uncertainties=["  "]))
        with self.assertRaises(ObservationError):
            validate_observation(mutate(VALID, uncertainties=[42]))

    def test_non_dict_rejected(self):
        for bad in ([], "x", None, 42):
            with self.assertRaises(ObservationError, msg=repr(bad)):
                validate_observation(bad)


class PromptTests(unittest.TestCase):
    def test_prompt_names_schema_and_enums(self):
        prompt = build_vision_prompt(0)
        self.assertIn(OBSERVATION_SCHEMA_VERSION_V2, prompt)
        for category in OBSERVATION_CATEGORIES:
            self.assertIn(category, prompt)
        for confidence in OBSERVATION_CONFIDENCES:
            self.assertIn(confidence, prompt)
        self.assertIn("0 seconds", prompt)

    def test_frame_timestamp_matches_single_frame(self):
        self.assertEqual(vision_frame_timestamp(), 0)


def v2_item(category, description, confidence="high",
            evidence="Fixture evidence.", subjects=None,
            action="__absent__", spatial="__absent__"):
    item = {
        "category": category,
        "description": description,
        "confidence": confidence,
        "evidence": evidence,
    }
    if subjects is not None:
        item["subjects"] = subjects
    if action != "__absent__":
        item["action"] = action
    if spatial != "__absent__":
        item["spatial"] = spatial
    return item


def v2_doc(timestamp, items, uncertainties=()):
    return {
        "schema_version": "observation-v2",
        "timestamp": timestamp,
        "observations": items,
        "uncertainties": list(uncertainties),
    }


V2_HUD = v2_item(
    "hud",
    "Team AG panel header Elim 4, bottom-left.",
    "high",
    "Header text Elim 4 in the team AG panel.",
    subjects=[{"label": "AG", "kind": "team"}],
    action="Elim 4",
    spatial="bottom-left",
)


class ValidateObservationV2Tests(unittest.TestCase):
    def test_valid_v2_with_structured_evidence_passes(self):
        entry = validate_observation(v2_doc(3, [V2_HUD]))["observations"][0]
        self.assertEqual(entry["subjects"], [{"label": "AG", "kind": "team"}])
        self.assertEqual(entry["action"], "Elim 4")
        self.assertEqual(entry["spatial"], "bottom-left")

    def test_v2_absent_keys_pass(self):
        doc = v2_doc(3, [v2_item(
            "hud", "Kill counter reads 4.", "high", "Digits 4."
        )])
        validated = validate_observation(doc)
        self.assertEqual(validated["schema_version"], "observation-v2")
        self.assertNotIn("subjects", validated["observations"][0])

    def test_v2_null_action_spatial_pass(self):
        doc = v2_doc(3, [v2_item(
            "hud", "Kill counter reads 4.", "high", "Digits 4.",
            action=None, spatial=None,
        )])
        entry = validate_observation(doc)["observations"][0]
        self.assertIsNone(entry["action"])
        self.assertIsNone(entry["spatial"])

    def test_v2_empty_subjects_pass(self):
        doc = v2_doc(3, [v2_item(
            "hud", "Kill counter reads 4.", "high", "Digits 4.", subjects=[],
        )])
        self.assertEqual(
            validate_observation(doc)["observations"][0]["subjects"], []
        )

    def test_v2_rejections(self):
        base = v2_item(
            "hud", "Kill counter reads 4.", "high", "Digits 4.",
            subjects=[{"label": "4", "kind": "other"}],
            action="reads 4",
            spatial=None,
        )
        cases = [
            ("empty label", {"subjects": [{"label": "  ", "kind": "team"}]}),
            ("bad kind", {"subjects": [{"label": "4", "kind": "squad"}]}),
            ("non-list subjects", {"subjects": "4"}),
            ("non-object subject", {"subjects": ["4"]}),
            ("extra subject field", {"subjects": [
                {"label": "4", "kind": "other", "role": "killer"}]}),
            ("non-verbatim label", {"subjects": [
                {"label": "RRQ.JEEK", "kind": "player"}]}),
            ("empty action", {"action": "  "}),
            ("non-string action", {"action": 4}),
            ("non-verbatim action", {"action": "eliminated"}),
            ("empty spatial", {"spatial": ""}),
            ("non-verbatim spatial", {"spatial": "top-right"}),
            ("extra entry field", {"score": 0.9}),
        ]
        for label, override in cases:
            item = dict(base)
            item.update(override)
            with self.assertRaises(ObservationError, msg=label):
                validate_observation(v2_doc(3, [item]))
        with self.assertRaises(ObservationError, msg="extra top-level"):
            validate_observation(mutate(v2_doc(3, [base]), reasoning="x"))

    def test_v2_label_may_quote_evidence_only(self):
        item = v2_item(
            "hud", "Top-right kill feed lines show eliminations.", "high",
            "Feed lines read 'RRQ.JEEK eliminated OG.IQOOPAWDI'.",
            subjects=[{"label": "RRQ.JEEK", "kind": "player"}],
        )
        entry = validate_observation(v2_doc(3, [item]))["observations"][0]
        self.assertEqual(entry["subjects"][0]["label"], "RRQ.JEEK")

    def test_v1_rejects_v2_keys(self):
        item = dict(VALID["observations"][0], subjects=[])
        with self.assertRaises(ObservationError):
            validate_observation(mutate(VALID, observations=[item]))
        item = dict(VALID["observations"][0], action=None)
        with self.assertRaises(ObservationError):
            validate_observation(mutate(VALID, observations=[item]))

    def test_v1_valid_document_still_passes(self):
        self.assertEqual(
            validate_observation(VALID)["observations"][0]["category"], "hud"
        )


class V2PromptTests(unittest.TestCase):
    def test_vision_prompt_requests_optional_structured_keys(self):
        prompt = build_vision_prompt(0)
        for token in ("observation-v2", "subjects", "action", "spatial",
                      "verbatim", "player", "team"):
            self.assertIn(token, prompt)

    def test_previous_context_carries_v2_keys(self):
        context = build_previous_context(v2_doc(0, [V2_HUD]))
        for token in ("subjects", "AG", "team", "Elim 4", "bottom-left"):
            self.assertIn(token, context)

    def test_previous_context_omits_absent_v2_keys(self):
        context = build_previous_context(VALID)
        self.assertNotIn("subjects", context)
        self.assertNotIn("action", context)
        self.assertNotIn("spatial", context)

    def test_previous_context_omits_null_action(self):
        doc = v2_doc(0, [v2_item(
            "hud", "Kill counter reads 4.", "high", "Digits 4.",
            action=None,
        )])
        self.assertNotIn("action", build_previous_context(doc))


if __name__ == "__main__":
    unittest.main()
