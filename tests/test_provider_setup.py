"""Provider setup boundary tests use fake adapters; no network calls."""
import sys
import unittest
import types
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
            {"id": "meta-models/muse-spark-open", "vision": "unverified"},
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
                "meta-models/muse-spark-open", "baseten")
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
                    "meta-models/muse-spark-open", "baseten")
        self.assertEqual(FakeAdapter.instances, [])


class StructuredFailureTests(unittest.TestCase):
    def test_adapter_error_maps_to_user_message(self):
        from ai_commentator.errors import VisionAPIError

        exc = VisionAPIError("Baseten API HTTP 401: bad-key", code="auth",
                             status=401, provider="baseten")
        result = provider_setup.failure_result("verify-vision", "baseten", exc)
        self.assertEqual(result["ok"], False)
        self.assertEqual(result["code"], "auth")
        self.assertEqual(result["status"], 401)
        self.assertEqual(result["provider"], "baseten")
        self.assertEqual(result["operation"], "verify-vision")
        self.assertEqual(result["error"], "Authentication failed. Check the API key.")
        self.assertNotIn("bad-key", result["error"])

    def test_empty_response_maps_to_bad_response(self):
        from ai_commentator.errors import ObservationError

        result = provider_setup.failure_result(
            "verify-vision", "meta", ObservationError("Meta returned no text content."))
        self.assertEqual(result["code"], "bad_response")
        self.assertEqual(
            result["error"], "The provider returned an empty or invalid response.")

    def test_config_errors_keep_specific_safe_message(self):
        result = provider_setup.failure_result(
            "connection", "baseten", ValueError("Provider credential is missing."))
        self.assertEqual(result["code"], "config")
        self.assertEqual(result["error"], "Provider credential is missing.")

    def test_unknown_errors_fall_back_generic(self):
        result = provider_setup.failure_result(
            "connection", "meta", RuntimeError("weird"))
        self.assertEqual(result["code"], "unknown")
        self.assertIn("Check the key, model", result["error"])
        self.assertEqual(result["status"], None)

    def test_output_exhausted_has_actionable_message(self):
        from ai_commentator.errors import VisionAPIError

        exc = VisionAPIError("Baseten used up its output budget",
                             code="output_exhausted", provider="baseten")
        result = provider_setup.failure_result("verify-vision", "baseten", exc)
        self.assertEqual(result["code"], "output_exhausted")
        self.assertIn("output budget", result["error"])

    def test_detail_is_truncated_and_present(self):
        from ai_commentator.errors import VisionAPIError

        exc = VisionAPIError("x" * 2000, code="provider_error",
                             status=500, provider="baseten")
        result = provider_setup.failure_result("connection", "baseten", exc)
        self.assertLessEqual(len(result["detail"]), 520)
        self.assertTrue(result["detail"].endswith("(truncated)"))

    def test_main_prints_structured_failure_json(self):
        import io
        import json as json_module

        argv = ["provider_setup.py", "verify-vision", "--provider", "meta",
                "--model", "muse-spark-1.3"]
        env = {"AI_COMMENTATOR_PROVIDER_API_KEY": "sk-test-secret-xyz"}
        with (mock.patch.dict("os.environ", env, clear=True),
              mock.patch("sys.argv", argv),
              mock.patch("ai_commentator.vision.providers.meta.MetaAdapter") as adapter,
              mock.patch("sys.stdout", new_callable=io.StringIO) as out):
            from ai_commentator.errors import VisionAPIError
            adapter.return_value.verify_image.side_effect = VisionAPIError(
                "Meta API HTTP 401: nope", code="auth", status=401,
                provider="meta")
            code = provider_setup.main()
        self.assertEqual(code, 1)
        payload = json_module.loads(out.getvalue())
        self.assertEqual(payload["code"], "auth", payload)
        self.assertEqual(payload["status"], 401)
        self.assertEqual(payload["error"], "Authentication failed. Check the API key.")
        self.assertEqual(payload["operation"], "verify-vision")
        self.assertNotIn("sk-test-secret-xyz", json_module.dumps(payload))


class GeminiTtsSetupTests(unittest.TestCase):
    def sdk_modules(self, get_side_effect=None):
        calls = []

        class Models:
            def get(self, *, model):
                calls.append(model)
                if get_side_effect:
                    raise get_side_effect
                return object()

        class Client:
            def __init__(self, *, api_key, http_options):
                calls.append((api_key, http_options.timeout))
                self.models = Models()

        genai = types.SimpleNamespace(Client=Client)
        types_module = types.SimpleNamespace(
            HttpOptions=lambda **kwargs: types.SimpleNamespace(**kwargs))
        google = types.ModuleType("google")
        google.genai = genai
        genai.types = types_module
        return calls, {"google": google, "google.genai": genai,
                       "google.genai.types": types_module}

    def test_success_checks_tts_metadata_without_generation(self):
        calls, modules = self.sdk_modules()
        with (mock.patch.dict("os.environ", {"AI_COMMENTATOR_PROVIDER_API_KEY": "key-abc"}),
              mock.patch.dict(sys.modules, modules)):
            result = provider_setup.run("verify-tts-auth", "", "", "google-gemini-tts")
        self.assertTrue(result["ok"])
        self.assertEqual(result["capability"], "authentication-and-model-metadata")
        self.assertEqual(calls, [("key-abc", 10000), "gemini-3.8-flash-tts"])

    def test_api_failures_map_to_safe_categories(self):
        from tts_provider_setup import GeminiSetupError

        cases = [
            ("auth", RuntimeError("unused")),
            ("permission", RuntimeError("unused")),
            ("quota", RuntimeError("unused")),
            ("network", ConnectionError("secret key in raw error")),
            ("timeout", TimeoutError("secret key in raw error")),
        ]
        statuses = {"auth": 401, "permission": 403, "quota": 429}
        for expected, original in cases:
            if expected in statuses:
                original.code = statuses[expected]
            _, modules = self.sdk_modules(original)
            with (self.subTest(category=expected),
                  mock.patch.dict("os.environ", {"AI_COMMENTATOR_PROVIDER_API_KEY": "secret key"}),
                  mock.patch.dict(sys.modules, modules)):
                with self.assertRaises(GeminiSetupError) as raised:
                    provider_setup.run("verify-tts-auth", "", "", "google-gemini-tts")
                self.assertEqual(raised.exception.code, expected)
                payload = provider_setup.failure_result(
                    "verify-tts-auth", "google-gemini-tts", raised.exception)
                self.assertNotIn("secret key", str(payload))

    def test_google_genai_api_errors_use_sdk_status_codes_and_redact_details(self):
        import json
        from tts_provider_setup import GeminiSetupError

        # google.genai.errors.APIError exposes `code` and `status`; these
        # shaped exceptions match the SDK's public exception contract.
        class APIError(Exception):
            def __init__(self, code, response_json):
                self.code = code
                self.status = response_json["error"]["status"]
                self.details = response_json
                super().__init__(f"{code} {self.status}: {response_json}")

        cases = [
            (400, "INVALID_ARGUMENT", "bad_request"),
            (401, "UNAUTHENTICATED", "auth"),
            (403, "PERMISSION_DENIED", "permission"),
            (404, "NOT_FOUND", "permission"),
            (429, "RESOURCE_EXHAUSTED", "quota"),
            (503, "UNAVAILABLE", "network"),
        ]
        for status, api_status, expected in cases:
            error = APIError(status, {"error": {
                "status": api_status, "message": "API key=secret-sdk-key"}})
            _, modules = self.sdk_modules(error)
            with (self.subTest(status=status),
                  mock.patch.dict("os.environ", {"AI_COMMENTATOR_PROVIDER_API_KEY": "secret-sdk-key"}),
                  mock.patch.dict(sys.modules, modules)):
                with self.assertRaises(GeminiSetupError) as raised:
                    provider_setup.run("verify-tts-auth", "", "", "google-gemini-tts")
                self.assertEqual(raised.exception.code, expected)
                payload = provider_setup.failure_result(
                    "verify-tts-auth", "google-gemini-tts", raised.exception)
                self.assertNotIn("secret-sdk-key", json.dumps(payload))

    def test_google_sdk_transport_timeout_maps_without_raw_exception(self):
        from tts_provider_setup import GeminiSetupError

        class ConnectTimeout(Exception):
            pass

        _, modules = self.sdk_modules(ConnectTimeout("request timed out with secret"))
        with (mock.patch.dict("os.environ", {"AI_COMMENTATOR_PROVIDER_API_KEY": "secret"}),
              mock.patch.dict(sys.modules, modules)):
            with self.assertRaises(GeminiSetupError) as raised:
                provider_setup.run("verify-tts-auth", "", "", "google-gemini-tts")
        self.assertEqual(raised.exception.code, "timeout")
        self.assertNotIn("secret", str(raised.exception))

    def test_invalid_key_and_permission_errors_have_actionable_machine_output(self):
        import io
        import json as json_module

        _, modules = self.sdk_modules(RuntimeError("raw API key=secret-key"))
        modules["google.genai"].Client = lambda **kwargs: (_ for _ in ()).throw(
            type("ApiError", (Exception,), {"code": 401})("raw API key=secret-key"))
        argv = ["provider_setup.py", "verify-tts-auth", "--provider", "google-gemini-tts"]
        with (mock.patch.dict("os.environ", {"AI_COMMENTATOR_PROVIDER_API_KEY": "secret-key"}),
              mock.patch.dict(sys.modules, modules), mock.patch("sys.argv", argv),
              mock.patch("sys.stdout", new_callable=io.StringIO) as out):
            code = provider_setup.main()
        payload = json_module.loads(out.getvalue())
        self.assertEqual(code, 1)
        self.assertEqual(payload["code"], "auth", repr(payload))
        self.assertNotIn("secret-key", out.getvalue())


if __name__ == "__main__":
    unittest.main()
