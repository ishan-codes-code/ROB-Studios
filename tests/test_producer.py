"""Targeted tests for the caster producer slice (Stage C/D).

Beat validation, analyst fact-vs-hypothesis separation, and producer
selection/pacing/silence/no-repeat. Fixtures are hand-built
observation-v1/v2 documents run through the real pipeline
(build_match_state, build_gameplay_state, detect_events,
gate_commentary_claims); no live API calls. Focused hand-shaped claims
cover pacing and repeat edges the gate cannot produce (developments
only fire at the latest timestamp).
"""

import re
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))

from ai_commentator.caster.analyst import HYPOTHESIS_MARKERS, analyze_match
from ai_commentator.caster.beats import (
    BEAT_KEYS,
    beat_id_for,
    validate_beat,
)
from ai_commentator.caster.producer import produce_beats
from ai_commentator.commentary.writer import claim_id_of
from main import (
    ObservationError,
    build_gameplay_state,
    build_match_state,
    detect_events,
    gate_commentary_claims,
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


def _doc(timestamp, entries, version="observation-v1"):
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


def _pipeline(*docs):
    accepted = _accepted(*docs)
    state = build_match_state(list(accepted))
    gameplay = build_gameplay_state(list(accepted), state)
    events, _ = detect_events(list(accepted), state)
    claims, _ = gate_commentary_claims(list(accepted), state, events)
    return gameplay, state, events, claims


def _named(description, evidence, spatial="", label="AG.BAROS"):
    extra = {"subjects": [{"label": label, "kind": "player"}]}
    if spatial:
        extra["spatial"] = spatial
    return _entry("character", description, evidence, **extra)


ELIM_AG_4 = _entry(
    "hud",
    "Bottom-left team panel for team AG showing members AG.BAROS and "
    "AG.SAIFA, plus header 'Elim 4'.",
    "Team AG panel header Elim 4.",
)
ELIM_AG_5 = _entry(
    "hud",
    "Bottom-left team panel for team AG showing members AG.BAROS and "
    "AG.NAMELESS, plus header 'Elim 5'.",
    "Team AG panel header Elim 5.",
)
ELIM_AG_6 = _entry(
    "hud",
    "Bottom-left team panel for team AG showing members AG.BAROS and "
    "AG.RAIDEN, plus header 'Elim 6'.",
    "Team AG panel header Elim 6.",
)
KILL_FEED = _entry(
    "hud",
    "Top-right kill feed lines show recent eliminations.",
    "Feed lines read 'RRQ.JEEK eliminated OG.IQOOPAWDI' and "
    "'SBUL.BUNNY eliminated TAG.VIPER'.",
)
SCENERY = _entry(
    "environment",
    "Open grass field with a road and a billboard.",
    "Grass, road, and billboard visible.",
)


def _rich_pipeline():
    """Combat + movement + feed + streak: echoes and developments fire."""
    return _pipeline(
        _doc(0, [
            _entry("combat", "Gunfire exchange near the ridge.",
                   "Tracers and muzzle flashes near the ridge."),
            _named("AG.BAROS firing near the ridge.",
                   "AG.BAROS firing stance.", spatial="near the ridge"),
            KILL_FEED,
            ELIM_AG_4,
        ], version="observation-v2"),
        _doc(10, [
            _entry("combat", "Firefight continues near the compound.",
                   "More tracers near the compound."),
            _named("AG.BAROS firing behind the wall.",
                   "AG.BAROS firing stance.", spatial="behind the wall"),
            ELIM_AG_5,
        ], version="observation-v2"),
        _doc(20, [ELIM_AG_6]),
    )


def _dev_claim(timestamp, evidence, source_id="f0001", confidence="high"):
    return {
        "template": "development_new",
        "type": "development",
        "timestamp": timestamp,
        "sources": [{
            "timestamp": timestamp,
            "file": f"frame_{timestamp:05d}.json",
            "fact_id": source_id,
        }],
        "source_ids": [source_id],
        "event_id": None,
        "evidence": list(evidence),
        "confidence": confidence,
        "qualification": None,
    }


def _echo_claim(timestamp, rule, evidence, source_id="f0002",
                confidence="high"):
    return {
        "template": "event_echo",
        "type": "event_echo",
        "timestamp": timestamp,
        "sources": [{
            "timestamp": timestamp,
            "file": f"frame_{timestamp:05d}.json",
            "fact_id": source_id,
        }],
        "source_ids": [source_id],
        "event_id": "evt-0123456789ab",
        "rule": rule,
        "evidence": list(evidence),
        "confidence": confidence,
        "qualification": f"test qualifier for {rule}",
    }


def _background():
    """Valid gameplay/state/events trio for hand-claim producer tests."""
    gameplay, state, events, _ = _pipeline(_doc(0, [SCENERY]))
    return gameplay, state, events


class BeatValidationTests(unittest.TestCase):
    def test_beat_id_deterministic_stable_shaped(self):
        first = beat_id_for("combat_engagement", 10, ["quote"], ["clm-aaa"])
        second = beat_id_for("combat_engagement", 10, ["quote"], ["clm-aaa"])
        self.assertEqual(first, second)
        self.assertRegex(first, r"^beat-[0-9a-f]{12}$")
        self.assertNotEqual(
            first, beat_id_for("combat_engagement", 10, ["other"], ["clm-aaa"])
        )
        self.assertNotEqual(
            first, beat_id_for("development", 10, ["quote"], ["clm-aaa"])
        )
        self.assertEqual(
            beat_id_for("development", 0, ["q"], ["clm-002", "clm-001"]),
            beat_id_for("development", 0, ["q"], ["clm-001", "clm-002"]),
        )

    def _good_beat(self):
        evidence = ["Gunfire exchange near the ridge."]
        claim_ids = ["clm-0123456789ab"]
        return {
            "beat_id": beat_id_for("combat_engagement", 10, evidence, claim_ids),
            "timestamp": 10,
            "window_end": 15.0,
            "what": "Gunfire exchange near the ridge.",
            "participants": [],
            "evidence": evidence,
            "tactical_significance": None,
            "related_to": [],
            "confidence": "high",
            "priority": "high",
            "delivery": "measured",
            "must_not_claim": ["participants are not established"],
            "source_claim_ids": claim_ids,
        }

    def test_validate_beat_accepts_exact_keys(self):
        beat = self._good_beat()
        self.assertEqual(set(beat), set(BEAT_KEYS))
        self.assertIs(validate_beat(beat), beat)
        self.assertIs(
            validate_beat(beat, beat_type="combat_engagement"), beat
        )

    def test_validate_beat_rejections(self):
        good = self._good_beat()
        cases = [
            ("unknown field", {**good, "reasoning": "x"}),
            ("missing field",
             {k: v for k, v in good.items() if k != "priority"}),
            ("bad beat id", {**good, "beat_id": "beat-xyz"}),
            ("bad confidence", {**good, "confidence": "certain"}),
            ("bad priority", {**good, "priority": "urgent"}),
            ("bad delivery", {**good, "delivery": "loud"}),
            ("empty evidence", {**good, "evidence": []}),
            ("empty claim ids", {**good, "source_claim_ids": []}),
            ("bad claim id", {**good, "source_claim_ids": ["evt-abc"]}),
            ("bad related ref", {**good, "related_to": ["clm-abc"]}),
            ("window before start", {**good, "window_end": 9}),
            ("multiline what", {**good, "what": "Line one.\nLine two."}),
            ("empty what", {**good, "what": "  "}),
            ("non-object", ["not", "a", "dict"]),
        ]
        for label, beat in cases:
            with self.assertRaises(ObservationError, msg=label):
                validate_beat(beat)

    def test_validate_beat_rejects_id_content_mismatch(self):
        good = self._good_beat()
        with self.assertRaises(ObservationError):
            validate_beat(good, beat_type="development")
        tampered = dict(
            good, evidence=["Gunfire exchange near the compound."]
        )
        with self.assertRaises(ObservationError):
            validate_beat(tampered, beat_type="combat_engagement")


class AnalystTests(unittest.TestCase):
    def test_keys_and_entry_shapes_exact(self):
        gameplay, state, events, _ = _rich_pipeline()
        result = analyze_match(gameplay, state, events)
        self.assertEqual(
            set(result),
            {"observed_facts", "interpretations", "hypotheses", "unknown"},
        )
        for key, entries in result.items():
            for entry in entries:
                self.assertEqual(
                    set(entry), {"text", "evidence", "confidence"}, msg=key
                )

    def test_rotation_observed_from_confirmed_movement(self):
        gameplay, state, events, _ = _rich_pipeline()
        result = analyze_match(gameplay, state, events)
        texts = [entry["text"] for entry in result["observed_facts"]]
        self.assertTrue(
            any("AG.BAROS repositioned" in text for text in texts),
            f"rotation fact missing: {texts}",
        )
        reads = [entry["text"] for entry in result["interpretations"]]
        self.assertTrue(
            any("rotating" in text for text in reads),
            f"rotation read missing: {reads}",
        )

    def test_single_movement_cue_never_stated_as_fact(self):
        gameplay, state, events, _ = _pipeline(
            _doc(0, [
                _named("AG.BAROS rotating near the ridge.",
                       "AG.BAROS turning.", spatial="near the ridge"),
            ], version="observation-v2"),
        )
        result = analyze_match(gameplay, state, events)
        for entry in result["observed_facts"]:
            self.assertNotIn("rotat", entry["text"].lower())
        guesses = [entry["text"] for entry in result["hypotheses"]]
        self.assertTrue(
            any("AG.BAROS" in text for text in guesses),
            f"rotation hypothesis missing: {guesses}",
        )
        self.assertTrue(
            any("unknown" in entry["text"].lower()
                for entry in result["unknown"]),
        )

    def test_hypotheses_never_phrased_as_fact(self):
        gameplay, state, events, _ = _rich_pipeline()
        result = analyze_match(gameplay, state, events)
        self.assertTrue(result["hypotheses"], "rich match needs hypotheses")
        for entry in result["hypotheses"]:
            lowered = entry["text"].lower()
            self.assertTrue(
                any(marker in lowered.split() or marker in lowered
                    for marker in HYPOTHESIS_MARKERS),
                f"hypothesis lacks hedge: {entry['text']}",
            )

    def test_clash_squad_round_read_and_generic_fallback(self):
        gameplay, state, events, _ = _pipeline(
            _doc(0, [
                _entry("hud", "Round 3 of the Clash Squad match begins.",
                       "Round banner text Round 3."),
            ]),
        )
        result = analyze_match(gameplay, state, events)
        facts = [entry["text"] for entry in result["observed_facts"]]
        self.assertTrue(
            any("Round marker observed" in text for text in facts),
            f"round fact missing: {facts}",
        )
        plain_gameplay, plain_state, plain_events, _ = _pipeline(
            _doc(0, [SCENERY]),
        )
        fallback = analyze_match(plain_gameplay, plain_state, plain_events)
        unknowns = [entry["text"] for entry in fallback["unknown"]]
        self.assertTrue(
            any("round structure is unknown" in text for text in unknowns),
            f"generic fallback missing: {unknowns}",
        )

    def test_pressure_and_momentum_need_evidence(self):
        gameplay, state, events, _ = _pipeline(_doc(0, [SCENERY]))
        result = analyze_match(gameplay, state, events)
        for key in ("observed_facts", "interpretations"):
            for entry in result[key]:
                self.assertNotIn("momentum", entry["text"].lower(), msg=key)
                self.assertNotIn("Pressure", entry["text"], msg=key)
        self.assertEqual(result["interpretations"], [])


class ProducerTests(unittest.TestCase):
    def test_beats_wrap_gated_claims_with_verbatim_evidence(self):
        gameplay, state, events, claims = _rich_pipeline()
        echoed = [c for c in claims if c["type"] == "event_echo"]
        self.assertTrue(echoed, "rich match needs event echoes")
        beats = produce_beats(gameplay, state, events, claims, [])
        self.assertTrue(beats, "worthy claims must produce beats")
        claim_ids = {claim_id_of(claim) for claim in claims}
        claim_quotes = {
            quote for claim in claims for quote in claim["evidence"]
        }
        for beat in beats:
            validate_beat(beat)
            for claim_id in beat["source_claim_ids"]:
                self.assertIn(claim_id, claim_ids)
            for quote in beat["evidence"]:
                self.assertIn(quote, claim_quotes)
            self.assertLessEqual(beat["timestamp"], beat["window_end"])
        stamps = [beat["timestamp"] for beat in beats]
        self.assertEqual(stamps, sorted(stamps))

    def test_pacing_cap_drops_secondary_beat(self):
        gameplay, state, events = _background()
        first = _dev_claim(0, ["New development: first sighting."])
        second = _dev_claim(3, ["New development: second sighting."])
        beats = produce_beats(gameplay, state, events, [first, second], [])
        self.assertEqual([beat["timestamp"] for beat in beats], [0])
        spaced = produce_beats(
            gameplay, state, events,
            [first, _dev_claim(6, ["New development: later sighting."])], [],
        )
        self.assertEqual(
            [beat["timestamp"] for beat in spaced], [0, 6]
        )

    def test_critical_beats_interrupt_without_opening_windows(self):
        gameplay, state, events = _background()
        opening = _dev_claim(0, ["New development: opening."])
        streak = _echo_claim(
            3, "elim_streak",
            ["Team AG header Elim 4.", "Team AG header Elim 6."],
        )
        followup = _dev_claim(4, ["New development: followup."])
        beats = produce_beats(
            gameplay, state, events, [opening, streak, followup], []
        )
        self.assertEqual(
            [(beat["timestamp"], beat["priority"]) for beat in beats],
            [(0, "normal"), (3, "critical")],
        )

    def test_silence_when_nothing_worthy(self):
        gameplay, state, events = _background()
        self.assertEqual(
            produce_beats(gameplay, state, events, [], []), []
        )
        scene = dict(
            _dev_claim(0, ["Open grass field with a road."]),
            type="scene",
            template="scene_visible",
        )
        self.assertEqual(
            produce_beats(gameplay, state, events, [scene], []), []
        )
        quiet = _pipeline(_doc(0, [SCENERY]))
        self.assertEqual(
            produce_beats(quiet[0], quiet[1], quiet[2], quiet[3], []), []
        )

    def test_no_repeat_vs_history_texts(self):
        gameplay, state, events = _background()
        claim = _dev_claim(0, ["New development: first sighting."])
        kept = produce_beats(gameplay, state, events, [claim], [])
        self.assertEqual(len(kept), 1)
        what = kept[0]["what"]
        self.assertEqual(
            produce_beats(gameplay, state, events, [claim], [what]), []
        )
        self.assertEqual(
            produce_beats(
                gameplay, state, events, [claim],
                [f"Earlier: {what}  And more."],
            ),
            [],
        )
        self.assertEqual(
            len(produce_beats(
                gameplay, state, events, [claim], ["Unrelated line."]
            )),
            1,
        )

    def test_must_not_claim_guards_and_delivery(self):
        gameplay, state, events, claims = _rich_pipeline()
        beats = produce_beats(gameplay, state, events, claims, [])
        for beat in beats:
            self.assertTrue(beat["must_not_claim"])
        streaks = [b for b in beats if b["priority"] == "critical"]
        self.assertTrue(streaks, "streak evidence needs a critical beat")
        for beat in streaks:
            self.assertEqual(beat["delivery"], "energized")
            self.assertTrue(
                any("outcome" in guard for guard in beat["must_not_claim"]),
                f"outcome guard missing: {beat['must_not_claim']}",
            )

    def test_participants_only_established_names(self):
        gameplay, state, events, claims = _rich_pipeline()
        beats = produce_beats(gameplay, state, events, claims, [])
        token_re = re.compile(r"[A-Za-z][A-Za-z0-9_]*\.[A-Za-z0-9_]+")
        for beat in beats:
            quoted = {
                match.group(0)
                for quote in beat["evidence"]
                for match in token_re.finditer(quote)
            }
            self.assertLessEqual(set(beat["participants"]), quoted)
        self.assertTrue(
            any(beat["participants"] for beat in beats),
            "feed evidence should establish participant names",
        )

    def test_related_to_links_shared_participants(self):
        gameplay, state, events = _background()
        early = _dev_claim(
            0, ["RRQ.JEEK holds the ridge line."], source_id="f0010"
        )
        late = _dev_claim(
            10, ["RRQ.JEEK still holds the ridge line."], source_id="f0011"
        )
        beats = produce_beats(gameplay, state, events, [early, late], [])
        self.assertEqual(len(beats), 2)
        self.assertEqual(beats[0]["related_to"], [])
        self.assertEqual(beats[1]["related_to"], [beats[0]["beat_id"]])

    def test_confidence_and_window_inherit_claim(self):
        gameplay, state, events = _background()
        claim = _dev_claim(7, ["New development: sighting."], confidence="medium")
        (beat,) = produce_beats(gameplay, state, events, [claim], [])
        self.assertEqual(beat["confidence"], "medium")
        self.assertEqual(beat["window_end"], 12.0)
        self.assertEqual(beat["priority"], "normal")
        self.assertEqual(beat["delivery"], "measured")

    def test_malformed_claims_rejected(self):
        gameplay, state, events = _background()
        good = _dev_claim(0, ["New development: sighting."])
        bad_type = dict(good, type="hot_take")
        with self.assertRaises(ObservationError):
            produce_beats(gameplay, state, events, [bad_type], [])
        with self.assertRaises(ObservationError):
            produce_beats(gameplay, state, events, [good], ["ok", 42])


if __name__ == "__main__":
    unittest.main()
