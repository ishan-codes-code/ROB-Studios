"""Offline tests for evidence-grounded event detection (events-v1).

No live API calls and no fixture credentials: observations are small
hand-built observation-v1 documents, and match state is built locally with
build_match_state. Run natively from the repository root:
    .venv/bin/python -m unittest discover -s tests -v
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
    EVENT_RULES,
    EVENT_SCHEMA_VERSION,
    MATCH_STATE_FILENAME,
    ObservationError,
    build_match_state,
    detect_events,
    run_detect_events,
    run_state_rebuild,
    validate_events,
    validate_match_state,
    validate_observation,
)


def obs_doc(timestamp, observations, uncertainties=()):
    return {
        "schema_version": "observation-v1",
        "timestamp": timestamp,
        "observations": [
            {
                "category": category,
                "description": description,
                "confidence": confidence,
                "evidence": evidence,
            }
            for category, description, confidence, evidence in observations
        ],
        "uncertainties": list(uncertainties),
    }


KILL_FEED = (
    "hud",
    "Top-right kill feed lines show recent eliminations.",
    "high",
    "Feed lines read 'RRQ.JEEK eliminated OG.IQOOPAWDI' and "
    "'SBUL.BUNNY eliminated TAG.VIPER'.",
)
KILL_FEED_UNREADABLE = (
    "hud",
    "Top-right kill feed lines are visible but too small to transcribe.",
    "high",
    "Tiny feed rows at the screen edge; no entry is legible.",
)
TIMER_742 = (
    "hud",
    "Top bar shows a timer reading 07:42.",
    "high",
    "Timer text 07:42 with clock icon.",
)
TIMER_1057 = (
    "hud",
    "Top bar shows a timer reading 10:57.",
    "high",
    "Timer text 10:57 with clock icon.",
)
COUNTERS_9_36 = (
    "hud",
    "Top bar shows counters 9 and 36 of unknown meaning.",
    "high",
    "Numbers 9 and 36 next to flag and silhouette icons.",
)
COUNTERS_9_31 = (
    "hud",
    "Top bar shows counters 9 and 31 of unknown meaning.",
    "high",
    "Numbers 9 and 31 next to flag and silhouette icons.",
)
NAMEPLATE = (
    "character",
    "Nameplate CTZ.KLAUS06 visible over the terrain.",
    "medium",
    "Yellow text label CTZ.KLAUS06 with a small marker.",
)
BANNER = (
    "hud",
    "Red banner stating Safe Zone is now shrinking.",
    "high",
    "Red banner text at the screen edge.",
)
ELIM_AG_4 = (
    "hud",
    "Bottom-left team panel for team AG showing members AG.BAROS and "
    "AG.SAIFA, plus header 'Elim 4'.",
    "high",
    "Team AG panel header Elim 4.",
)
ELIM_AG_5 = (
    "hud",
    "Bottom-left team panel for team AG showing members AG.BAROS and "
    "AG.NAMELESS, plus header 'Elim 5'.",
    "high",
    "Team AG panel header Elim 5.",
)
ELIM_SBUL_5 = (
    "hud",
    "Bottom-left team panel for team SBUL showing member SBUL.BUNNY, "
    "plus header 'Elim 5'.",
    "high",
    "Team SBUL panel header Elim 5.",
)
ELIM_PERSONAL = (
    "hud",
    "Bottom-center status shows player names 'BOMBER' and 'AG.BAROS Elim 1'.",
    "high",
    "Status bar text AG.BAROS Elim 1.",
)


def triples(*docs):
    return [
        (doc["timestamp"], f"frame_{doc['timestamp']:05d}.json", doc)
        for doc in docs
    ]


def build_state(*docs):
    return build_match_state(triples(*docs))


def detect(*docs):
    state = build_state(*docs)
    document, _ = detect_events(triples(*docs), state)
    return document


def capture_detect(*args, **kwargs):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = run_detect_events(*args, **kwargs)
    return code, out.getvalue(), err.getvalue()


def write_obs(directory, doc):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"frame_{doc['timestamp']:05d}.json"
    path.write_text(json.dumps(doc), encoding="utf-8")
    return path


class ValidateEventsTests(unittest.TestCase):
    def test_valid_document_passes(self):
        document = detect(obs_doc(48, [TIMER_742]))
        self.assertEqual(
            validate_events(document)["schema_version"], EVENT_SCHEMA_VERSION
        )

    def test_rejections(self):
        good = detect(obs_doc(48, [TIMER_742]))
        event = good["events"][0] if good["events"] else None
        _ = event
        base = {
            "schema_version": "events-v1",
            "generated_from": {
                "observations": ["frame_00048.json"],
                "match_state": MATCH_STATE_FILENAME,
            },
            "rules_evaluated": ["kill_feed_entry"],
            "contested_timestamps": [],
            "events": [],
        }
        full_event = {
            "schema_version": "events-v1",
            "id": "evt-0123456789ab",
            "type": "kill_feed_entry",
            "timestamp": 48,
            "status": "candidate",
            "rule": "kill_feed_entry/v1",
            "sources": [
                {"timestamp": 48, "file": "frame_00048.json", "fact_id": "f0001"}
            ],
            "evidence": ["feed mention", "transcribed line"],
            "confidence": "high",
            "detail": "Why the rule fired.",
        }
        cases = [
            ("bad version", {**base, "schema_version": "events-v0"}),
            ("extra field", {**base, "reasoning": "x"}),
            ("missing field", {k: v for k, v in base.items() if k != "events"}),
            ("empty observations", {**base, "generated_from": {
                "observations": [], "match_state": "match_state.json"}}),
            ("bad status", {**base, "events": [
                {**full_event, "status": "confirmed"}]}),
            ("missing evidence", {**base, "events": [
                {k: v for k, v in full_event.items() if k != "evidence"}]}),
            ("empty evidence", {**base, "events": [
                {**full_event, "evidence": []}]}),
            ("bad confidence", {**base, "events": [
                {**full_event, "confidence": "certain"}]}),
            ("missing fact_id", {**base, "events": [{**full_event, "sources": [
                {"timestamp": 48, "file": "frame_00048.json"}]}]}),
            ("empty sources", {**base, "events": [
                {**full_event, "sources": []}]}),
            ("non-object", ["not", "a", "dict"]),
            ("non-object event", {**base, "events": ["kill"]}),
        ]
        for label, doc in cases:
            with self.assertRaises(ObservationError, msg=label):
                validate_events(doc)


class KillFeedRuleTests(unittest.TestCase):
    def test_supported_feed_entry_emitted(self):
        document = detect(obs_doc(48, [KILL_FEED]))
        self.assertEqual(len(document["events"]), 1)
        event = document["events"][0]
        self.assertTrue(event["id"].startswith("evt-"))
        self.assertEqual(event["type"], "kill_feed_entry")
        self.assertEqual(event["timestamp"], 48)
        self.assertEqual(event["status"], "candidate")
        self.assertEqual(event["rule"], "kill_feed_entry/v1")
        self.assertEqual(
            event["sources"],
            [{"timestamp": 48, "file": "frame_00048.json", "fact_id": "f0001"}],
        )
        self.assertEqual(
            event["evidence"], [KILL_FEED[1], KILL_FEED[3]]
        )
        self.assertEqual(event["confidence"], "high")
        self.assertIn("not established", event["detail"])
        # Deterministic id: same inputs, same id.
        again = detect(obs_doc(48, [KILL_FEED]))
        self.assertEqual(again["events"][0]["id"], event["id"])

    def test_untranscribed_feed_suppressed(self):
        document = detect(obs_doc(48, [KILL_FEED_UNREADABLE]))
        self.assertEqual(document["events"], [])

    def test_low_confidence_feed_suppressed(self):
        weak = ("hud", KILL_FEED[1], "low", KILL_FEED[3])
        document = detect(obs_doc(48, [weak]))
        self.assertEqual(document["events"], [])

    def test_non_hud_feed_mention_suppressed(self):
        combat = ("combat", "No kill feed activity is visible.", "high", "Clear sky.")
        document = detect(obs_doc(48, [combat]))
        self.assertEqual(document["events"], [])

    def test_names_without_feed_mention_suppressed(self):
        plain = (
            "hud",
            "Top bar shows counters and nameplates.",
            "high",
            "Labels RRQ.JEEK and OG.IQOOPAWDI are legible.",
        )
        document = detect(obs_doc(48, [plain]))
        self.assertEqual(document["events"], [])

    def test_repeated_claim_emits_once(self):
        document = detect(obs_doc(48, [KILL_FEED, KILL_FEED]))
        self.assertEqual(len(document["events"]), 1)


class ElimCountRuleTests(unittest.TestCase):
    def test_supported_increase_emitted(self):
        document = detect(obs_doc(0, [ELIM_AG_4]), obs_doc(48, [ELIM_AG_5]))
        self.assertEqual(len(document["events"]), 1)
        event = document["events"][0]
        self.assertEqual(event["type"], "elim_count_increased")
        self.assertEqual(event["timestamp"], 48)
        self.assertEqual(event["status"], "candidate")
        self.assertEqual(
            [entry["file"] for entry in event["sources"]],
            ["frame_00000.json", "frame_00048.json"],
        )
        self.assertEqual(len(event["evidence"]), 2)
        self.assertIn("4->5", event["detail"])
        self.assertIn("AG", event["detail"])
        # Provenance resolves to real state facts.
        state = build_state(obs_doc(0, [ELIM_AG_4]), obs_doc(48, [ELIM_AG_5]))
        fact_ids = {fact["id"] for fact in state["facts"]}
        for entry in event["sources"]:
            self.assertIn(entry["fact_id"], fact_ids)

    def test_equal_counts_suppressed(self):
        document = detect(obs_doc(0, [ELIM_AG_4]), obs_doc(48, [ELIM_AG_4]))
        self.assertEqual(document["events"], [])

    def test_decrease_suppressed(self):
        lower = (
            "hud",
            "Bottom-left team panel for team AG showing members AG.BAROS, "
            "plus header 'Elim 3'.",
            "high",
            "Team AG panel header Elim 3.",
        )
        document = detect(obs_doc(0, [ELIM_AG_5]), obs_doc(48, [lower]))
        self.assertEqual(document["events"], [])

    def test_disjoint_scopes_suppressed(self):
        document = detect(obs_doc(0, [ELIM_AG_4]), obs_doc(48, [ELIM_SBUL_5]))
        self.assertEqual(document["events"], [])

    def test_personal_counter_not_linked_to_team_counter(self):
        document = detect(obs_doc(0, [ELIM_PERSONAL]), obs_doc(48, [ELIM_AG_5]))
        self.assertEqual(document["events"], [])

    def test_mixed_sentence_attributes_to_nearest_scope(self):
        mixed = (
            "hud",
            "Panel mentions team AG and team SBUL with header 'Elim 4'.",
            "high",
            "Shared panel Elim 4.",
        )
        # The counter resolves to the nearest team label (SBUL), which has
        # no counterpart reading, so no event links it to team AG.
        document = detect(obs_doc(0, [ELIM_AG_4]), obs_doc(48, [mixed]))
        self.assertEqual(document["events"], [])

    def test_low_confidence_reading_suppressed(self):
        weak = (ELIM_AG_5[0], ELIM_AG_5[1], "low", ELIM_AG_5[3])
        document = detect(obs_doc(0, [ELIM_AG_4]), obs_doc(48, [weak]))
        self.assertEqual(document["events"], [])

    def test_chained_increases_emit_per_step(self):
        higher = (
            "hud",
            "Bottom-left team panel for team AG showing members AG.BAROS, "
            "plus header 'Elim 6'.",
            "high",
            "Team AG panel header Elim 6.",
        )
        document = detect(
            obs_doc(0, [ELIM_AG_4]), obs_doc(48, [ELIM_AG_5]), obs_doc(96, [higher])
        )
        self.assertEqual(len(document["events"]), 2)
        self.assertEqual(
            [event["timestamp"] for event in document["events"]], [48, 96]
        )

    def test_increase_pairs_across_other_team_reading(self):
        # Another team's interleaved counter neither joins nor blocks
        # this team's comparison: AG 4->6 still fires.
        document = detect(
            obs_doc(0, [ELIM_AG_4]),
            obs_doc(48, [ELIM_SBUL_5]),
            obs_doc(96, [ELIM_AG_6]),
        )
        self.assertEqual(len(document["events"]), 1)
        event = document["events"][0]
        self.assertEqual(event["type"], "elim_count_increased")
        self.assertEqual(event["timestamp"], 96)
        self.assertIn("4->6", event["detail"])
        self.assertIn("Team AG ", event["detail"])

    def test_pair_confidence_is_weakest_reading(self):
        # A high-confidence later reading must not inflate the pair
        # over the medium reading it rests on.
        medium = (ELIM_AG_4[0], ELIM_AG_4[1], "medium", ELIM_AG_4[3])
        document = detect(obs_doc(0, [medium]), obs_doc(48, [ELIM_AG_5]))
        self.assertEqual(len(document["events"]), 1)
        self.assertEqual(document["events"][0]["confidence"], "medium")


class NoInferenceTests(unittest.TestCase):
    def test_missing_nameplate_is_not_elimination(self):
        document = detect(obs_doc(0, [NAMEPLATE]), obs_doc(48, [TIMER_742]))
        self.assertEqual(document["events"], [])

    def test_timer_change_is_not_an_event(self):
        document = detect(obs_doc(0, [TIMER_742]), obs_doc(48, [TIMER_1057]))
        self.assertEqual(document["events"], [])

    def test_ambiguous_hud_numbers_are_not_events(self):
        document = detect(obs_doc(0, [COUNTERS_9_36]), obs_doc(48, [COUNTERS_9_31]))
        self.assertEqual(document["events"], [])

    def test_persistent_banner_is_not_repeated(self):
        # The shrinking-zone banner now yields one zone_pressure
        # candidate (explicit zone wording), fired once at its first
        # sighting — re-sightings of the same banner are not new events.
        document = detect(
            obs_doc(0, [BANNER]), obs_doc(48, [BANNER]), obs_doc(96, [BANNER])
        )
        self.assertEqual(len(document["events"]), 1)
        event = document["events"][0]
        self.assertEqual(event["type"], "zone_pressure")
        self.assertEqual(event["timestamp"], 0)

    def test_no_event_is_ever_confirmed(self):
        document = detect(
            obs_doc(0, [ELIM_AG_4, KILL_FEED]),
            obs_doc(48, [ELIM_AG_5, KILL_FEED]),
        )
        self.assertTrue(document["events"])
        for event in document["events"]:
            self.assertEqual(event["status"], "candidate")


class DuplicateAndConflictTests(unittest.TestCase):
    def test_duplicate_input_skipped(self):
        doc = obs_doc(48, [KILL_FEED])
        state = build_state(doc)
        single, _ = detect_events(triples(doc), state)
        doubled, counts = detect_events(triples(doc, doc), state)
        self.assertEqual(doubled, single)
        self.assertEqual(counts["skipped"], 1)
        self.assertEqual(counts["accepted"], 1)

    def test_out_of_order_input_converges(self):
        docs = [obs_doc(0, [ELIM_AG_4]), obs_doc(48, [ELIM_AG_5])]
        state = build_state(*docs)
        forward, _ = detect_events(triples(*docs), state)
        backward, _ = detect_events(triples(*reversed(docs)), state)
        self.assertEqual(backward, forward)
        self.assertEqual(len(forward["events"]), 1)

    def divergent_pair(self):
        first = obs_doc(48, [TIMER_742])
        second = obs_doc(48, [TIMER_1057])
        # Same timestamp from two distinct provenances: a structural conflict.
        named = [
            (48, "frame_00048.json", first),
            (48, "frame_00048b.json", second),
        ]
        return named, build_match_state(named)

    def test_contested_timestamp_skipped(self):
        named, state = self.divergent_pair()
        conflicted = [
            fact["id"] for fact in state["facts"] if fact["status"] == "conflicted"
        ]
        self.assertTrue(conflicted)
        document, counts = detect_events(named, state)
        self.assertEqual(document["events"], [])
        self.assertEqual(counts["contested"], [48])
        self.assertEqual(counts["accepted"], 0)
        # The replay provenance still records the considered inputs.
        self.assertEqual(
            sorted(document["generated_from"]["observations"]),
            ["frame_00048.json", "frame_00048b.json"],
        )

    def test_contested_timestamp_does_not_block_others(self):
        named, _ = self.divergent_pair()
        kill = obs_doc(96, [KILL_FEED])
        named = named + [(96, "frame_00096.json", kill)]
        state = build_match_state(named)
        document, counts = detect_events(named, state)
        self.assertEqual(len(document["events"]), 1)
        self.assertEqual(document["events"][0]["timestamp"], 96)
        self.assertEqual(counts["contested"], [48])


class MalformedInputTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.obs = self.root / "observations"
        self.frames = self.root / "frames"
        self.frames.mkdir()
        self.state_path = self.root / "match_state.json"
        self.events_path = self.root / "events.json"

    def tearDown(self):
        self.tmp.cleanup()

    def test_malformed_observation_rejected(self):
        self.obs.mkdir()
        good = self.obs / "frame_00000.json"
        good.write_text(json.dumps(obs_doc(0, [TIMER_742])), encoding="utf-8")
        bad = self.obs / "frame_00048.json"
        bad.write_text("not json", encoding="utf-8")
        state_doc = build_match_state(
            [(0, "frame_00000.json", obs_doc(0, [TIMER_742]))]
        )
        self.state_path.write_text(json.dumps(state_doc), encoding="utf-8")
        code, out, _ = capture_detect(
            observations_dir=self.obs,
            state_path=self.state_path,
            events_path=self.events_path,
            frames_dir=self.frames,
        )
        self.assertEqual(code, 1)
        self.assertIn("rejected", out)
        self.assertIn("partial failure", out)
        self.assertTrue(self.events_path.is_file())

    def test_timestamp_mismatch_rejected(self):
        self.obs.mkdir()
        path = self.obs / "frame_00048.json"
        path.write_text(json.dumps(obs_doc(0, [TIMER_742])), encoding="utf-8")
        state_doc = build_match_state(
            [(0, "frame_00000.json", obs_doc(0, [TIMER_742]))]
        )
        self.state_path.write_text(json.dumps(state_doc), encoding="utf-8")
        code, out, _ = capture_detect(
            observations_dir=self.obs,
            state_path=self.state_path,
            events_path=self.events_path,
            frames_dir=self.frames,
        )
        self.assertEqual(code, 1)
        self.assertIn("rejected", out)
        self.assertFalse(self.events_path.exists())

    def test_invalid_state_rejected(self):
        self.obs.mkdir()
        path = self.obs / "frame_00000.json"
        path.write_text(json.dumps(obs_doc(0, [TIMER_742])), encoding="utf-8")
        self.state_path.write_text("not json", encoding="utf-8")
        code, _, err = capture_detect(
            observations_dir=self.obs,
            state_path=self.state_path,
            events_path=self.events_path,
            frames_dir=self.frames,
        )
        self.assertEqual(code, 1)
        self.assertIn("rebuild-state", err)
        self.assertFalse(self.events_path.exists())

    def test_stale_state_refused(self):
        self.obs.mkdir()
        for ts in (0, 48):
            path = self.obs / f"frame_{ts:05d}.json"
            path.write_text(json.dumps(obs_doc(ts, [TIMER_742])), encoding="utf-8")
        state_doc = build_match_state(
            [(0, "frame_00000.json", obs_doc(0, [TIMER_742]))]
        )
        self.state_path.write_text(json.dumps(state_doc), encoding="utf-8")
        code, _, err = capture_detect(
            observations_dir=self.obs,
            state_path=self.state_path,
            events_path=self.events_path,
            frames_dir=self.frames,
        )
        self.assertEqual(code, 1)
        self.assertIn("rebuild-state", err)
        self.assertFalse(self.events_path.exists())

    def test_no_observations_is_an_error(self):
        self.obs.mkdir()
        code, _, err = capture_detect(
            observations_dir=self.obs,
            state_path=self.state_path,
            events_path=self.events_path,
            frames_dir=self.frames,
        )
        self.assertEqual(code, 1)
        self.assertIn("no frame_", err)
        self.assertFalse(self.events_path.exists())

    def test_write_failure_preserves_previous_events(self):
        self.obs.mkdir()
        path = self.obs / "frame_00000.json"
        path.write_text(json.dumps(obs_doc(0, [TIMER_742])), encoding="utf-8")
        state_doc = build_match_state(
            [(0, "frame_00000.json", obs_doc(0, [TIMER_742]))]
        )
        self.state_path.write_text(json.dumps(state_doc), encoding="utf-8")
        code, _, _ = capture_detect(
            observations_dir=self.obs,
            state_path=self.state_path,
            events_path=self.events_path,
            frames_dir=self.frames,
        )
        self.assertEqual(code, 0)
        before = self.events_path.read_bytes()
        blocker = self.root / "blocker"
        blocker.mkdir()
        code, _, err = capture_detect(
            observations_dir=self.obs,
            state_path=self.state_path,
            events_path=blocker,
            frames_dir=self.frames,
        )
        self.assertEqual(code, 1)
        self.assertIn("left intact", err)
        self.assertEqual(self.events_path.read_bytes(), before)


class ProvenanceTests(unittest.TestCase):
    def test_events_reference_accepted_sources(self):
        docs = [obs_doc(0, [ELIM_AG_4]), obs_doc(48, [ELIM_AG_5, KILL_FEED])]
        state = build_state(*docs)
        document, counts = detect_events(triples(*docs), state)
        accepted = {f"frame_{doc['timestamp']:05d}.json" for doc in docs}
        self.assertEqual(
            set(document["generated_from"]["observations"]), accepted
        )
        self.assertEqual(document["generated_from"]["match_state"], "match_state.json")
        self.assertEqual(document["rules_evaluated"], sorted(EVENT_RULES))
        fact_ids = {fact["id"] for fact in state["facts"]}
        for event in document["events"]:
            for entry in event["sources"]:
                self.assertIn(entry["file"], accepted)
                self.assertIn(entry["fact_id"], fact_ids)
                self.assertEqual(
                    entry["timestamp"],
                    int(entry["file"].split("_")[1].split(".")[0]),
                )


class DeterminismTests(unittest.TestCase):
    def test_repeated_runs_identical(self):
        document = detect(
            obs_doc(0, [ELIM_AG_4, KILL_FEED]), obs_doc(48, [ELIM_AG_5])
        )
        again = detect(
            obs_doc(0, [ELIM_AG_4, KILL_FEED]), obs_doc(48, [ELIM_AG_5])
        )
        self.assertEqual(
            json.dumps(document, indent=2, sort_keys=True),
            json.dumps(again, indent=2, sort_keys=True),
        )


class PreservationTests(unittest.TestCase):
    def test_detection_does_not_touch_sources_or_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            obs = root / "observations"
            frames = root / "frames"
            frames.mkdir()
            for ts in (0, 48):
                path = obs / f"frame_{ts:05d}.json"
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(
                    json.dumps(obs_doc(ts, [TIMER_742])), encoding="utf-8"
                )
            from main import run_state_rebuild

            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = run_state_rebuild(
                    observations_dir=obs,
                    state_path=root / "match_state.json",
                    frames_dir=frames,
                )
            self.assertEqual(code, 0)
            before = {
                path.name: path.read_bytes()
                for path in list(obs.iterdir()) + [root / "match_state.json"]
            }
            code, _, _ = capture_detect(
                observations_dir=obs,
                state_path=root / "match_state.json",
                events_path=root / "events" / "events.json",
                frames_dir=frames,
            )
            self.assertEqual(code, 0)
            after = {
                path.name: path.read_bytes()
                for path in list(obs.iterdir()) + [root / "match_state.json"]
            }
            self.assertEqual(before, after)
            self.assertEqual(
                sorted(path.name for path in (root / "events").iterdir()),
                ["events.json"],
            )


ELIM_AG_6 = (
    "hud",
    "Bottom-left team panel for team AG showing members AG.BAROS and "
    "AG.SOLO, plus header 'Elim 6'.",
    "high",
    "Team AG panel header Elim 6.",
)
ELIM_AG_7 = (
    "hud",
    "Bottom-left team panel for team AG showing members AG.BAROS and "
    "AG.VEX, plus header 'Elim 7'.",
    "high",
    "Team AG panel header Elim 7.",
)
ELIM_AGX_5 = (
    "hud",
    "Bottom-left team panel for team AGX showing member AGX.RAY, "
    "plus header 'Elim 5'.",
    "high",
    "Team AGX panel header Elim 5.",
)
ELIM_SBUL_6 = (
    "hud",
    "Bottom-left team panel for team SBUL showing member SBUL.BUNNY, "
    "plus header 'Elim 6'.",
    "high",
    "Team SBUL panel header Elim 6.",
)
ELIM_SBUL_7 = (
    "hud",
    "Bottom-left team panel for team SBUL showing member SBUL.BUNNY, "
    "plus header 'Elim 7'.",
    "high",
    "Team SBUL panel header Elim 7.",
)
KILL_FEED_B = (
    "hud",
    "Top-right kill feed shows two more fresh entries.",
    "high",
    "Feed lines read 'TLX.ALPHA eliminated VPE.BRAVO' and "
    "'NVX.CHARLIE eliminated DRX.DELTA'.",
)
KILL_FEED_C = (
    "hud",
    "Top-right kill feed shows another pair of entries.",
    "high",
    "Feed lines read 'PQX.GOLF eliminated RSX.HOTEL' and "
    "'TUX.INDIA eliminated VWX.JULIET'.",
)
KILL_FEED_OVERLAP = (
    "hud",
    "Top-right kill feed shows overlapping entries.",
    "high",
    "Feed lines read 'RRQ.JEEK eliminated NVX.ECHO' and "
    "'SBUL.BUNNY eliminated TAG.FOXTROT'.",
)


def streak_docs(*readings):
    return [obs_doc(ts, [reading]) for ts, reading in readings]


class ElimStreakRuleTests(unittest.TestCase):
    def test_supported_streak_emitted(self):
        document = detect(*streak_docs(
            (0, ELIM_AG_4), (3, ELIM_AG_5), (6, ELIM_AG_6)
        ))
        streaks = [e for e in document["events"] if e["type"] == "elim_streak"]
        self.assertEqual(len(streaks), 1)
        streak = streaks[0]
        self.assertEqual(streak["rule"], "elim_streak/v1")
        self.assertEqual(streak["timestamp"], 6)
        self.assertEqual(streak["status"], "candidate")
        self.assertEqual(streak["confidence"], "high")
        self.assertEqual(len(streak["sources"]), 3)
        self.assertEqual(len(streak["evidence"]), 3)
        self.assertIn("AG", streak["detail"])
        self.assertIn("4->5->6", streak["detail"])
        self.assertIn("not established", streak["detail"])
        # Pairwise increases still fire alongside the streak.
        pairs = [e for e in document["events"]
                 if e["type"] == "elim_count_increased"]
        self.assertEqual([e["timestamp"] for e in pairs], [3, 6])

    def test_four_reading_chain_cites_all_sources(self):
        document = detect(*streak_docs(
            (0, ELIM_AG_4), (3, ELIM_AG_5), (6, ELIM_AG_6), (9, ELIM_AG_7)
        ))
        streaks = [e for e in document["events"] if e["type"] == "elim_streak"]
        self.assertEqual(len(streaks), 1)
        self.assertEqual(len(streaks[0]["sources"]), 4)
        self.assertEqual(len(streaks[0]["evidence"]), 4)
        pairs = [e for e in document["events"]
                 if e["type"] == "elim_count_increased"]
        self.assertEqual(len(pairs), 3)

    def test_single_step_has_no_streak(self):
        document = detect(*streak_docs((0, ELIM_AG_4), (3, ELIM_AG_5)))
        self.assertEqual(
            [e["type"] for e in document["events"]], ["elim_count_increased"]
        )

    def test_non_monotonic_chain_has_no_streak(self):
        document = detect(*streak_docs(
            (0, ELIM_AG_4), (3, ELIM_AG_6), (6, ELIM_AG_5)
        ))
        types = [e["type"] for e in document["events"]]
        self.assertNotIn("elim_streak", types)
        self.assertEqual(types, ["elim_count_increased"])

    def test_scope_change_has_no_streak(self):
        document = detect(*streak_docs(
            (0, ELIM_AG_4), (3, ELIM_AG_5), (6, ELIM_AGX_5)
        ))
        types = [e["type"] for e in document["events"]]
        self.assertNotIn("elim_streak", types)
        self.assertEqual(types, ["elim_count_increased"])

    def test_interleaved_team_streaks_fire_independently(self):
        # Each scope forms its own chain: the interleaved counters
        # neither join nor break the other team's streak.
        document = detect(*streak_docs(
            (0, ELIM_AG_4), (1, ELIM_SBUL_5), (3, ELIM_AG_5),
            (4, ELIM_SBUL_6), (6, ELIM_AG_6), (7, ELIM_SBUL_7),
        ))
        streaks = [e for e in document["events"] if e["type"] == "elim_streak"]
        self.assertEqual(len(streaks), 2)
        self.assertEqual(sorted(e["timestamp"] for e in streaks), [6, 7])
        details = sorted(e["detail"] for e in streaks)
        self.assertTrue(
            any("Team AG " in text and "4->5->6" in text for text in details)
        )
        self.assertTrue(
            any("Team SBUL " in text and "5->6->7" in text for text in details)
        )

    def test_streak_confidence_is_weakest_reading(self):
        medium = (ELIM_AG_5[0], ELIM_AG_5[1], "medium", ELIM_AG_5[3])
        document = detect(*streak_docs(
            (0, ELIM_AG_4), (3, medium), (6, ELIM_AG_6)
        ))
        streaks = [e for e in document["events"] if e["type"] == "elim_streak"]
        self.assertEqual(len(streaks), 1)
        self.assertEqual(streaks[0]["confidence"], "medium")

    def test_similar_team_names_not_merged(self):
        document = detect(*streak_docs(
            (0, ELIM_AG_4), (3, ELIM_AGX_5), (6, ELIM_AG_6)
        ))
        # Same-team readings still pair across the other scope's
        # interleaved counter, but AG and AGX never link: exactly one
        # event, the AG 4->6 increase.
        self.assertEqual(len(document["events"]), 1)
        event = document["events"][0]
        self.assertEqual(event["type"], "elim_count_increased")
        self.assertEqual(event["timestamp"], 6)
        self.assertIn("4->6", event["detail"])
        self.assertIn("Team AG ", event["detail"])

    def test_span_beyond_window_has_no_streak(self):
        document = detect(*streak_docs(
            (0, ELIM_AG_4), (3, ELIM_AG_5), (60, ELIM_AG_6)
        ))
        types = [e["type"] for e in document["events"]]
        self.assertNotIn("elim_streak", types)
        # Pairwise increases carry no window: both still fire.
        self.assertEqual(types, ["elim_count_increased"] * 2)

    def test_low_confidence_reading_breaks_chain(self):
        weak = (ELIM_AG_5[0], ELIM_AG_5[1], "low", ELIM_AG_5[3])
        document = detect(*streak_docs(
            (0, ELIM_AG_4), (3, weak), (6, ELIM_AG_6)
        ))
        types = [e["type"] for e in document["events"]]
        self.assertNotIn("elim_streak", types)
        self.assertEqual(types, ["elim_count_increased"])

    def test_roles_not_assigned_in_detail(self):
        document = detect(*streak_docs(
            (0, ELIM_AG_4), (3, ELIM_AG_5), (6, ELIM_AG_6)
        ))
        streak = [e for e in document["events"]
                  if e["type"] == "elim_streak"][0]
        self.assertIn("not established", streak["detail"])
        self.assertNotIn("killed", streak["detail"])
        self.assertNotIn("eliminated by", streak["detail"])


class FeedClusterRuleTests(unittest.TestCase):
    def test_supported_cluster_emitted(self):
        document = detect(obs_doc(0, [KILL_FEED]), obs_doc(3, [KILL_FEED_B]))
        clusters = [e for e in document["events"]
                    if e["type"] == "feed_cluster"]
        self.assertEqual(len(clusters), 1)
        cluster = clusters[0]
        self.assertEqual(cluster["rule"], "feed_cluster/v1")
        self.assertEqual(cluster["timestamp"], 3)
        self.assertEqual(cluster["status"], "candidate")
        self.assertEqual(cluster["confidence"], "high")
        self.assertEqual(len(cluster["sources"]), 2)
        self.assertEqual(len(cluster["evidence"]), 4)
        self.assertIn("RRQ.JEEK", cluster["detail"])
        self.assertIn("TLX.ALPHA", cluster["detail"])
        self.assertIn("not established", cluster["detail"])
        entries = [e for e in document["events"]
                   if e["type"] == "kill_feed_entry"]
        self.assertEqual(len(entries), 2)

    def test_single_feed_has_no_cluster(self):
        document = detect(obs_doc(0, [KILL_FEED]))
        self.assertEqual(
            [e["type"] for e in document["events"]], ["kill_feed_entry"]
        )

    def test_cluster_detail_hedges_distinctness(self):
        # Disjoint names only group a candidate cluster: the detail
        # must not claim distinct entries, since re-sightings with
        # transcription variance group the same way.
        document = detect(obs_doc(0, [KILL_FEED, KILL_FEED_B]))
        clusters = [e for e in document["events"]
                    if e["type"] == "feed_cluster"]
        self.assertEqual(len(clusters), 1)
        self.assertNotIn("distinct kill feed", clusters[0]["detail"])
        self.assertIn("repeated sightings", clusters[0]["detail"])
        self.assertIn("not established", clusters[0]["detail"])

    def test_cluster_confidence_is_weakest_entry(self):
        # A high-confidence last entry must not inflate the cluster
        # over the medium entry it rests on.
        medium = (KILL_FEED[0], KILL_FEED[1], "medium", KILL_FEED[3])
        document = detect(obs_doc(0, [medium]), obs_doc(3, [KILL_FEED_B]))
        clusters = [e for e in document["events"]
                    if e["type"] == "feed_cluster"]
        self.assertEqual(len(clusters), 1)
        self.assertEqual(clusters[0]["confidence"], "medium")

    def test_overlapping_names_have_no_cluster(self):
        document = detect(
            obs_doc(0, [KILL_FEED]), obs_doc(3, [KILL_FEED_OVERLAP])
        )
        types = [e["type"] for e in document["events"]]
        self.assertNotIn("feed_cluster", types)
        self.assertEqual(types, ["kill_feed_entry"] * 2)

    def test_span_beyond_window_has_no_cluster(self):
        document = detect(
            obs_doc(0, [KILL_FEED]), obs_doc(60, [KILL_FEED_B])
        )
        types = [e["type"] for e in document["events"]]
        self.assertNotIn("feed_cluster", types)
        self.assertEqual(types, ["kill_feed_entry"] * 2)

    def test_low_confidence_feed_breaks_cluster(self):
        weak = (KILL_FEED_B[0], KILL_FEED_B[1], "low", KILL_FEED_B[3])
        document = detect(obs_doc(0, [KILL_FEED]), obs_doc(3, [weak]))
        self.assertEqual(
            [e["type"] for e in document["events"]], ["kill_feed_entry"]
        )

    def test_three_entry_cluster_emits_once(self):
        document = detect(
            obs_doc(0, [KILL_FEED]),
            obs_doc(3, [KILL_FEED_B]),
            obs_doc(6, [KILL_FEED_C]),
        )
        clusters = [e for e in document["events"]
                    if e["type"] == "feed_cluster"]
        self.assertEqual(len(clusters), 1)
        self.assertEqual(len(clusters[0]["sources"]), 3)
        entries = [e for e in document["events"]
                   if e["type"] == "kill_feed_entry"]
        self.assertEqual(len(entries), 3)

    def test_contested_candidate_breaks_cluster(self):
        feed = obs_doc(48, [KILL_FEED])
        other = obs_doc(48, [TIMER_742])
        late = obs_doc(96, [KILL_FEED_B])
        named = [
            (48, "frame_00048.json", feed),
            (48, "frame_00048b.json", other),
            (96, "frame_00096.json", late),
        ]
        state = build_match_state(named)
        document, counts = detect_events(named, state)
        self.assertEqual(counts["contested"], [48])
        self.assertEqual(
            [e["type"] for e in document["events"]], ["kill_feed_entry"]
        )


class TemporalDedupTests(unittest.TestCase):
    def test_repeat_detection_identical_ids(self):
        docs = [
            obs_doc(0, [ELIM_AG_4, KILL_FEED]),
            obs_doc(3, [ELIM_AG_5, KILL_FEED_B]),
            obs_doc(6, [ELIM_AG_6]),
        ]
        first = detect(*docs)
        second = detect(*docs)
        self.assertTrue(
            {e["type"] for e in first["events"]} >= {"elim_streak"}
        )
        self.assertEqual(
            [e["id"] for e in first["events"]],
            [e["id"] for e in second["events"]],
        )
        self.assertEqual(first, second)

    def test_temporal_rules_listed_once(self):
        document = detect(*streak_docs(
            (0, ELIM_AG_4), (3, ELIM_AG_5), (6, ELIM_AG_6)
        ))
        self.assertEqual(document["rules_evaluated"], sorted(EVENT_RULES))
        self.assertIn("elim_streak", document["rules_evaluated"])
        self.assertIn("feed_cluster", document["rules_evaluated"])


class TemporalProvenanceTests(unittest.TestCase):
    def test_temporal_events_provenance(self):
        docs = [
            obs_doc(0, [ELIM_AG_4, KILL_FEED]),
            obs_doc(3, [ELIM_AG_5, KILL_FEED_B]),
            obs_doc(6, [ELIM_AG_6]),
        ]
        state = build_state(*docs)
        document, _ = detect_events(triples(*docs), state)
        fact_ids = {fact["id"] for fact in state["facts"]}
        temporal = [e for e in document["events"]
                    if e["type"] in ("elim_streak", "feed_cluster")]
        self.assertEqual(len(temporal), 2)
        for event in temporal:
            stamps = [entry["timestamp"] for entry in event["sources"]]
            self.assertEqual(stamps, sorted(stamps))
            self.assertEqual(event["timestamp"], max(stamps))
            for entry in event["sources"]:
                self.assertIn(entry["fact_id"], fact_ids)
        keys = [(e["timestamp"], e["type"], e["id"])
                for e in document["events"]]
        self.assertEqual(keys, sorted(keys))


class NoTemporalInferenceTests(unittest.TestCase):
    def test_timers_and_banners_yield_no_temporal_events(self):
        # Timers still yield nothing, and the repeated banner yields no
        # multi-observation pattern (streak/cluster/engagement) — only the
        # single-sighting zone_pressure candidate at its first sighting.
        document = detect(
            obs_doc(0, [TIMER_742, BANNER]),
            obs_doc(3, [TIMER_1057, BANNER]),
            obs_doc(6, [TIMER_742, BANNER]),
        )
        temporal = {"elim_streak", "feed_cluster", "combat_engagement"}
        self.assertTrue(
            all(event["type"] not in temporal for event in document["events"])
        )
        zone = [
            event for event in document["events"]
            if event["type"] == "zone_pressure"
        ]
        self.assertEqual(len(zone), 1)
        self.assertEqual(zone[0]["timestamp"], 0)


class MixedVersionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.obs = self.root / "observations"
        self.frames = self.root / "frames"
        self.frames.mkdir()
        self.state_path = self.root / "match_state.json"
        self.events_path = self.root / "events.json"

    def tearDown(self):
        self.tmp.cleanup()

    def v2_feed(self, timestamp):
        doc = obs_doc(timestamp, [KILL_FEED_B])
        doc["schema_version"] = "observation-v2"
        doc["observations"][0]["subjects"] = [
            {"label": "TLX.ALPHA", "kind": "player"}
        ]
        return doc

    def rebuild(self):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = run_state_rebuild(
                observations_dir=self.obs,
                state_path=self.state_path,
                frames_dir=self.frames,
            )
        return code

    def test_mixed_v1_v2_directory_detects(self):
        write_obs(self.obs, obs_doc(0, [KILL_FEED]))
        write_obs(self.obs, self.v2_feed(3))
        self.assertEqual(self.rebuild(), 0)
        code, _, _ = capture_detect(
            observations_dir=self.obs,
            state_path=self.state_path,
            events_path=self.events_path,
            frames_dir=self.frames,
        )
        self.assertEqual(code, 0)
        document = json.loads(self.events_path.read_text(encoding="utf-8"))
        self.assertEqual(
            sorted(e["type"] for e in document["events"]),
            ["feed_cluster", "kill_feed_entry", "kill_feed_entry"],
        )

    def test_v2_rewrite_forces_state_rebuild(self):
        write_obs(self.obs, obs_doc(0, [KILL_FEED]))
        self.assertEqual(self.rebuild(), 0)
        rewritten = obs_doc(0, [KILL_FEED])
        rewritten["schema_version"] = "observation-v2"
        write_obs(self.obs, rewritten)
        code, _, err = capture_detect(
            observations_dir=self.obs,
            state_path=self.state_path,
            events_path=self.events_path,
            frames_dir=self.frames,
        )
        self.assertEqual(code, 1)
        self.assertIn("rebuild-state", err)


if __name__ == "__main__":
    unittest.main()
