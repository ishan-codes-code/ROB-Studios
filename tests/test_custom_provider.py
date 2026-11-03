"""Custom OpenAI-compatible provider tests: all offline with fakes.

Covers endpoint/model validation, the CustomAdapter request shapes and
error hygiene, live discovery success/unsupported/failure paths, the
registry contract, provider_setup routing, and the engine live-client
routing. No network calls; no secrets in assertions.
"""
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))

import provider_setup
from ai_commentator.errors import ObservationError, VisionAPIError
from ai_commentator.vision.providers import custom as custom_module
from ai_commentator.vision.providers.custom import (
    CustomAdapter,
    ModelDiscoveryError,
    validate_base_url,
    validate_model_id,
)
from ai_commentator.vision.providers.registry import (
    PROVIDER_CUSTOM,
    SUPPORTED_PROVIDERS,
    create_adapter,
    custom_base_url_from_env,
    get_provider_models,
    is_supported_model,
    resolve_live_adapter,
    resolve_provider_config,
    validate_provider_model,
)

BASE = "https://llm.example.com/v1"


class FakeCompletion:
    def __init__(self, content, finish_reason="stop"):
        message = type("Message", (), {"content": content})()
        self.choices = [type("Choice", (), {
            "message": message, "finish_reason": finish_reason})()]


class FakeModels:
    def __init__(self, owner):
        self._owner = owner

    def list(self):
        self._owner.model_calls.append("list")
        if isinstance(self._owner.models_result, Exception):
            raise self._owner.models_result
        return self._owner.models_result


class FakeRawResponse:
    def __init__(self, completion, status_code=200):
        self._completion = completion
        self.status_code = status_code

    def parse(self):
        return self._completion


class FakeWithRaw:
    def __init__(self, owner):
        self._owner = owner

    def create(self, **kwargs):
        self._owner.calls.append(kwargs)
        if isinstance(self._owner.completion_result, Exception):
            raise self._owner.completion_result
        return FakeRawResponse(
            FakeCompletion(self._owner.completion_result))


class FakeCompletions:
    def __init__(self, owner):
        self._owner = owner

    @property
    def with_raw_response(self):
        return FakeWithRaw(self._owner)

    def create(self, **kwargs):
        self._owner.calls.append(kwargs)
        if isinstance(self._owner.completion_result, Exception):
            raise self._owner.completion_result
        return FakeCompletion(self._owner.completion_result)


class FakeCustomClient:
    def __init__(self, content="Red", models_result=None):
        self.calls = []
        self.model_calls = []
        self.closed = False
        self.completion_result = content
        self.models_result = (
            models_result if models_result is not None
            else {"data": [{"id": "a-vision"}, {"id": "b-text"}]})
        self.chat = type("Chat", (), {
            "completions": FakeCompletions(self)})()
        self.models = FakeModels(self)

    def close(self):
        self.closed = True


class FakeAPIError(Exception):
    def __init__(self, status_code, body=None):
        super().__init__(f"Error code: {status_code}")
        self.status_code = status_code
        self.body = body or {"message": "not found here"}


class ValidationTests(unittest.TestCase):
    def test_base_url_accepts_https_and_strips_trailing_slash(self):
        self.assertEqual(validate_base_url("https://llm.example.com/v1/"),
                         "https://llm.example.com/v1")

    def test_base_url_rejects_non_https_and_embedded_parts(self):
        for bad in ("http://llm.example.com/v1",
                    "https://user:pw@llm.example.com/v1",
                    "https://llm.example.com/v1?x=1",
                    "https://llm.example.com/v1#frag",
                    "not-a-url", "", "   "):
            with self.assertRaises(ValueError, msg=bad):
                validate_base_url(bad)

    def test_base_url_rejects_local_and_private_targets(self):
        for bad in ("https://localhost/v1",
                    "https://api.localhost/v1",
                    "https://127.0.0.1/v1",
                    "https://10.1.2.3/v1",
                    "https://172.16.0.9/v1",
                    "https://192.168.1.1/v1",
                    "https://169.254.10.20/v1",
                    "https://[::1]/v1"):
            with self.assertRaises(ValueError, msg=bad):
                validate_base_url(bad)

    def test_base_url_rejects_overlong(self):
        with self.assertRaises(ValueError):
            validate_base_url("https://example.com/" + "a" * 2048)

    def test_model_id_rules(self):
        self.assertEqual(validate_model_id("  qwen-vl  "), "qwen-vl")
        for bad in ("", "   ", "a" * 201, "bad\nid"):
            with self.assertRaises(ValueError, msg=repr(bad)):
                validate_model_id(bad)


class AdapterTests(unittest.TestCase):
    def test_requires_valid_base_url(self):
        with self.assertRaises(ValueError):
            CustomAdapter(model="m", api_key="k", base_url="http://x/v1")
        with self.assertRaises(ValueError):
            CustomAdapter(model="m", api_key="k", base_url="")

    def test_verify_connection_sends_minimal_text_probe(self):
        fake = FakeCustomClient(content="OK")
        adapter = CustomAdapter(model="m", api_key="k", base_url=BASE,
                                client=fake)
        adapter.verify_connection()
        call = fake.calls[0]
        self.assertEqual(call["model"], "m")
        self.assertEqual(call["max_tokens"], 16)
        self.assertNotIn("image_url", str(call["messages"]))

    def test_verify_connection_rejects_empty_reply(self):
        fake = FakeCustomClient(content="   ")
        adapter = CustomAdapter(model="m", api_key="k", base_url=BASE,
                                client=fake)
        with self.assertRaises(ObservationError):
            adapter.verify_connection()

    def test_verify_image_sends_image_and_validates_text(self):
        fake = FakeCustomClient(content="Red")
        adapter = CustomAdapter(model="m", api_key="k", base_url=BASE,
                                client=fake)
        adapter.verify_image()
        call = fake.calls[0]
        self.assertIn("image_url", str(call["messages"]))
        self.assertNotIn("reasoning_effort", str(call))

    def test_verify_image_rejects_empty_and_exhausted(self):
        fake = FakeCustomClient(content="x")
        adapter = CustomAdapter(model="m", api_key="k", base_url=BASE,
                                client=fake)
        fake.completion_result = " "
        with self.assertRaises((ObservationError, VisionAPIError)):
            adapter.verify_image()
        fake.completion_result = "Red"
        fake2 = FakeCustomClient(content="Red")
        adapter2 = CustomAdapter(model="m", api_key="k", base_url=BASE,
                                 client=fake2)

        def exhausted(self, **kwargs):
            self._owner.calls.append(kwargs)
            return FakeCompletion("partial", finish_reason="length")

        with mock.patch.object(FakeCompletions, "create", exhausted):
            with self.assertRaises(VisionAPIError) as ctx:
                adapter2.verify_image()
        self.assertEqual(ctx.exception.code, "output_exhausted")

    def test_request_text_shapes_and_empty_rejection(self):
        fake = FakeCustomClient(content="hello")
        adapter = CustomAdapter(model="m", api_key="k", base_url=BASE,
                                client=fake)
        self.assertEqual(adapter.request_text("hi"), "hello")
        fake.completion_result = ""
        with self.assertRaises(ObservationError):
            adapter.request_text("hi")

    def test_errors_redact_secret(self):
        fake = FakeCustomClient(content="x")
        fake.completion_result = RuntimeError("boom secret-key-1")
        adapter = CustomAdapter(model="m", api_key="secret-key-1",
                                base_url=BASE, client=fake)
        with self.assertRaises(VisionAPIError) as ctx:
            adapter.verify_connection()
        self.assertNotIn("secret-key-1", str(ctx.exception))


class DiscoveryTests(unittest.TestCase):
    def test_list_models_returns_unique_ids_bounded(self):
        fake = FakeCustomClient(models_result={
            "data": [{"id": "b"}, {"id": "a"}, {"id": "b"}, {"id": " "}]})
        adapter = CustomAdapter(model="m", api_key="k", base_url=BASE,
                                client=fake)
        self.assertEqual(adapter.list_models(), ["b", "a"])

    def test_list_models_accepts_sdk_object_shape(self):
        item = type("Item", (), {"id": "sdk-model"})()
        result = type("Result", (), {"data": [item]})()
        fake = FakeCustomClient(models_result=result)
        adapter = CustomAdapter(model="m", api_key="k", base_url=BASE,
                                client=fake)
        self.assertEqual(adapter.list_models(), ["sdk-model"])

    def test_list_models_missing_listing_reports_unsupported(self):
        for status in (404, 405, 501):
            fake = FakeCustomClient()
            fake.models_result = FakeAPIError(status)
            adapter = CustomAdapter(model="m", api_key="k", base_url=BASE,
                                    client=fake)
            with mock.patch.object(custom_module, "APIError", FakeAPIError):
                with self.assertRaises(ModelDiscoveryError) as ctx:
                    adapter.list_models()
            self.assertEqual(ctx.exception.code, "discovery_unsupported")

    def test_list_models_auth_failure_keeps_real_code(self):
        fake = FakeCustomClient()
        fake.models_result = FakeAPIError(401)
        adapter = CustomAdapter(model="m", api_key="k", base_url=BASE,
                                client=fake)
        with mock.patch.object(custom_module, "APIError", FakeAPIError):
            with self.assertRaises(VisionAPIError) as ctx:
                adapter.list_models()
        self.assertEqual(ctx.exception.code, "auth")

    def test_list_models_malformed_body_reports_unsupported(self):
        fake = FakeCustomClient(models_result={"unexpected": True})
        adapter = CustomAdapter(model="m", api_key="k", base_url=BASE,
                                client=fake)
        with self.assertRaises(ModelDiscoveryError) as ctx:
            adapter.list_models()
        self.assertEqual(ctx.exception.code, "discovery_unsupported")


class RegistryTests(unittest.TestCase):
    def test_custom_supported_with_empty_catalogue(self):
        self.assertIn(PROVIDER_CUSTOM, SUPPORTED_PROVIDERS)
        self.assertEqual(get_provider_models("custom"), ())
        self.assertFalse(is_supported_model("custom", "anything"))

    def test_validate_accepts_explicit_ids_only(self):
        provider, model = validate_provider_model("custom", "  qwen-vl ")
        self.assertEqual((provider, model), ("custom", "qwen-vl"))
        with self.assertRaises(ValueError):
            validate_provider_model("custom", "")
        with self.assertRaises(ValueError):
            validate_provider_model("custom", "x" * 201)

    def test_factory_builds_custom_adapter(self):
        adapter = create_adapter("custom", "m", "k", base_url=BASE)
        self.assertIsInstance(adapter, CustomAdapter)
        self.assertEqual(adapter.base_url, BASE)
        adapter.close()
        with self.assertRaises(ValueError):
            create_adapter("custom", "m", "k")

    def test_resolve_custom_carries_base_url(self):
        env = {"AI_COMMENTATOR_PROVIDER": "custom",
               "AI_COMMENTATOR_MODEL": "qwen-vl",
               "AI_COMMENTATOR_API_KEY": "k",
               "AI_COMMENTATOR_BASE_URL": BASE}
        with mock.patch.dict("os.environ", env, clear=True):
            resolved = resolve_provider_config()
        self.assertEqual(resolved["provider"], "custom")
        self.assertEqual(resolved["base_url"], BASE)

    def test_resolve_custom_requires_endpoint(self):
        env = {"AI_COMMENTATOR_PROVIDER": "custom",
               "AI_COMMENTATOR_MODEL": "qwen-vl",
               "AI_COMMENTATOR_API_KEY": "k"}
        with mock.patch.dict("os.environ", env, clear=True):
            with self.assertRaises(ValueError):
                resolve_provider_config()

    def test_resolve_custom_rejects_private_endpoint(self):
        env = {"AI_COMMENTATOR_PROVIDER": "custom",
               "AI_COMMENTATOR_MODEL": "qwen-vl",
               "AI_COMMENTATOR_API_KEY": "k",
               "AI_COMMENTATOR_BASE_URL": "https://10.0.0.5/v1"}
        with mock.patch.dict("os.environ", env, clear=True):
            with self.assertRaises(ValueError):
                resolve_provider_config()

    def test_curated_resolutions_keep_exact_shape(self):
        env = {"AI_COMMENTATOR_PROVIDER": "meta",
               "AI_COMMENTATOR_MODEL": "muse-spark-1.3",
               "AI_COMMENTATOR_API_KEY": "k"}
        with mock.patch.dict("os.environ", env, clear=True):
            resolved = resolve_provider_config()
        self.assertEqual(resolved, {"provider": "meta",
                                    "model": "muse-spark-1.3",
                                    "api_key": "k"})

    def test_custom_base_url_from_env(self):
        with mock.patch.dict("os.environ",
                              {"AI_COMMENTATOR_BASE_URL": BASE + "/"},
                              clear=True):
            self.assertEqual(custom_base_url_from_env(), BASE)
        with mock.patch.dict("os.environ", {}, clear=True):
            with self.assertRaises(ValueError):
                custom_base_url_from_env()

    def test_resolve_live_adapter_builds_custom(self):
        env = {"AI_COMMENTATOR_PROVIDER": "custom",
               "AI_COMMENTATOR_MODEL": "qwen-vl",
               "AI_COMMENTATOR_API_KEY": "k",
               "AI_COMMENTATOR_BASE_URL": BASE}
        with mock.patch.dict("os.environ", env, clear=True):
            with mock.patch(
                    "ai_commentator.vision.providers.custom.OpenAI") as ctor:
                adapter = resolve_live_adapter(timeout=5.0)
        self.assertIsInstance(adapter, CustomAdapter)
        _, kwargs = ctor.call_args
        self.assertEqual(kwargs["base_url"], BASE)


class FakeDiscoveryAdapter:
    def __init__(self, names=None, error=None):
        self.names = names
        self.error = error
        self.closed = False

    def list_models(self):
        if self.error is not None:
            raise self.error
        return list(self.names or [])

    def close(self):
        self.closed = True


class SetupProbeTests(unittest.TestCase):
    def test_custom_models_discovers_with_key(self):
        fake = FakeDiscoveryAdapter(names=["zebra"])
        with mock.patch.dict("os.environ",
                              {"AI_COMMENTATOR_PROVIDER_API_KEY": "k"},
                              clear=True):
            with mock.patch(
                    "ai_commentator.vision.providers.custom.CustomAdapter",
                    lambda **kwargs: fake):
                result = provider_setup.run("models", BASE, "", "custom")
        self.assertEqual(result["ok"], True)
        self.assertEqual(result["models"],
                         [{"id": "zebra", "vision": "unverified"}])
        self.assertTrue(fake.closed)

    def test_custom_models_requires_key(self):
        with mock.patch.dict("os.environ", {}, clear=True):
            with self.assertRaises(ValueError):
                provider_setup.run("models", BASE, "", "custom")

    def test_custom_models_unsupported_surfaces_structured_code(self):
        fake = FakeDiscoveryAdapter(error=ModelDiscoveryError("no listing"))
        with mock.patch.dict("os.environ",
                              {"AI_COMMENTATOR_PROVIDER_API_KEY": "k"},
                              clear=True):
            with mock.patch(
                    "ai_commentator.vision.providers.custom.CustomAdapter",
                    lambda **kwargs: fake):
                with self.assertRaises(ModelDiscoveryError) as ctx:
                    provider_setup.run("models", BASE, "", "custom")
        failure = provider_setup.failure_result(
            "models", "custom", ctx.exception)
        self.assertEqual(failure["code"], "discovery_unsupported")
        self.assertIn("manually", failure["error"])

    def test_custom_connection_routes_adapter(self):
        seen = {}

        class Probe:
            def __init__(self, **kwargs):
                seen.update(kwargs)

            def verify_connection(self):
                seen["op"] = "connection"

            def verify_image(self):
                seen["op"] = "verify"

            def close(self):
                seen["closed"] = True

        with mock.patch.dict("os.environ",
                              {"AI_COMMENTATOR_PROVIDER_API_KEY": "k"},
                              clear=True):
            with mock.patch(
                    "ai_commentator.vision.providers.custom.CustomAdapter",
                    Probe):
                result = provider_setup.run(
                    "connection", BASE, "qwen-vl", "custom")
        self.assertEqual(result["connected"], True)
        self.assertEqual(seen["base_url"], BASE)
        self.assertEqual(seen["model"], "qwen-vl")
        self.assertTrue(seen["closed"])

    def test_curated_models_stay_keyless(self):
        with mock.patch.dict("os.environ", {}, clear=True):
            result = provider_setup.run("models", "", "", "meta")
        self.assertEqual(result["ok"], True)
        self.assertEqual(len(result["models"]), 2)


class EngineRoutingTests(unittest.TestCase):
    def test_batch_factory_routes_custom(self):
        from ai_commentator.vision import batch as batch_module

        factory = batch_module._live_client_factory(
            "custom", "qwen-vl", "k")
        with mock.patch.dict("os.environ",
                              {"AI_COMMENTATOR_BASE_URL": BASE},
                              clear=True):
            with mock.patch(
                    "ai_commentator.vision.providers.custom.OpenAI"):
                with factory() as client:
                    self.assertIsInstance(client, CustomAdapter)
                    self.assertEqual(client.base_url, BASE)

    def test_writer_factory_routes_custom(self):
        from ai_commentator.commentary import writer as writer_module

        with mock.patch.dict("os.environ",
                              {"AI_COMMENTATOR_BASE_URL": BASE},
                              clear=True):
            with mock.patch(
                    "ai_commentator.vision.providers.custom.OpenAI"):
                client = writer_module._live_text_client(
                    "custom", "qwen-vl", "k")
        self.assertIsInstance(client, CustomAdapter)
        client.close()

    def test_script_factory_routes_custom(self):
        from ai_commentator.script import runner as script_runner

        with mock.patch.dict("os.environ",
                              {"AI_COMMENTATOR_BASE_URL": BASE},
                              clear=True):
            with mock.patch(
                    "ai_commentator.vision.providers.custom.OpenAI"):
                client = script_runner._live_text_client(
                    "custom", "qwen-vl", "k")
        self.assertIsInstance(client, CustomAdapter)
        client.close()


if __name__ == "__main__":
    unittest.main()
