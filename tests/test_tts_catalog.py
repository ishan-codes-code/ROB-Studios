"""Offline tests for the TTS catalogue probe (python/tts_catalog.py).

No key, no network: the catalogue is built purely from the pinned
``ai_commentator.tts.config`` source of truth.
"""

import io
import json
import subprocess
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))

import tts_catalog
from ai_commentator.tts.config import (
    DEFAULT_TTS_MODEL,
    DEFAULT_TTS_VOICE,
    DEFAULT_TTS_VOICE_DIRECTION,
    PREBUILT_VOICES,
    TTS_MODELS,
)

CATALOG_PATH = Path(tts_catalog.__file__)


class TtsCatalogTests(unittest.TestCase):
    def test_build_catalog_mirrors_pinned_config(self):
        catalog = tts_catalog.build_tts_catalog()
        self.assertTrue(catalog["ok"])
        self.assertEqual(
            [model["id"] for model in catalog["models"]], list(TTS_MODELS)
        )
        for model in catalog["models"]:
            self.assertTrue(model["description"].strip())
        self.assertEqual(len(catalog["voices"]), len(PREBUILT_VOICES))
        self.assertEqual(
            [(voice["id"], voice["character"]) for voice in catalog["voices"]],
            list(PREBUILT_VOICES),
        )
        self.assertEqual(
            catalog["defaults"],
            {
                "model": DEFAULT_TTS_MODEL,
                "voice": DEFAULT_TTS_VOICE,
                "voiceDirection": DEFAULT_TTS_VOICE_DIRECTION,
            },
        )
        self.assertEqual(
            catalog["limits"],
            {"voiceMaxLength": 64, "voiceDirectionMaxLength": 500},
        )

    def test_prebuilt_catalogue_has_thirty_voices(self):
        catalog = tts_catalog.build_tts_catalog()
        self.assertEqual(len(catalog["voices"]), 30)
        self.assertIn("Kore", [voice["id"] for voice in catalog["voices"]])

    def test_main_prints_single_json_line(self):
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            code = tts_catalog.main()
        self.assertEqual(code, 0)
        lines = buffer.getvalue().splitlines()
        self.assertEqual(len(lines), 1)
        self.assertTrue(json.loads(lines[0])["ok"])

    def test_subprocess_runs_offline_without_key(self):
        import os

        env = dict(os.environ)
        env.pop("AI_COMMENTATOR_PROVIDER_API_KEY", None)
        env.pop("GEMINI_API_KEY", None)
        env.pop("GOOGLE_API_KEY", None)
        proc = subprocess.run(
            [sys.executable, str(CATALOG_PATH)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=60,
            text=True,
            env=env,
        )
        self.assertEqual(proc.returncode, 0, msg=proc.stderr)
        self.assertTrue(json.loads(proc.stdout.strip())["ok"])


if __name__ == "__main__":
    unittest.main()
