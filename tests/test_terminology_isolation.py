"""Game terminology isolation: pack resolution, assembled prompts, validators."""

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


def sample_claim(evidence=None):
    return {
        "claim_id": "clm-abcdef012345",
        "type": "development",
        "template": "development_new",
        "evidence": evidence or ["Kill feed shows a new entry."],
        "source_ids": ["obs-1"],
        "timestamp": 9,
        "confidence": "high",
        "qualification": None,
    }


def assembled_prompts(pack_id):
    """Fully assembled prompts for one pack across every builder path."""
    with pack_env(pack_id=pack_id):
        return {
            "vision": engine.build_vision_prompt(0),
            "adaptive": engine.build_adaptive_vision_prompt(0),
            "batch": engine.build_adaptive_batch_prompt([0, 1], None),
            "script": engine.build_script_prompt([sample_claim()], []),
            "writer": engine.build_writer_prompt([sample_claim()], []),
        }


class PackResolutionIsolationTests(unittest.TestCase):
    def test_each_game_resolves_to_its_own_pack(self):
        for game_id in ("free-fire", "bgmi", "cod"):
            settings = json.dumps({"game": {"id": game_id}})
            with pack_env(settings=settings):
                resolved = engine.resolve_pack()
            self.assertEqual(resolved["pack_id"], game_id, game_id)

    def test_each_game_default_is_independent(self):
        self.assertEqual(engine.default_pack_id_for_game("free-fire"), "free-fire")
        self.assertEqual(engine.default_pack_id_for_game("bgmi"), "bgmi")
        self.assertEqual(engine.default_pack_id_for_game("cod"), "cod")

    def test_explicit_pack_selection_follows_precedence(self):
        # Settings snapshot wins over the standalone env var.
        settings = json.dumps({"promptPack": {"packId": "bgmi", "custom": {}}})
        with pack_env(pack_id="cod", settings=settings):
            self.assertEqual(engine.resolve_pack()["pack_id"], "bgmi")
        # Standalone env var wins over the project game default.
        settings = json.dumps({"game": {"id": "bgmi"}})
        with pack_env(pack_id="cod", settings=settings):
            self.assertEqual(engine.resolve_pack()["pack_id"], "cod")

    def test_unknown_game_id_uses_documented_default(self):
        # Intentional fallback: unknown/missing games use the Free Fire
        # application default (documented in resolution + prompt-packs).
        for game_id in ("unknown-game", "", None):
            payload = {} if game_id is None else {"game": {"id": game_id}}
            with pack_env(settings=json.dumps(payload)):
                resolved = engine.resolve_pack()
            self.assertEqual(resolved["pack_id"], "free-fire", repr(game_id))

    def test_invalid_explicit_pack_fails_loudly(self):
        # An invalid explicit selection must never silently become
        # another game's pack: resolution raises instead.
        with self.assertRaises(ValueError):
            engine.resolve_pack("no-such-pack", {})
        settings = json.dumps({"promptPack": {"packId": "no-such-pack"}})
        with pack_env(settings=settings):
            with self.assertRaises(ValueError):
                engine.resolve_pack()

    def test_switching_projects_cannot_reuse_previous_pack(self):
        # Resolution reads the environment fresh on every call: no cache
        # survives a project switch.
        with pack_env(settings=json.dumps({"game": {"id": "bgmi"}})):
            self.assertEqual(engine.resolve_pack()["pack_id"], "bgmi")
        with pack_env(settings=json.dumps({"game": {"id": "cod"}})):
            resolved = engine.resolve_pack()
            self.assertEqual(resolved["pack_id"], "cod")
            self.assertIn("operator", " ".join(resolved["fields"].values()))
        with pack_env(settings=json.dumps({"game": {"id": "free-fire"}})):
            self.assertEqual(engine.resolve_pack()["pack_id"], "free-fire")


class AssembledPromptIsolationTests(unittest.TestCase):
    # Multi-word, game-specific terms that must never appear in another
    # game's fully assembled prompts. Generic single words (knock,
    # zone, elimination) are deliberately excluded: they are valid in
    # multiple games and are covered by meaning-specific tests below.
    FORBIDDEN = {
        "free-fire": ["blue zone", "blue-zone", "chicken dinner", "hardpoint",
                      "scorestreak", "killstreak", "dog tag", "operator",
                      "domination", "flare", "airdrop", "lethal", "tactical"],
        "bgmi": ["blue wall", "gloo", "booyah", "scorestreak", "killstreak",
                 "operator", "dog tag", "hardpoint", "domination",
                 "clash squad", "lethal", "tactical"],
        "cod": ["blue wall", "gloo", "booyah", "blue zone", "blue-zone",
                "red zone", "red-zone", "chicken dinner", "flare",
                "airdrop", "clash squad", "med kit"],
    }

    def test_no_cross_game_leakage_in_any_builder_path(self):
        for pack_id, terms in self.FORBIDDEN.items():
            prompts = assembled_prompts(pack_id)
            for path, prompt in prompts.items():
                lowered = prompt.lower()
                for term in terms:
                    self.assertNotIn(
                        term, lowered,
                        f"{pack_id}.{path} must not contain {term!r}",
                    )

    def test_cod_knock_anomaly_fixed(self):
        # COD vocabulary is downed/eliminated operators, never knocks:
        # the script rules must not present "knock" as a COD outcome.
        fields = engine.get_factory_pack("cod")["fields"]
        self.assertIn("confirmed kill, elimination, or victory",
                      fields["script_rules"])
        self.assertNotIn("confirmed kill, knock", fields["script_rules"])


class CorrectTerminologyTests(unittest.TestCase):
    def test_free_fire_blue_wall_wording(self):
        prompts = assembled_prompts("free-fire")
        for path, prompt in prompts.items():
            if path in ("vision", "adaptive", "batch"):
                self.assertIn("Blue Wall", prompt, path)
        script_rules = engine.get_factory_pack("free-fire")["fields"]["script_rules"]
        self.assertIn("Blue Wall (never shield)", script_rules)
        self.assertIn("Booyah only", script_rules)

    def test_free_fire_knock_is_not_elimination(self):
        fields = engine.get_factory_pack("free-fire")["fields"]
        self.assertIn("knocked down", fields["script_rules"])
        self.assertIn("(never eliminated)", fields["script_rules"])
        writer_rules = fields["writer_rules"]
        self.assertIn("Never upgrade a", writer_rules)
        self.assertIn("knock to an elimination", writer_rules)

    def test_bgmi_knock_finish_distinction(self):
        fields = engine.get_factory_pack("bgmi")["fields"]
        self.assertIn("only a confirmed finish is an elimination",
                      fields["vision_coverage"])
        self.assertIn("never confuse", fields["game_context"].lower())
        self.assertIn("Never upgrade a", fields["writer_rules"])
        self.assertIn("knock to a finish", fields["writer_rules"])

    def test_bgmi_blue_zone_and_victory_wording(self):
        fields = engine.get_factory_pack("bgmi")["fields"]
        self.assertIn("blue zone for the shrinking area", fields["script_rules"])
        self.assertIn("Winner Winner Chicken Dinner only for a confirmed victory",
                      fields["script_rules"])
        self.assertIn("Winner Winner Chicken Dinner", fields["game_context"])
        self.assertIn("say it only for a confirmed victory", fields["game_context"])

    def test_cod_no_universal_respawn_rule(self):
        fields = engine.get_factory_pack("cod")["fields"]
        self.assertIn("never assume", fields["game_context"].lower())
        self.assertIn("Respawn rules", fields["game_context"])
        self.assertIn("differ by mode", fields["game_context"])

    def test_cod_mechanics_are_mode_gated(self):
        fields = engine.get_factory_pack("cod")["fields"]
        self.assertIn("in modes that use them", fields["game_context"])
        self.assertIn("only where the mode supports it", fields["game_context"])
        self.assertIn("only when the", fields["script_rules"])
        self.assertIn("mode and evidence support them", fields["script_rules"])
        self.assertIn("Never identify an operator by outfit", fields["vision_coverage"])


class ScriptValidatorIsolationTests(unittest.TestCase):
    def test_invented_finish_rejected_without_evidence(self):
        claim = sample_claim(["A player moves across an open field."])
        self.assertFalse(engine.script_text_valid(
            "That player secures the finish on the downed rival.", [claim]))

    def test_supported_finish_accepted_with_evidence(self):
        claim = sample_claim(["Kill feed shows a finish on the downed player."])
        self.assertTrue(engine.script_text_valid(
            "The feed confirms the finish on the downed player.", [claim]))

    def test_invented_blue_zone_rejected_without_evidence(self):
        claim = sample_claim(["A player moves across an open field."])
        self.assertFalse(engine.script_text_valid(
            "The blue zone pressure forces everyone to rotate.", [claim]))

    def test_supported_blue_zone_accepted_with_evidence(self):
        claim = sample_claim(["The blue zone shrinks toward the compound."])
        self.assertTrue(engine.script_text_valid(
            "The blue zone keeps shrinking toward the compound.", [claim]))

    def test_invented_victory_shout_rejected_without_evidence(self):
        claim = sample_claim(["A player moves across an open field."])
        self.assertFalse(engine.script_text_valid(
            "Booyah, what a spectacular final fight that was.", [claim]))
        self.assertFalse(engine.script_text_valid(
            "Winner Winner Chicken Dinner for the last squad standing.", [claim]))

    def test_supported_victory_shout_accepted_with_evidence(self):
        claim = sample_claim(["The winners take the match on the final screen."])
        self.assertTrue(engine.script_text_valid(
            "Booyah, the winners take the final fight in style.", [claim]))

    def test_evidence_rules_not_weakened(self):
        # The stem extensions only add sensitivity: unrelated invention
        # is still rejected and grounded wording still passes.
        claim = sample_claim(["A player moves across an open field."])
        self.assertFalse(engine.script_text_valid(
            "What a knock, he finishes the fight with heavy damage!", [claim]))
        grounded = sample_claim(["Kill feed shows a new entry."])
        self.assertTrue(engine.script_text_valid(
            "The kill feed shows a new entry.", [grounded]))


class RuntimeIntegrationTests(unittest.TestCase):
    GAMES = {
        "free-fire": "Blue Wall",
        "bgmi": "blue zone",
        "cod": "operator",
    }

    def test_settings_snapshot_selects_pack_for_every_builder(self):
        for game_id, marker in self.GAMES.items():
            settings = json.dumps({"game": {"id": game_id}})
            with pack_env(settings=settings):
                self.assertIn(marker, engine.build_vision_prompt(0), game_id)
                self.assertIn(marker, engine.build_adaptive_vision_prompt(0), game_id)
                self.assertIn(
                    marker, engine.build_adaptive_batch_prompt([0, 1], None), game_id)
                self.assertIn(
                    marker, engine.build_script_prompt([sample_claim()], []), game_id)
                self.assertIn(
                    marker, engine.build_writer_prompt([sample_claim()], []), game_id)

    def test_custom_overlay_is_scoped_to_its_pack(self):
        # A custom field on one pack never leaks into another pack.
        settings = json.dumps({
            "promptPack": {"packId": "bgmi",
                           "custom": {"script_closing": "BGMI custom closing."}},
        })
        with pack_env(settings=settings):
            bgmi = engine.resolve_pack()
            self.assertEqual(bgmi["fields"]["script_closing"], "BGMI custom closing.")
        cod = engine.resolve_pack("cod", {})
        self.assertEqual(
            cod["fields"]["script_closing"],
            engine.get_factory_pack("cod")["fields"]["script_closing"])
        with pack_env(settings=json.dumps({"game": {"id": "cod"}})):
            prompt = engine.build_script_prompt([sample_claim()], [])
        self.assertNotIn("BGMI custom closing.", prompt)


if __name__ == "__main__":
    unittest.main()
