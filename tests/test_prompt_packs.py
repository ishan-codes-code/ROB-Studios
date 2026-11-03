"""Game prompt packs: factory defaults, resolution, and builder threading."""

import json
import os
import sys
import unittest
from contextlib import contextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))

import main as engine


@contextmanager
def pack_env(pack_id=None, settings=None):
    old_pack = os.environ.get("AI_COMMENTATOR_PACK_ID")
    old_settings = os.environ.get("AI_COMMENTATOR_SETTINGS_JSON")
    try:
        if pack_id is None:
            os.environ.pop("AI_COMMENTATOR_PACK_ID", None)
        else:
            os.environ["AI_COMMENTATOR_PACK_ID"] = pack_id
        if settings is None:
            os.environ.pop("AI_COMMENTATOR_SETTINGS_JSON", None)
        else:
            os.environ["AI_COMMENTATOR_SETTINGS_JSON"] = settings
        yield
    finally:
        if old_pack is None:
            os.environ.pop("AI_COMMENTATOR_PACK_ID", None)
        else:
            os.environ["AI_COMMENTATOR_PACK_ID"] = old_pack
        if old_settings is None:
            os.environ.pop("AI_COMMENTATOR_SETTINGS_JSON", None)
        else:
            os.environ["AI_COMMENTATOR_SETTINGS_JSON"] = old_settings


def sample_claim():
    return {
        "claim_id": "clm-abcdef012345",
        "type": "development",
        "template": "development_new",
        "evidence": ["Kill feed shows a new entry."],
        "source_ids": ["obs-1"],
        "timestamp": 9,
        "confidence": "high",
        "qualification": None,
    }


class FactoryPackTests(unittest.TestCase):
    def test_all_three_packs_available(self):
        document = engine.list_factory_packs()
        self.assertEqual(document["schema_version"], "game-pack-v1")
        self.assertEqual(document["default_pack_id"], "free-fire")
        by_id = {pack["pack_id"]: pack for pack in document["packs"]}
        self.assertEqual(set(by_id), {"free-fire", "cod", "bgmi"})
        for pack in document["packs"]:
            self.assertEqual(set(pack["fields"]), set(engine.PACK_FIELDS))
            for key, text in pack["fields"].items():
                self.assertIsInstance(text, str, key)
                if key != "game_context":
                    self.assertTrue(text.strip(), key)

    def test_factory_packs_are_game_specific(self):
        free_fire = engine.get_factory_pack("free-fire")["fields"]
        cod = engine.get_factory_pack("cod")["fields"]
        bgmi = engine.get_factory_pack("bgmi")["fields"]
        self.assertIn("Free Fire", free_fire["vision_intro"])
        self.assertIn("scorestreak", cod["vision_coverage_adaptive"].lower())
        self.assertIn("armor", cod["game_context"].lower())
        self.assertIn("blue-zone", bgmi["vision_coverage_adaptive"].lower())
        self.assertIn("boost", bgmi["game_context"].lower())
        # Packs differ by more than the game name.
        self.assertNotEqual(
            cod["vision_coverage_adaptive"].replace("Call of Duty", ""),
            free_fire["vision_coverage_adaptive"].replace("Free Fire", ""),
        )

    def test_factory_defaults_are_immutable_to_callers(self):
        first = engine.get_factory_pack("cod")
        first["fields"]["vision_intro"] = "mutated"
        second = engine.get_factory_pack("cod")
        self.assertNotEqual(second["fields"]["vision_intro"], "mutated")
        document = engine.list_factory_packs()
        document["packs"][0]["fields"]["vision_intro"] = "mutated"
        fresh = engine.list_factory_packs()
        self.assertNotEqual(fresh["packs"][0]["fields"]["vision_intro"], "mutated")

    def test_unknown_pack_rejected(self):
        with self.assertRaises(ValueError):
            engine.get_factory_pack("unknown-game")


class ResolutionTests(unittest.TestCase):
    def test_default_is_free_fire_without_customization(self):
        with pack_env():
            resolved = engine.resolve_pack()
        self.assertEqual(resolved["pack_id"], "free-fire")
        self.assertEqual(resolved["customized"], [])

    def test_env_pack_id_selects_pack(self):
        with pack_env(pack_id="bgmi"):
            resolved = engine.resolve_pack()
        self.assertEqual(resolved["pack_id"], "bgmi")
        self.assertIn("BGMI", resolved["fields"]["vision_intro"])

    def test_settings_pack_selection_wins_over_pack_id(self):
        settings = json.dumps({"promptPack": {"packId": "cod", "custom": {}}})
        with pack_env(pack_id="bgmi", settings=settings):
            resolved = engine.resolve_pack()
        self.assertEqual(resolved["pack_id"], "cod")

    def test_custom_overlay_and_reset_semantics(self):
        custom = {"script_closing": "Custom closing.", "vision_intro": "  "}
        resolved = engine.resolve_pack("free-fire", custom)
        self.assertEqual(resolved["customized"], ["script_closing"])
        self.assertEqual(resolved["fields"]["script_closing"], "Custom closing.")
        # Blank custom text falls back to the factory default.
        factory = engine.get_factory_pack("free-fire")["fields"]
        self.assertEqual(resolved["fields"]["vision_intro"], factory["vision_intro"])

    def test_invalid_custom_rejected(self):
        with self.assertRaises(ValueError):
            engine.resolve_pack("free-fire", {"no-such-field": "x"})
        with self.assertRaises(ValueError):
            engine.resolve_pack("free-fire", {"script_closing": 42})
        with self.assertRaises(ValueError):
            engine.resolve_pack("free-fire", {"game_label": "x" * 81})
        with self.assertRaises(ValueError):
            engine.resolve_pack("unknown-game", {})

    def test_malformed_settings_fall_back_to_default(self):
        with pack_env(settings="not json{{"):
            resolved = engine.resolve_pack()
        self.assertEqual(resolved["pack_id"], "free-fire")
        self.assertEqual(resolved["customized"], [])

    def test_effective_game_context_combines_pack_and_profile(self):
        settings = json.dumps({"game": {"context": "User map notes."}})
        with pack_env(pack_id="cod", settings=settings):
            combined = engine.effective_game_context(None)
        self.assertIn("scorestreak", combined.lower())
        self.assertIn("User map notes.", combined)
        with pack_env():
            self.assertEqual(engine.effective_game_context(None), "")


class BuilderThreadingTests(unittest.TestCase):
    def test_default_builders_use_free_fire_factory(self):
        with pack_env():
            vision = engine.build_vision_prompt(0)
            adaptive = engine.build_adaptive_vision_prompt(0)
            script = engine.build_script_prompt([sample_claim()], [])
            writer = engine.build_writer_prompt([sample_claim()], [])
        self.assertIn("Free Fire", vision)
        self.assertIn("Free Fire", adaptive)
        self.assertIn("Free Fire", script)
        self.assertIn("Free Fire", writer)
        for prompt in (vision, adaptive):
            self.assertIn("observation-v1", prompt)

    def test_pack_argument_changes_wording_not_shape(self):
        with pack_env():
            adaptive = engine.build_adaptive_vision_prompt(0, pack="cod")
            script = engine.build_script_prompt([sample_claim()], [], pack="bgmi")
        self.assertIn("Call of Duty", adaptive)
        self.assertIn("observation-v1", adaptive)
        self.assertIn('"HIGH"', adaptive)
        self.assertIn("BGMI", script)
        self.assertIn('"segments"', script)

    def test_custom_overlay_reaches_builders(self):
        settings = json.dumps({
            "promptPack": {"packId": "free-fire", "custom": {"script_closing": "Custom closing."}},
        })
        with pack_env(settings=settings):
            script = engine.build_script_prompt([sample_claim()], [])
        self.assertIn("Custom closing.", script)
        self.assertNotIn("Omit any item you cannot word safely.", script)

    def test_env_pack_id_reaches_builders(self):
        with pack_env(pack_id="bgmi"):
            adaptive = engine.build_adaptive_vision_prompt(0)
        self.assertIn("BGMI", adaptive)


class PromptPackProbeTests(unittest.TestCase):
    def test_probe_emits_factory_document(self):
        import subprocess

        probe = Path(__file__).resolve().parent.parent / "python" / "prompt_packs.py"
        proc = subprocess.run(
            [sys.executable, str(probe)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=60,
        )
        self.assertEqual(proc.returncode, 0, msg=proc.stderr)
        document = json.loads(proc.stdout.strip().splitlines()[-1])
        self.assertTrue(document["ok"])
        self.assertEqual(document["schema_version"], "game-pack-v1")
        self.assertEqual(document["default_pack_id"], "free-fire")
        self.assertEqual(
            {pack["pack_id"] for pack in document["packs"]},
            {"free-fire", "cod", "bgmi"},
        )
        self.assertEqual(set(document["fields"]), set(engine.PACK_FIELDS))


if __name__ == "__main__":
    unittest.main()
