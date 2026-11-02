"""Provider setup boundary tests use fake adapters; no network calls."""
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))

import provider_setup


class FakeAdapter:
    instances = []

    def __init__(self, *args, **kwargs):
        self.calls = []
        self.closed = False
        FakeAdapter.instances.append(self)

    def verify_connection(self):
        self.calls.append("connection")

    def verify_image(self):
        self.calls.append("verify-image")

    def close(self):
        self.closed = True


class ProviderSetupTests(unittest.TestCase):
    def setUp(self):
        FakeAdapter.instances = []

    def test_models_returns_curated_catalogue_without_key(self):
        with mock.patch.dict("os.environ", {}, clear=True):
            result = provider_setup.run("models", "", "", "meta")
        self.assertEqual(result, {
            "ok": True,
            "provider": "meta",
            "models": [
                {"id": "muse-spark-1.3", "vision": "unverified"},
                {"id": "muse-wonder-1.0", "vision": "unverified"},
            ],
        })
        with mock.patch.dict("os.environ", {}, clear=True):
            result = provider_setup.run("models", "", "")
        self.assertEqual(result["provider"], "baseten")
        self.assertEqual(result["models"], [
            {"id": "meta-models/muse-spark-open-1026", "vision": "unverified"},
        ])

    def test_models_rejects_unknown_provider(self):
        with self.assertRaises(ValueError):
            provider_setup.run("models", "", "", "openai")

    def test_connection_uses_matching_adapter(self):
        with (mock.patch.dict("os.environ",
                              {"AI_COMMENTATOR_PROVIDER_API_KEY": "k"}),
              mock.patch("ai_commentator.vision.providers.meta.MetaAdapter",
                         FakeAdapter),
              mock.patch("ai_commentator.vision.providers.baseten.BasetenAdapter",
                         FakeAdapter)):
            result = provider_setup.run(
                "connection", "", "muse-spark-1.3", "meta")
        self.assertEqual(result,
                         {"ok": True, "provider": "meta", "connected": True})
        self.assertEqual(FakeAdapter.instances[0].calls, ["connection"])
        self.assertTrue(FakeAdapter.instances[0].closed)

    def test_verify_vision_uses_image_check(self):
        with (mock.patch.dict("os.environ",
                              {"AI_COMMENTATOR_PROVIDER_API_KEY": "k"}),
              mock.patch("ai_commentator.vision.providers.baseten.BasetenAdapter",
                         FakeAdapter)):
            result = provider_setup.run(
                "verify-vision", "",
                "meta-models/muse-spark-open-1026", "baseten")
        self.assertEqual(result,
                         {"ok": True, "provider": "baseten",
                          "visionVerified": True})
        self.assertEqual(FakeAdapter.instances[0].calls, ["verify-image"])

    def test_cross_provider_model_rejected(self):
        with mock.patch.dict("os.environ",
                             {"AI_COMMENTATOR_PROVIDER_API_KEY": "k"}):
            with self.assertRaises(ValueError):
                provider_setup.run("connection", "", "muse-spark-1.3", "baseten")

    def test_missing_credential_fails_without_adapter(self):
        with (mock.patch.dict("os.environ", {}, clear=True),
              mock.patch("ai_commentator.vision.providers.baseten.BasetenAdapter",
                         FakeAdapter)):
            with self.assertRaisesRegex(ValueError, "credential is missing"):
                provider_setup.run(
                    "connection", "",
                    "meta-models/muse-spark-open-1026", "baseten")
        self.assertEqual(FakeAdapter.instances, [])


if __name__ == "__main__":
    unittest.main()
