"""Match narrative context and gameplay-grounded script validation.

The narrative connects developments across time from verified inputs;
the validator grounds analytical wording in structured gameplay tags
instead of bare keyword overlap. Knock wording can never unlock
elimination wording. No live API calls.
"""

import unittest
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))

from main import (
    NARRATIVE_MAX_CHARS,
    build_gameplay_state,
    build_match_state,
    build_narrative,
    build_script_prompt,
    detect_events,
    gate_commentary_claims,
    render_narrative_block,
    script_text_valid,
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


def _doc(timestamp, entries, version="observation-v2", uncertainties=None):
    return {
        "schema_version": version,
        "timestamp": timestamp,
        "observations": entries,
        "uncertainties": list(uncertainties or []),
    }


def _accepted(*docs):
    return [
        (doc["timestamp"], f"frame_{doc['timestamp']:05d}.json", doc)
        for doc in docs
    ]


def _bundle(*docs, history=None):
    accepted = _accepted(*docs)
    state = build_match_state(accepted)
    events, _ = detect_events(accepted, state)
    gameplay = build_gameplay_state(accepted, state)
    claims, _ = gate_commentary_claims(list(accepted), state, events)
    narrative = build_narrative(gameplay, state, events, history or [])
    return {
        "accepted": accepted,
        "state": state,
        "events": events,
        "gameplay": gameplay,
        "claims": claims,
        "narrative": narrative,
    }


def _claim(evidence, tags=None, rule=None, claim_type="development",
           timestamp=0):
    claim = {
        "type": claim_type,
        "template": "development_new",
        "timestamp": timestamp,
        "sources": [],
        "source_ids": [],
        "event_id": None,
        "evidence": list(evidence),
        "confidence": "high",
        "qualification": None,
    }
    if tags is not None or rule is not None:
        claim["gameplay"] = {
            "tags": list(tags or []),
            "entities": [],
            "entity_moved": False,
            "event_linked": False,
        }
    if rule is not None:
        claim["rule"] = rule
    return claim


class NarrativeTests(unittest.TestCase):
    def test_situation_reports_combat_and_entities(self):
        bundle = _bundle(
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
        situation = " ".join(bundle["narrative"]["situation"])
        self.assertIn("Combat is active", situation)
        self.assertIn("Tracking 1 labeled entities", situation)

    def test_quiet_match_says_so(self):
        bundle = _bundle(
            _doc(
                0,
                [_entry("environment", "Empty ridge.", "No figures.")],
            )
        )
        situation = " ".join(bundle["narrative"]["situation"])
        self.assertIn("No combat", situation)

    def test_moved_entity_appears_in_situation(self):
        bundle = _bundle(
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
        situation = " ".join(bundle["narrative"]["situation"])
        self.assertIn("AG.BAROS repositioned", situation)
        self.assertIn("near the rock", situation)

    def test_engagement_and_developments_listed_with_uncertainty(self):
        bundle = _bundle(
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
            _doc(
                6,
                [
                    _entry(
                        "combat",
                        "Exchange continues at the ridge.",
                        "Tracers both ways.",
                    )
                ],
            ),
        )
        narrative = bundle["narrative"]
        self.assertTrue(narrative["active_engagements"])
        self.assertIn("unconfirmed", " ".join(narrative["active_engagements"])[-40:])
        self.assertTrue(narrative["recent_developments"])
        self.assertIn(
            "not established", " ".join(narrative["recent_developments"])
        )

    def test_uncertainties_and_spoken_bounded(self):
        bundle = _bundle(
            _doc(
                0,
                [_entry("environment", "Empty ridge.", "No figures.")],
                uncertainties=[
                    "Name text unreadable.",
                    "Counter digits blurred.",
                    "Minimap too small.",
                    "Fourth unknown that must be cut off.",
                ],
            ),
            history=["First line.", "Second line.", "Third line."],
        )
        narrative = bundle["narrative"]
        self.assertEqual(len(narrative["uncertainties"]), 3)
        self.assertEqual(len(narrative["spoken"]), 2)
        self.assertEqual(narrative["spoken"][-1], "Third line.")

    def test_rendered_block_bounded_and_labeled(self):
        bundle = _bundle(
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
            _doc(
                6,
                [
                    _entry(
                        "combat",
                        "Exchange continues at the ridge.",
                        "Tracers both ways.",
                    )
                ],
            ),
            history=["AG.BAROS opens fire at the ridge."],
        )
        block = render_narrative_block(bundle["narrative"])
        self.assertLessEqual(len(block), NARRATIVE_MAX_CHARS + len("…(truncated)"))
        self.assertIn("Situation:", block)
        self.assertIn("Recent developments:", block)
        self.assertIn("Already said:", block)

    def test_narrative_reaches_script_prompt(self):
        bundle = _bundle(
            _doc(
                0,
                [
                    _entry(
                        "character",
                        "Squad rotating across the yard.",
                        "Figures moving east.",
                    )
                ],
            )
        )
        block = render_narrative_block(bundle["narrative"])
        prompt_claims = [
            dict(claim, claim_id=f"clm-test-{index:04d}")
            for index, claim in enumerate(bundle["claims"])
        ]
        prompt = build_script_prompt(prompt_claims, [], narrative=block)
        self.assertIn("Match narrative", prompt)
        self.assertIn("Situation:", prompt)

    def test_narrative_is_deterministic(self):
        docs = [
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
            _doc(
                6,
                [
                    _entry(
                        "combat",
                        "Exchange continues at the ridge.",
                        "Tracers both ways.",
                    )
                ],
            ),
        ]
        first = _bundle(*docs)["narrative"]
        second = _bundle(*reversed(docs))["narrative"]
        self.assertEqual(first, second)


class ValidationGroundingTests(unittest.TestCase):
    def test_knock_evidence_cannot_word_elimination(self):
        claim = _claim(
            ["AG.BAROS knocked down behind cover."],
            tags=["knockdown", "entity_mention"],
        )
        self.assertTrue(
            script_text_valid("AG.BAROS is knocked down behind cover.", [claim])
        )
        self.assertFalse(
            script_text_valid("AG.BAROS is eliminated behind cover.", [claim])
        )

    def test_elim_evidence_words_elimination(self):
        claim = _claim(
            ["RRQ.JEEK eliminated OG.IQOOPAWDI in the kill feed."],
            tags=["elim", "entity_mention"],
        )
        self.assertTrue(
            script_text_valid("RRQ.JEEK eliminates OG.IQOOPAWDI.", [claim])
        )

    def test_quiet_evidence_cannot_claim_firefight(self):
        claim = _claim(
            ["A bike speeding past the rocky ledge."],
            tags=["vehicle"],
        )
        self.assertFalse(
            script_text_valid("A fierce firefight rages at the ledge.", [claim])
        )
        self.assertFalse(
            script_text_valid("The squad is camping the ledge.", [claim])
        )

    def test_combat_evidence_paraphrases_engagement(self):
        claim = _claim(
            ["AG.BAROS firing near the ridge."],
            tags=["combat", "entity_mention"],
        )
        self.assertTrue(
            script_text_valid("AG.BAROS is engaged in a firefight.", [claim])
        )
        # But not unrelated action claims.
        self.assertFalse(
            script_text_valid("AG.BAROS is healing near the ridge.", [claim])
        )

    def test_movement_evidence_paraphrases_repositioning(self):
        claim = _claim(
            ["Squad rotating across the container yard."],
            tags=["movement"],
        )
        self.assertTrue(
            script_text_valid("The squad is repositioning across the yard.", [claim])
        )
        self.assertFalse(
            script_text_valid("The squad is camping in the yard.", [claim])
        )

    def test_zone_evidence_paraphrases_pressure(self):
        claim = _claim(
            ["Zone circle closing on the minimap."],
            tags=["zone"],
        )
        self.assertTrue(
            script_text_valid("The circle is closing in on the minimap.", [claim])
        )

    def test_echo_still_requires_uncertainty(self):
        claim = _claim(
            ["AG.BAROS firing at the ridge.", "Exchange continues."],
            tags=["combat"],
            rule="combat_engagement",
            claim_type="event_echo",
            timestamp=6,
        )
        claim["qualification"] = "participants are not established"
        self.assertFalse(
            script_text_valid("AG.BAROS wins the firefight.", [claim])
        )
        self.assertTrue(
            script_text_valid(
                "An unconfirmed exchange continues at the ridge.", [claim]
            )
        )

    def test_claims_without_gameplay_context_still_validate(self):
        claim = _claim(["Squad rotating across the container yard."])
        self.assertTrue(
            script_text_valid("The squad is rotating across the yard.", [claim])
        )


if __name__ == "__main__":
    unittest.main()
