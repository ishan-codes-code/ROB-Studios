"""Project-aware opening introductions (one per session, at timestamp 0).

No live API calls: fake text clients stand in for the model, and the
project configuration arrives through the settings environment variable
exactly as Electron snapshots it.
"""

import json
import os
import re
import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import main as engine
from test_prompt_packs import pack_env


@contextmanager
def run_env(run_id=None):
    """Set AI_COMMENTATOR_RUN_ID for one test; always restore."""
    old = os.environ.get("AI_COMMENTATOR_RUN_ID")
    try:
        if run_id is None:
            os.environ.pop("AI_COMMENTATOR_RUN_ID", None)
        else:
            os.environ["AI_COMMENTATOR_RUN_ID"] = run_id
        yield
    finally:
        if old is None:
            os.environ.pop("AI_COMMENTATOR_RUN_ID", None)
        else:
            os.environ["AI_COMMENTATOR_RUN_ID"] = old


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
    # Beat prompts list "Beat <beat_id>" plus "Cite as
    # source_claim_ids: <ids>"; match a bare claim id either way.
    match = re.search(r"clm-[0-9a-f]+", prompt)
    assert match, prompt
    return match.group(0)


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
            # Only beat-wrapped claims (developments, echoes) are
            # citable; scene claims get no-beat omissions.
            wrapped = [
                claim_id for claim_id, claim in by_id.items()
                if claim["type"] != "scene"
            ]
            self.assertTrue(wrapped)

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
                    for claim_id in wrapped
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
            # Only beat-wrapped claims (developments, echoes) are
            # citable; scene claims get no-beat omissions.
            wrapped = [
                claim_id for claim_id, claim in by_id.items()
                if claim["type"] != "scene"
            ]
            self.assertTrue(wrapped)

            def handle(kwargs, index):
                return script_response(script_json([
                    {
                        "source_claim_ids": [claim_id],
                        "text": ("Here is the play: "
                                 + by_id[claim_id]["evidence"][0].lower()),
                    }
                    for claim_id in wrapped
                ]))

            client = FakeScriptClient(handle)
            with pack_env():
                code, _, _ = run_script_capture(
                    **script_kwargs(obs_dir, st, ev, out), client=client
                )
            doc = json.loads(out.read_text(encoding="utf-8"))
        self.assertEqual(code, 0)
        self.assertEqual(len(client.calls), 1)
        self.assertEqual(len(doc["segments"]), len(wrapped))


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


RUN_ID_A = "a" * 32
RUN_ID_B = "b" * 32

OPENING_LINE = "Welcome to Erangel for the City Finals semifinal."


def model_opening_handler(prompt, index):
    return opening_segment_json(claim_id_in_prompt(prompt), OPENING_LINE)


class OpeningRunIdTests(unittest.TestCase):
    def test_run_id_scopes_claim_id(self):
        claim = engine.build_opening_claim(FULL_METADATA, "BGMI")
        base = engine.claim_id_of(claim)
        with run_env():
            self.assertEqual(engine.current_opening_run_id(), "")
            self.assertEqual(engine.opening_claim_id(claim), base)
        with run_env(RUN_ID_A):
            self.assertEqual(engine.current_opening_run_id(), RUN_ID_A)
            self.assertEqual(
                engine.opening_claim_id(claim), base + "-" + RUN_ID_A[:12]
            )

    def test_two_runs_same_metadata_word_two_openings(self):
        client = RequestTextClient(model_opening_handler)
        with pack_env(settings=FULL_SETTINGS):
            with run_env(RUN_ID_A):
                first, omitted_a, claim_a = engine.run_opening(
                    client, "bgmi", set(), []
                )
            with run_env(RUN_ID_B):
                second, omitted_b, claim_b = engine.run_opening(
                    client, "bgmi", {claim_a["claim_id"]}, []
                )
        self.assertIsNone(omitted_a)
        self.assertIsNone(omitted_b)
        self.assertIsNotNone(first)
        self.assertIsNotNone(second)
        self.assertIn("Erangel", first["text"])
        self.assertIn("Erangel", second["text"])
        self.assertNotEqual(claim_a["claim_id"], claim_b["claim_id"])
        self.assertEqual(
            second["source_claim_ids"], [claim_b["claim_id"]]
        )
        self.assertEqual(len(client.calls), 2)

    def test_same_run_id_suppresses_repeat_without_new_call(self):
        client = RequestTextClient(model_opening_handler)
        with pack_env(settings=FULL_SETTINGS):
            with run_env(RUN_ID_A):
                first, _, claim_a = engine.run_opening(
                    client, "bgmi", set(), []
                )
            with run_env(RUN_ID_A):
                second, omitted, claim_b = engine.run_opening(
                    client, "bgmi", {claim_a["claim_id"]}, []
                )
        self.assertIsNotNone(first)
        self.assertIsNone(second)
        self.assertIsNone(claim_b)
        self.assertIsNotNone(omitted)
        self.assertEqual(omitted["rule"], "already-emitted")
        self.assertEqual(omitted["subject"], claim_a["claim_id"])
        self.assertEqual(len(client.calls), 1)


class OpeningOnlyScriptTests(unittest.TestCase):
    def run_opening_only(self, tmp):
        from test_script import (
            FakeScriptClient,
            run_script_capture,
            script_kwargs,
            script_response,
            silence_tree,
        )

        obs_dir, st, ev, _ = silence_tree(tmp)
        out = Path(tmp) / "script.json"

        def handle(kwargs, index):
            content = kwargs["messages"][0]["content"]
            claim_id = claim_id_in_prompt(content)
            return script_response(
                opening_segment_json(claim_id, OPENING_LINE)
            )

        client = FakeScriptClient(handle)
        with pack_env(settings=FULL_SETTINGS):
            with run_env(RUN_ID_A):
                code, _, _ = run_script_capture(
                    **script_kwargs(obs_dir, st, ev, out), client=client
                )
        return code, out, client

    def test_zero_gameplay_claims_with_metadata_is_opening_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, out, client = self.run_opening_only(tmp)
            doc = json.loads(out.read_text(encoding="utf-8"))
        self.assertEqual(code, 0)
        self.assertEqual(doc["status"], "success")
        self.assertIsNone(doc["error"])
        self.assertEqual(len(doc["segments"]), 1)
        segment = doc["segments"][0]
        self.assertEqual(segment["segment_id"], "segment-001")
        self.assertEqual(segment["timestamp_seconds"], 0)
        self.assertIn("Erangel", segment["text"])
        self.assertEqual(len(client.calls), 1)
        engine.validate_script(doc)

    def test_opening_only_script_feeds_tts_success(self):
        import contextlib
        import io

        from test_tts import FakeTTSClient

        with tempfile.TemporaryDirectory() as tmp:
            code, out, _ = self.run_opening_only(tmp)
            self.assertEqual(code, 0)
            doc = json.loads(out.read_text(encoding="utf-8"))
            engine.validate_script(doc)
            audio_dir = Path(tmp) / "audio"
            fake = FakeTTSClient()
            stdout, stderr = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(stdout):
                with contextlib.redirect_stderr(stderr):
                    tts_code = engine.run_generate_tts(
                        script_path=out,
                        audio_dir=audio_dir,
                        api_key="test-tts-key-not-a-secret",
                        client=fake,
                    )
            self.assertEqual(tts_code, 0)
            manifest = engine.validate_tts_manifest(
                json.loads(
                    (audio_dir / "tts.json").read_text(encoding="utf-8")
                )
            )
            self.assertEqual(len(fake.calls), 1)
            self.assertEqual(manifest["status"], "success")
            self.assertEqual(len(manifest["entries"]), 1)
            entry = manifest["entries"][0]
            self.assertEqual(entry["segment_id"], "segment-001")
            self.assertEqual(entry["timestamp_seconds"], 0)
            self.assertEqual(entry["status"], "success")
            self.assertIsNone(entry["error"])
            self.assertTrue(
                (audio_dir / entry["audio_file"]).is_file()
            )

    def test_zero_claims_without_metadata_stays_silent(self):
        from test_script import (
            FakeScriptClient,
            run_script_capture,
            script_json,
            script_kwargs,
            script_response,
            silence_tree,
        )

        with tempfile.TemporaryDirectory() as tmp:
            obs_dir, st, ev, _ = silence_tree(tmp)
            out = Path(tmp) / "script.json"
            client = FakeScriptClient(
                lambda kwargs, index: script_response(script_json([]))
            )
            with pack_env():
                with run_env(RUN_ID_A):
                    code, _, _ = run_script_capture(
                        **script_kwargs(obs_dir, st, ev, out),
                        client=client,
                    )
            doc = json.loads(out.read_text(encoding="utf-8"))
        self.assertEqual(code, 0)
        self.assertEqual(doc["status"], "silence")
        self.assertEqual(doc["segments"], [])
        self.assertEqual(client.calls, [])


class OpeningLanguageTests(unittest.TestCase):
    def test_hindi_language_clause_in_prompt(self):
        settings = json.dumps({
            "game": {
                "id": "bgmi",
                "metadata": {
                    "map": "Erangel",
                    "tournament": "City Finals",
                },
            },
            "prompt": {"language": "Hindi"},
            "promptPack": {"packId": "bgmi", "custom": {}},
        })
        with pack_env(settings=settings):
            meta = engine.project_opening_metadata()
            self.assertEqual(meta["language"], "Hindi")
            self.assertTrue(engine.opening_available(meta))
            claim = engine.build_opening_claim(meta, "BGMI")
            claim_id = engine.claim_id_of(claim)
            prompt = engine.build_opening_prompt(
                claim, claim_id, meta, [], "bgmi"
            )
        self.assertIn("Write the line in Hindi.", prompt)

    def test_missing_language_adds_no_clause(self):
        meta = dict(FULL_METADATA, language="")
        claim = engine.build_opening_claim(meta, "BGMI")
        claim_id = engine.claim_id_of(claim)
        with pack_env(settings=FULL_SETTINGS):
            prompt = engine.build_opening_prompt(
                claim, claim_id, meta, [], "bgmi"
            )
        self.assertNotIn("Write the line in", prompt)


class OpeningPackLabelTests(unittest.TestCase):
    def test_packs_word_own_game_labels(self):
        doc = json.loads(FULL_SETTINGS)
        doc["game"]["metadata"].pop("tournament", None)
        doc["game"]["metadata"].pop("stage", None)
        settings = json.dumps(doc)
        expected = (("cod", "Call of Duty"), ("bgmi", "BGMI"))
        for pack_id, label in expected:
            other = expected[1][1] if pack_id == "cod" else expected[0][1]
            with self.subTest(pack=pack_id):
                with pack_env(settings=settings):
                    with run_env():
                        utterance, omitted, claim = engine.run_opening(
                            None, pack_id, set(), []
                        )
                self.assertIsNone(omitted)
                self.assertIsNotNone(utterance)
                self.assertIn(label, utterance["text"])
                self.assertNotIn(other, utterance["text"])
                self.assertIn(label, " ".join(claim["evidence"]))


if __name__ == "__main__":
    unittest.main()
