"""Targeted tests for the caster writer slice (Stage E/F).

Beat-driven script writing, the spoken-uncertainty ban, must_not_claim
enforcement, and the caster-quality reviewer with its bounded
deterministic repair. No live API calls: fixtures are hand-shaped
claims plus real validated beats. Run natively from the repo root:
    .venv/Scripts/python.exe -m unittest tests.test_caster_writer -v
"""

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))

from ai_commentator.caster.beats import beat_id_for, validate_beat
from ai_commentator.commentary.writer import (
    contains_leaked_validation_language,
    render_claim_text,
    writer_text_valid,
)
from ai_commentator.script.generation import (
    build_beat_prompt,
    parse_script_segments,
    script_text_valid,
)
from ai_commentator.script.review import repair_beat_line, review_caster_quality


CLAIM_A = "clm-aaaaaaaaaaaa"
CLAIM_B = "clm-bbbbbbbbbbbb"

ECHO_EVIDENCE = "RRQ.JEEK eliminated OG.IQOOPAWDI in the kill feed"
BIKE_EVIDENCE = "A bike speeding past the rocky ledge."


def echo_claim():
    return {
        "type": "event_echo",
        "template": "event_echo",
        "timestamp": 3,
        "evidence": [ECHO_EVIDENCE],
        "source_ids": ["fact-001"],
        "event_id": "evt-001",
        "rule": "kill_feed_entry",
        "confidence": "high",
        "qualification": "killer and victim roles are not established",
    }


def sequence_claim():
    return {
        "type": "event_echo",
        "template": "event_sequence",
        "timestamp": 6,
        "evidence": [ECHO_EVIDENCE, "Team AG panel header Elim 6."],
        "source_ids": ["fact-001", "fact-003"],
        "event_id": "evt-002",
        "rule": "feed_cluster",
        "confidence": "high",
        "qualification": "killer and victim roles are not established",
    }


def scene_claim():
    return {
        "type": "development",
        "template": "development_new",
        "timestamp": 3,
        "evidence": [BIKE_EVIDENCE],
        "source_ids": ["fact-002"],
        "event_id": None,
        "confidence": "high",
        "qualification": None,
        "gameplay": {
            "tags": ["movement"],
            "entities": [],
            "entity_moved": False,
            "event_linked": False,
        },
    }


def beat(**overrides):
    evidence = [BIKE_EVIDENCE]
    base = {
        "beat_id": beat_id_for("development", 3, evidence, [CLAIM_A]),
        "timestamp": 3,
        "window_end": 8.0,
        "what": BIKE_EVIDENCE,
        "participants": [],
        "evidence": evidence,
        "tactical_significance": None,
        "related_to": [],
        "confidence": "high",
        "priority": "normal",
        "delivery": "measured",
        "must_not_claim": ["cause and match outcome are not established"],
        "source_claim_ids": [CLAIM_A],
    }
    base.update(overrides)
    return base


class LeakBanTests(unittest.TestCase):
    def test_not_established_rejected(self):
        for line in (
            "participants, outcome, and cause are not established",
            "who placed that blue wall is not established",
            "The killer and victim roles are not established.",
        ):
            with self.subTest(line=line):
                self.assertTrue(contains_leaked_validation_language(line))
                self.assertFalse(script_text_valid(line, [scene_claim()]))

    def test_unconfirmed_qualifier_clause_rejected(self):
        for line in (
            "Possible feed activity, unconfirmed.",
            "Feed entry unconfirmed: details unclear.",
            "Feed entry — unconfirmed: killer and victim roles unknown.",
            "Movement spotted, unconfirmed for now.",
        ):
            with self.subTest(line=line):
                self.assertTrue(contains_leaked_validation_language(line))
                self.assertFalse(script_text_valid(line, [scene_claim()]))

    def test_participants_outcome_meta_talk_rejected(self):
        for line in (
            "The participants remain unconfirmed at this stage.",
            "The outcome is unconfirmed for now.",
        ):
            with self.subTest(line=line):
                self.assertTrue(contains_leaked_validation_language(line))
                self.assertFalse(script_text_valid(line, [scene_claim()]))

    def test_cautious_grounded_phrasing_accepted(self):
        self.assertTrue(
            script_text_valid(
                "Possible feed activity involving RRQ.JEEK.", [echo_claim()]
            )
        )

    def test_template_has_no_leak(self):
        for claim in (echo_claim(), sequence_claim()):
            text = render_claim_text(claim)
            with self.subTest(template=claim["template"]):
                for quote in claim["evidence"]:
                    self.assertIn(quote, text)
                self.assertFalse(contains_leaked_validation_language(text))

    def test_writer_wording_bans_leaks(self):
        claim = echo_claim()
        leaked = f"{ECHO_EVIDENCE} — unconfirmed: {claim['qualification']}"
        self.assertFalse(writer_text_valid(leaked, claim))
        cautious = f"{ECHO_EVIDENCE}, a possible development."
        self.assertTrue(writer_text_valid(cautious, claim))


class MustNotClaimTests(unittest.TestCase):
    def test_guard_phrase_rejected(self):
        guard = "the exact weapon is unknown"
        line = "The exact weapon is unknown, possibly a rifle."
        self.assertFalse(
            script_text_valid(line, [echo_claim()], must_not_claim=[guard])
        )
        self.assertTrue(script_text_valid(line, [echo_claim()]))

    def test_unrelated_guard_passes(self):
        line = "The exact weapon is unknown, possibly a rifle."
        self.assertTrue(
            script_text_valid(
                line,
                [echo_claim()],
                must_not_claim=["cause and match outcome are not established"],
            )
        )


class QualityReviewTests(unittest.TestCase):
    def test_screenshot_narration_flagged(self):
        for line in (
            "The screenshot shows a player by the wall.",
            "HUD reads: health 200.",
        ):
            issues = review_caster_quality(line, beat(), [])
            self.assertTrue(
                any(issue.startswith("screenshot narration:") for issue in issues),
                line,
            )

    def test_clean_line_passes(self):
        issues = review_caster_quality(
            "A bike speeds past the rocky ledge as the squad repositions.",
            beat(),
            [],
        )
        self.assertEqual(issues, [])

    def test_repetition_flagged(self):
        history = ["A bike speeds past the rocky ledge."]
        issues = review_caster_quality(
            "A bike speeds past the rocky ledge.", beat(), history
        )
        self.assertTrue(
            any(issue.startswith("repetition:") for issue in issues)
        )

    def test_generic_filler_flagged(self):
        for line in ("Here we go.", "Ladies and gentlemen, the match continues."):
            issues = review_caster_quality(line, beat(), [])
            self.assertTrue(
                any(issue.startswith("generic filler:") for issue in issues),
                line,
            )

    def test_missing_continuity_flagged(self):
        follow_up = beat(
            related_to=["beat-ffffffffffff"], participants=["AG.BAROS"]
        )
        history = ["AG.BAROS holds the ridge."]
        issues = review_caster_quality(
            "Smoke covers the compound entrance.", follow_up, history
        )
        self.assertTrue(
            any(issue.startswith("missing continuity:") for issue in issues)
        )
        connected = review_caster_quality(
            "AG.BAROS still holds the ridge.", follow_up, history
        )
        self.assertFalse(
            any(issue.startswith("missing continuity:") for issue in connected)
        )

    def test_unnatural_hype_flagged(self):
        calm = beat(delivery="calm", priority="low")
        issues = review_caster_quality("An unbelievable moment!", calm, [])
        self.assertTrue(any(issue.startswith("unnatural hype:") for issue in issues))
        measured = beat(delivery="measured", priority="normal")
        issues = review_caster_quality("An amazing rotation.", measured, [])
        self.assertTrue(any(issue.startswith("unnatural hype:") for issue in issues))
        energized = beat(delivery="energized", priority="critical")
        self.assertEqual(
            review_caster_quality("An amazing rotation.", energized, []), []
        )

    def test_leaked_language_flagged_by_review(self):
        issues = review_caster_quality(
            "The participants are not established.", beat(), []
        )
        self.assertTrue(
            any(issue.startswith("leaked validation language:") for issue in issues)
        )


class RepairTests(unittest.TestCase):
    def test_hype_repaired_to_safe_line(self):
        current = beat()
        guards = list(current["must_not_claim"])
        fixed = repair_beat_line(
            "An absolutely insane and unbelievable moment!",
            current,
            [scene_claim()],
            must_not_claim=guards,
            history=[],
        )
        self.assertEqual(fixed, BIKE_EVIDENCE)
        self.assertTrue(
            script_text_valid(fixed, [scene_claim()], must_not_claim=guards)
        )

    def test_repetition_drops(self):
        history = ["A bike speeds past the rocky ledge."]
        self.assertIsNone(
            repair_beat_line(
                "A bike speeds past the rocky ledge.",
                beat(),
                [scene_claim()],
                history=history,
            )
        )

    def test_repair_is_bounded_and_deterministic(self):
        current = beat()
        first = repair_beat_line(
            "An absolutely insane and unbelievable moment!",
            current,
            [scene_claim()],
            history=[],
        )
        second = repair_beat_line(
            "An absolutely insane and unbelievable moment!",
            current,
            [scene_claim()],
            history=[],
        )
        self.assertEqual(first, second)
        clean = "A bike speeds past the rocky ledge."
        self.assertEqual(
            repair_beat_line(clean, current, [scene_claim()], history=[]), clean
        )

    def test_unrepairable_drops(self):
        self.assertIsNone(
            repair_beat_line(
                "An absolutely insane moment!",
                beat(what=""),
                [scene_claim()],
                history=[],
            )
        )


class BeatPromptTests(unittest.TestCase):
    def test_prompt_carries_beats_not_claims(self):
        current = beat(
            participants=["AG.BAROS"],
            tactical_significance="AG.BAROS appears to hold the ridge.",
        )
        prompt = build_beat_prompt(
            [current],
            ["Prior line spoken."],
            pack="free-fire",
            intensity="high",
            narrative="Situation: combat active.",
        )
        self.assertIn(current["beat_id"], prompt)
        self.assertIn(BIKE_EVIDENCE, prompt)
        self.assertIn("AG.BAROS", prompt)
        self.assertIn("AG.BAROS appears to hold the ridge.", prompt)
        self.assertIn("Never claim", prompt)
        self.assertIn("cause and match outcome are not established", prompt)
        self.assertIn(CLAIM_A, prompt)
        self.assertIn('{"segments"', prompt)
        self.assertIn("Prior line spoken.", prompt)
        self.assertIn("combat active", prompt)
        self.assertIn("high intensity", prompt)

    def test_prompt_round_trip_parses(self):
        current = beat()
        claims_by_id = {CLAIM_A: dict(scene_claim(), claim_id=CLAIM_A)}
        raw = json.dumps(
            {
                "segments": [
                    {
                        "source_claim_ids": [CLAIM_A],
                        "text": "A bike speeds past the rocky ledge.",
                    }
                ]
            }
        )
        parsed = parse_script_segments(raw, claims_by_id)
        self.assertEqual(len(parsed), 1)
        ids, wording = parsed[0]
        self.assertEqual(ids, [CLAIM_A])
        self.assertTrue(
            script_text_valid(
                wording,
                [claims_by_id[CLAIM_A]],
                must_not_claim=current["must_not_claim"],
            )
        )
        self.assertEqual(
            review_caster_quality(wording, current, []), []
        )

    def test_fixture_beat_is_a_real_beat(self):
        validate_beat(beat(), beat_type="development")


if __name__ == "__main__":
    unittest.main()
