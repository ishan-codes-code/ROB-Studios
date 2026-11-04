"""Project-aware opening introductions (one per session, at timestamp 0).

No live API calls: fake text clients stand in for the model, and the
project configuration arrives through the settings environment variable
exactly as Electron snapshots it.
"""

import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import main as engine
from test_prompt_packs import pack_env

FULL_METADATA = {
    "game_id": "bgmi",
    "match_type": "Battle Royale",
    "mode": "Squad",
    "map": "Erangel",
    "category": "Tournament",
    "teams": ["Team A", "Team B"],
    "tournament": "City Finals",
    "stage": "Semifinal",
    "additional_context": "Night match.",
    "language": "English",
}

FULL_SETTINGS = json.dumps({
    "game": {
        "id": "bgmi",
        "context": "Mode: Squad. Match: Battle Royale. Map: Erangel.",
        "metadata": {
            "matchType": "Battle Royale",
            "mode": "Squad",
            "map": "Erangel",
            "category": "Tournament",
            "teams": ["Team A", "Team B"],
            "tournament": "City Finals",
            "stage": "Semifinal",
            "additionalContext": "Night match.",
        },
    },
    "prompt": {
        "personality": "Esports commentator",
        "tone": "energetic",
        "language": "English",
        "instructions": "",
    },
    "promptPack": {"packId": "bgmi", "custom": {}},
})


class RequestTextClient:
    """Minimal request_text fake recording prompts."""

    def __init__(self, handler):
        self._handler = handler
        self.calls = []

    def request_text(self, prompt, purpose=None):
        self.calls.append(prompt)
        return self._handler(prompt, len(self.calls) - 1)

    def close(self):
        pass


def opening_segment_json(claim_id, text):
    return json.dumps(
        {"segments": [{"source_claim_ids": [claim_id], "text": text}]}
    )


def claim_id_in_prompt(prompt):
    match = re.search(r"Claim (\S+)", prompt)
    assert match, prompt
    return match.group(1)


class OpeningMetadataTests(unittest.TestCase):
    def test_full_settings_parse(self):
        with pack_env(settings=FULL_SETTINGS):
            meta = engine.project_opening_metadata()
        self.assertEqual(meta, FULL_METADATA)

    def test_missing_settings_mean_no_opening(self):
        with pack_env():
            meta = engine.project_opening_metadata()
        self.assertEqual(meta["game_id"], "")
        self.assertEqual(meta["teams"], [])
        self.assertFalse(engine.opening_available(meta))
        with pack_env():
            self.assertFalse(engine.opening_available())

    def test_malformed_settings_are_safe(self):
        with pack_env(settings="not json{{"):
            meta = engine.project_opening_metadata()
        self.assertEqual(meta["game_id"], "")
        self.assertFalse(engine.opening_available(meta))

    def test_wrong_shapes_and_bounds(self):
        settings = json.dumps({
            "game": {"id": "bgmi", "metadata": {
                "map": "x" * 500,
                "teams": ["A", 42, None, "  ", "B"],
                "tournament": 42,
            }},
            "prompt": {"language": "English"},
        })
        with pack_env(settings=settings):
            meta = engine.project_opening_metadata()
        self.assertEqual(meta["map"], "x" * 80)
        self.assertEqual(meta["teams"], ["A", "B"])
        self.assertEqual(meta["tournament"], "")
        self.assertTrue(engine.opening_available(meta))

    def test_partial_project_still_available(self):
        meta = dict(FULL_METADATA, game_id="", tournament="",
                    teams=[], match_type="", mode="", map="Erangel",
                    category="", stage="", additional_context="")
        self.assertTrue(engine.opening_available(meta))


class OpeningClaimTests(unittest.TestCase):
    def test_claim_quotes_configured_fields_only(self):
        claim = engine.build_opening_claim(FULL_METADATA, "BGMI")
        self.assertEqual(claim["type"], "opening")
        self.assertEqual(claim["template"], "opening_intro")
        self.assertEqual(claim["timestamp"], 0)
        joined = " ".join(claim["evidence"])
        for expected in ("BGMI", "Battle Royale", "Squad", "Erangel",
                         "Tournament", "City Finals", "Semifinal",
                         "Team A", "Team B", "Night match."):
            self.assertIn(expected, joined)

    def test_missing_fields_leave_no_phrase(self):
        meta = dict(FULL_METADATA, tournament="", stage="", teams=[],
                    additional_context="")
        claim = engine.build_opening_claim(meta, "BGMI")
        joined = " ".join(claim["evidence"])
        self.assertNotIn("Tournament:", joined)
        self.assertNotIn("Stage:", joined)
        self.assertNotIn("Teams:", joined)
        self.assertIn("Map: Erangel.", joined)

    def test_claim_id_is_stable_per_configuration(self):
        first = engine.claim_id_of(engine.build_opening_claim(FULL_METADATA, "BGMI"))
        second = engine.claim_id_of(engine.build_opening_claim(dict(FULL_METADATA), "BGMI"))
        self.assertEqual(first, second)
        changed = engine.claim_id_of(
            engine.build_opening_claim(dict(FULL_METADATA, map="Miramar"), "BGMI")
        )
        self.assertNotEqual(first, changed)


class OpeningTemplateTests(unittest.TestCase):
    def test_template_introduces_configured_details(self):
        text = engine.render_opening_template(FULL_METADATA, "BGMI")
        self.assertIn("City Finals", text)
        self.assertIn("Semifinal", text)
        self.assertIn("Erangel", text)
        self.assertIn("Team A", text)
        self.assertIn("Team B", text)

    def test_template_without_optionals_invents_nothing(self):
        meta = dict(FULL_METADATA, tournament="", stage="", teams=[],
                    additional_context="", match_type="", mode="")
        text = engine.render_opening_template(meta, "BGMI")
        self.assertIn("Erangel", text)
        self.assertIn("BGMI", text)
        for invented in ("City Finals", "Semifinal", "Team A", "versus",
                         "FIFA", "Free Fire", "Call of Duty"):
            self.assertNotIn(invented, text)

    def test_template_always_validates(self):
        cases = [
            FULL_METADATA,
            dict(FULL_METADATA, tournament="", stage="", teams=[],
                 additional_context="", match_type="", mode="", map=""),
            dict(FULL_METADATA, map="Killhouse Arena",
                 teams=["RRQ.JEEK", "OG.IQOOPAWDI"],
                 tournament="Stars *Cup* `Finals`"),
            dict(FULL_METADATA, teams=["Team 7", "Squad Eleven"]),
        ]
        for meta in cases:
            claim = engine.build_opening_claim(meta, "BGMI")
            text = engine.render_opening_template(meta, "BGMI")
            self.assertTrue(
                engine.script_text_valid(text, [claim]),
                f"template failed validation: {text!r}",
            )

    def test_template_caps_length(self):
        meta = dict(FULL_METADATA, map="M" * 80, tournament="T" * 80,
                    stage="S" * 80, match_type="B" * 80, mode="S" * 80,
                    teams=["A" * 80, "B" * 80])
        text = engine.render_opening_template(meta, "BGMI")
        self.assertLessEqual(len(text), 500)
        self.assertTrue(text.startswith("Welcome to"))


class OpeningPromptTests(unittest.TestCase):
    def test_prompt_grounds_model_in_project_details(self):
        claim = engine.build_opening_claim(FULL_METADATA, "BGMI")
        claim_id = engine.claim_id_of(claim)
        with pack_env(settings=FULL_SETTINGS):
            prompt = engine.build_opening_prompt(
                claim, claim_id, FULL_METADATA, [], "bgmi"
            )
        self.assertIn(claim_id, prompt)
        self.assertIn("Erangel", prompt)
        self.assertIn("City Finals", prompt)
        self.assertIn("Team A", prompt)
        self.assertIn('"segments"', prompt)
        self.assertIn("ONLY a single JSON object", prompt)
        self.assertIn("Never invent", prompt)


class RunOpeningTests(unittest.TestCase):
    def test_no_metadata_makes_no_call(self):
        client = RequestTextClient(lambda prompt, index: "{}")
        with pack_env():
            utterance, omitted, claim = engine.run_opening(
                client, None, set(), []
            )
        self.assertIsNone(utterance)
        self.assertIsNone(omitted)
        self.assertIsNone(claim)
        self.assertEqual(client.calls, [])

    def test_model_wording_wins_when_valid(self):
        def handle(prompt, index):
            claim_id = claim_id_in_prompt(prompt)
            return opening_segment_json(
                claim_id, "Welcome to Erangel for the City Finals semifinal."
            )

        client = RequestTextClient(handle)
        with pack_env(settings=FULL_SETTINGS):
            utterance, omitted, claim = engine.run_opening(
                client, "bgmi", set(), []
            )
        self.assertIsNone(omitted)
        self.assertIsNotNone(utterance)
        self.assertEqual(utterance["timestamp"], 0)
        self.assertIn("Erangel", utterance["text"])
        self.assertEqual(utterance["source_claim_ids"], [claim["claim_id"]])
        self.assertEqual(claim["timestamp"], 0)

    def test_model_failure_falls_back_to_template(self):
        def handle(prompt, index):
            raise engine.WriterAPIError("Fake opening failure.")

        client = RequestTextClient(handle)
        with pack_env(settings=FULL_SETTINGS):
            utterance, omitted, claim = engine.run_opening(
                client, "bgmi", set(), []
            )
        self.assertIsNone(omitted)
        self.assertIsNotNone(utterance)
        self.assertEqual(utterance["timestamp"], 0)
        self.assertIn("City Finals", utterance["text"])

    def test_invalid_model_wording_falls_back_to_template(self):
        def handle(prompt, index):
            claim_id = claim_id_in_prompt(prompt)
            return opening_segment_json(
                claim_id, "Two teams killed everyone because they are the best!"
            )

        client = RequestTextClient(handle)
        with pack_env(settings=FULL_SETTINGS):
            utterance, omitted, claim = engine.run_opening(
                client, "bgmi", set(), []
            )
        self.assertIsNone(omitted)
        self.assertIsNotNone(utterance)
        self.assertNotIn("killed", utterance["text"])

    def test_missing_client_uses_template(self):
        with pack_env(settings=FULL_SETTINGS):
            utterance, omitted, claim = engine.run_opening(None, "bgmi", set(), [])
        self.assertIsNone(omitted)
        self.assertIsNotNone(utterance)
        self.assertEqual(utterance["timestamp"], 0)

    def test_already_emitted_suppresses_repeat(self):
        claim = engine.build_opening_claim(FULL_METADATA, "BGMI")
        claim_id = engine.claim_id_of(claim)
        client = RequestTextClient(lambda prompt, index: "{}")
        with pack_env(settings=FULL_SETTINGS):
            utterance, omitted, __ = engine.run_opening(
                client, "bgmi", {claim_id}, []
            )
        self.assertIsNone(utterance)
        self.assertIsNotNone(omitted)
        self.assertEqual(omitted["rule"], "already-emitted")
        self.assertEqual(client.calls, [])


class SequentialOpeningTests(unittest.TestCase):
    def test_script_prepends_opening_at_zero(self):
        from test_script import (
            FakeScriptClient,
            gate_script_claims,
            run_script_capture,
            script_json,
            script_response,
            script_kwargs,
            two_claim_tree,
        )

        with tempfile.TemporaryDirectory() as tmp:
            obs_dir, st, ev, _ = two_claim_tree(tmp)
            out = Path(tmp) / "script.json"
            by_id = gate_script_claims(obs_dir, st, ev)
            self.assertTrue(by_id)

            def handle(kwargs, index):
                content = kwargs["messages"][0]["content"]
                if index == 0:
                    claim_id = claim_id_in_prompt(content)
                    return script_response(opening_segment_json(
                        claim_id,
                        "Welcome to Erangel for the City Finals semifinal.",
                    ))
                return script_response(script_json([
                    {
                        "source_claim_ids": [claim_id],
                        "text": ("Opening noted, and here is the play: "
                                 + by_id[claim_id]["evidence"][0].lower()),
                    }
                    for claim_id in by_id
                ]))

            client = FakeScriptClient(handle)
            with pack_env(settings=FULL_SETTINGS):
                code, _, _ = run_script_capture(
                    **script_kwargs(obs_dir, st, ev, out), client=client
                )
            doc = json.loads(out.read_text(encoding="utf-8"))
        self.assertEqual(code, 0)
        self.assertEqual(doc["status"], "success")
        self.assertGreaterEqual(len(doc["segments"]), 2)
        first = doc["segments"][0]
        self.assertEqual(first["segment_id"], "segment-001")
        self.assertEqual(first["timestamp_seconds"], 0)
        self.assertIn("Erangel", first["text"])
        # Provenance still validates with the synthetic claim registered.
        engine.validate_script(doc)

    def test_script_without_metadata_is_unchanged(self):
        from test_script import (
            FakeScriptClient,
            gate_script_claims,
            run_script_capture,
            script_json,
            script_response,
            script_kwargs,
            two_claim_tree,
        )

        with tempfile.TemporaryDirectory() as tmp:
            obs_dir, st, ev, _ = two_claim_tree(tmp)
            out = Path(tmp) / "script.json"
            by_id = gate_script_claims(obs_dir, st, ev)

            def handle(kwargs, index):
                return script_response(script_json([
                    {
                        "source_claim_ids": [claim_id],
                        "text": ("Here is the play: "
                                 + by_id[claim_id]["evidence"][0].lower()),
                    }
                    for claim_id in by_id
                ]))

            client = FakeScriptClient(handle)
            with pack_env():
                code, _, _ = run_script_capture(
                    **script_kwargs(obs_dir, st, ev, out), client=client
                )
            doc = json.loads(out.read_text(encoding="utf-8"))
        self.assertEqual(code, 0)
        self.assertEqual(len(client.calls), 1)
        self.assertEqual(len(doc["segments"]), len(by_id))


class StreamingOpeningTests(unittest.TestCase):
    def test_streaming_leads_with_opening(self):
        from test_streaming import (
            ENV_A,
            FakeTextClient,
            drain_pipeline,
            scene_obs,
        )

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_path = root / "script.json"
            commentary_path = root / "commentary.json"
            pipeline = engine.StreamingPipeline(
                script_path=script_path,
                commentary_path=commentary_path,
                audio_dir=None,
                tts_config=None,
                script_client=FakeTextClient(),
                tts_client=None,
            )
            submissions = [
                (timestamp, source, validated, "NORMAL")
                for timestamp, source, validated in (
                    scene_obs(0, ENV_A),
                    scene_obs(3, ENV_A),
                    scene_obs(6, ENV_A),
                )
            ]
            with pack_env(settings=FULL_SETTINGS):
                script_events, _, result = drain_pipeline(pipeline, submissions)
            doc = json.loads(script_path.read_text(encoding="utf-8"))
        worded = [e for e in script_events if e["status"] == "worded"]
        self.assertTrue(worded)
        self.assertEqual(worded[0]["timestamp_seconds"], 0)
        self.assertEqual(result["script_status"], "success")
        self.assertEqual(doc["segments"][0]["timestamp_seconds"], 0)


if __name__ == "__main__":
    unittest.main()
