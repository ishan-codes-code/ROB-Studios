"""Offline provider-adapter tests: Meta + Baseten with mocked transports.

No network calls: Baseten uses an injected fake OpenAI-shaped client and
Meta stubs ``urllib.request.urlopen``. Covers request shape, response
extraction, error mapping, secret redaction, catalogue validation, and
the explicit-vs-legacy environment contract.
"""
import io
import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))

from ai_commentator.errors import ObservationError, VisionAPIError
from ai_commentator.vision.providers import (
    BasetenAdapter,
    MetaAdapter,
    create_adapter,
    get_provider_models,
    is_supported_model,
    resolve_provider_config,
)
from ai_commentator.vision.providers import meta as meta_module


TINY_OBSERVATION = json.dumps({
    "schema_version": "observation-v1",
    "timestamp": 3,
    "observations": [{
        "category": "environment",
        "description": "A grassy field is visible.",
        "confidence": "high",
        "evidence": "Green flat ground fills the frame.",
    }],
    "uncertainties": [],
})


class FakeRawResponse:
    def __init__(self, completion, status_code=200):
        self._completion = completion
        self.status_code = status_code

    def parse(self):
        return self._completion


class FakeMessage:
    def __init__(self, content):
        self.content = content


class FakeChoice:
    def __init__(self, content, finish_reason="stop"):
        self.message = FakeMessage(content)
        self.finish_reason = finish_reason


class FakeCompletion:
    def __init__(self, content):
        self.choices = [FakeChoice(content)]


class FakeWithRaw:
    def __init__(self, owner, content):
        self._owner = owner
        self._content = content

    def create(self, **kwargs):
        self._owner.calls.append(kwargs)
        return FakeRawResponse(FakeCompletion(self._content))


class FakeCompletions:
    def __init__(self, owner, content):
        self._owner = owner
        self._content = content

    @property
    def with_raw_response(self):
        return FakeWithRaw(self._owner, self._content)

    def create(self, **kwargs):
        self._owner.calls.append(kwargs)
        return FakeCompletion(self._content)


class FakeOpenAIClient:
    def __init__(self, content=TINY_OBSERVATION):
        self.calls = []
        self.closed = False
        self.chat = type("Chat", (), {"completions": FakeCompletions(self, content)})()
        self.models = type("Models", (), {"list": lambda _self=None: []})()

    def close(self):
        self.closed = True


def make_response_payload(text):
    return {
        "id": "resp_123",
        "output": [{
            "type": "message",
            "content": [{"type": "output_text", "text": text}],
        }],
    }


class FakeHTTPResponse:
    def __init__(self, payload, status=200):
        self._body = json.dumps(payload).encode("utf-8")
        self.status = status

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class BasetenAdapterTests(unittest.TestCase):
    def test_text_image_payload_shape(self):
        fake = FakeOpenAIClient()
        adapter = BasetenAdapter(
            model="meta-models/muse-spark-open",
            api_key="k", client=fake)
        text = adapter.request_observation_text(3, "data:image/jpeg;base64,AAA")
        self.assertEqual(text, TINY_OBSERVATION)
        call = fake.calls[0]
        self.assertEqual(call["model"], "meta-models/muse-spark-open")
        content = call["messages"][0]["content"]
        self.assertEqual(content[0]["type"], "text")
        self.assertEqual(content[1]["type"], "image_url")
        self.assertEqual(content[1]["image_url"]["url"],
                         "data:image/jpeg;base64,AAA")

    def test_rejects_other_models(self):
        with self.assertRaises(ValueError):
            BasetenAdapter(model="gpt-4", api_key="k",
                           client=FakeOpenAIClient())

    def test_empty_response_raises_observation_error(self):
        fake = FakeOpenAIClient(content="   ")
        adapter = BasetenAdapter(
            model="meta-models/muse-spark-open",
            api_key="k", client=fake)
        with self.assertRaises(ObservationError):
            adapter.request_observation_text(3, "data:image/jpeg;base64,AAA")

    def test_error_redacts_secret(self):
        from openai import APIError

        class FailingRaw:
            def __init__(self, owner):
                self._owner = owner

            def create(self, **kwargs):
                request = mock.Mock()
                request.method = "POST"
                raise APIError(message="boom secret-key-123",
                               request=request, body=None)

        class FailingCompletions(FakeCompletions):
            @property
            def with_raw_response(self):
                return FailingRaw(self._owner)

        class FailingClient(FakeOpenAIClient):
            def __init__(self):
                self.calls = []
                self.closed = False
                self.chat = type("C", (), {"completions": FailingCompletions(self, "")})()

        adapter = BasetenAdapter(
            model="meta-models/muse-spark-open",
            api_key="secret-key-123", client=FailingClient())
        with self.assertRaises(VisionAPIError) as ctx:
            adapter.request_observation_text(3, "data:image/jpeg;base64,AAA")
        self.assertNotIn("secret-key-123", str(ctx.exception))
        self.assertIn("[REDACTED]", str(ctx.exception))

    def test_text_only_request(self):
        fake = FakeOpenAIClient(content='{"lines": []}')
        adapter = BasetenAdapter(
            model="meta-models/muse-spark-open",
            api_key="k", client=fake)
        self.assertEqual(adapter.request_text("hello"), '{"lines": []}')
        self.assertEqual(fake.calls[0]["messages"],
                         [{"role": "user", "content": "hello"}])

    def test_injected_client_never_closed(self):
        fake = FakeOpenAIClient()
        adapter = BasetenAdapter(
            model="meta-models/muse-spark-open",
            api_key="k", client=fake)
        adapter.close()
        self.assertFalse(fake.closed)

    def test_verify_image_budget_and_reasoning(self):
        fake = FakeOpenAIClient(content="Red")
        adapter = BasetenAdapter(
            model="meta-models/muse-spark-open",
            api_key="k", client=fake)
        adapter.verify_image()
        call = fake.calls[0]
        self.assertEqual(call["model"], "meta-models/muse-spark-open")
        self.assertEqual(call["max_tokens"], 512)
        self.assertEqual(call["extra_body"], {"reasoning_effort": "low"})
        content = call["messages"][0]["content"]
        self.assertEqual(content[1]["type"], "image_url")

    def test_verify_image_length_finish_is_exhaustion(self):
        class LengthClient(FakeOpenAIClient):
            def __init__(self):
                self.calls = []
                self.closed = False
                completion = type("C", (), {})()
                completion.choices = [FakeChoice("", finish_reason="length")]
                self.chat = type("Chat", (), {
                    "completions": type("Comp", (), {
                        "create": lambda _s, **kw: self.calls.append(kw) or completion,
                    })(),
                })()
                self.models = type("Models", (), {"list": lambda _s=None: []})()

        adapter = BasetenAdapter(
            model="meta-models/muse-spark-open",
            api_key="k", client=LengthClient())
        with self.assertRaises(VisionAPIError) as ctx:
            adapter.verify_image()
        self.assertEqual(ctx.exception.code, "output_exhausted")

    def test_verify_image_no_choices_is_bad_response(self):
        from ai_commentator.errors import ObservationError

        class EmptyClient(FakeOpenAIClient):
            def __init__(self):
                self.calls = []
                self.closed = False
                completion = type("C", (), {})()
                completion.choices = []
                self.chat = type("Chat", (), {
                    "completions": type("Comp", (), {
                        "create": lambda _s, **kw: self.calls.append(kw) or completion,
                    })(),
                })()
                self.models = type("Models", (), {"list": lambda _s=None: []})()

        adapter = BasetenAdapter(
            model="meta-models/muse-spark-open",
            api_key="k", client=EmptyClient())
        with self.assertRaises(ObservationError):
            adapter.verify_image()

    def _wire_adapter(self, key, handler):
        """Real SDK client over a mocked transport: no network, real wire."""
        import httpx2 as httpx
        from openai import OpenAI

        transport = httpx.MockTransport(handler)
        client = OpenAI(
            api_key=key,
            base_url="https://inference.baseten.co/v1",
            http_client=httpx.Client(transport=transport),
            max_retries=0,
        )
        return BasetenAdapter(
            model="meta-models/muse-spark-open", api_key=key, client=client)

    def test_verify_image_sends_reasoning_effort_on_wire(self):
        import httpx2 as httpx

        seen = {}

        def handler(request):
            seen["body"] = json.loads(request.content.decode("utf-8"))
            return httpx.Response(200, json={
                "id": "chatcmpl-verify",
                "object": "chat.completion",
                "created": 1,
                "model": "meta-models/muse-spark-open",
                "choices": [{
                    "index": 0,
                    "message": {"role": "assistant", "content": "Red"},
                    "finish_reason": "stop",
                }],
            })

        adapter = self._wire_adapter("k", handler)
        adapter.verify_image()
        self.assertEqual(seen["body"]["model"], "meta-models/muse-spark-open")
        self.assertEqual(seen["body"]["max_tokens"], 512)
        self.assertEqual(seen["body"]["reasoning_effort"], "low")
        content = seen["body"]["messages"][0]["content"]
        self.assertEqual(content[1]["type"], "image_url")
        self.assertTrue(
            content[1]["image_url"]["url"].startswith("data:image/png;base64,"))

    def test_403_keeps_provider_code_and_body_text(self):
        import httpx2 as httpx

        def handler(request):
            return httpx.Response(403, json={
                "message": "Model access forbidden for this key",
                "type": "forbidden",
            })

        adapter = self._wire_adapter("secret-key-9", handler)
        with self.assertRaises(VisionAPIError) as ctx:
            adapter.verify_image()
        # 403 is an auth/permission failure, never an empty response.
        self.assertEqual(ctx.exception.code, "auth")
        self.assertEqual(ctx.exception.status, 403)
        self.assertEqual(ctx.exception.provider, "baseten")
        self.assertIn("Model access forbidden for this key", str(ctx.exception))
        self.assertNotIn("secret-key-9", str(ctx.exception))

    def test_403_body_redacts_embedded_secrets(self):
        import httpx2 as httpx

        def handler(request):
            return httpx.Response(403, json={
                "message": "key secret-key-9 is not entitled for this model",
            })

        adapter = self._wire_adapter("secret-key-9", handler)
        with self.assertRaises(VisionAPIError) as ctx:
            adapter.verify_image()
        self.assertEqual(ctx.exception.code, "auth")
        self.assertNotIn("secret-key-9", str(ctx.exception))
        self.assertIn("[REDACTED]", str(ctx.exception))

    def test_legacy_model_id_is_normalized(self):
        from ai_commentator.vision.providers import baseten as baseten_module

        fake = FakeOpenAIClient(content="Red")
        adapter = BasetenAdapter(
            model=baseten_module.LEGACY_MODEL,
            api_key="k", client=fake)
        self.assertEqual(adapter.model, baseten_module.MODEL)
        adapter.verify_image()
        self.assertEqual(fake.calls[0]["model"], baseten_module.MODEL)

    def test_registry_normalizes_legacy_baseten_model(self):
        from ai_commentator.vision.providers import baseten as baseten_module
        from ai_commentator.vision.providers.registry import (
            resolve_provider_config,
            validate_provider_model,
        )

        provider, model = validate_provider_model(
            "baseten", baseten_module.LEGACY_MODEL)
        self.assertEqual((provider, model), ("baseten", baseten_module.MODEL))
        env = {
            "BASETEN_API_KEY": "k",
            "BASETEN_MODEL": baseten_module.LEGACY_MODEL,
        }
        with mock.patch.dict("os.environ", env, clear=True):
            config = resolve_provider_config()
        self.assertEqual(config["model"], baseten_module.MODEL)


class MetaAdapterTests(unittest.TestCase):
    def _run_with_payload(self, payload, check=None):
        adapter = MetaAdapter(model="muse-spark-1.3", api_key="meta-key")
        seen = {}

        def fake_urlopen(request, timeout=None):
            seen["url"] = request.full_url
            seen["auth"] = request.headers.get("Authorization")
            seen["body"] = json.loads(request.data.decode("utf-8"))
            seen["timeout"] = timeout
            if check:
                check(seen)
            return FakeHTTPResponse(payload)

        with mock.patch.object(meta_module.urllib.request, "urlopen",
                               side_effect=fake_urlopen):
            text = adapter.request_observation_text(3, "data:image/jpeg;base64,AAA")
        return seen, text

    def test_posts_to_responses_endpoint_with_bearer(self):
        seen, text = self._run_with_payload(make_response_payload(TINY_OBSERVATION))
        self.assertEqual(seen["url"], "https://api.meta.ai/v1/responses")
        self.assertEqual(seen["auth"], "Bearer meta-key")
        self.assertEqual(seen["body"]["model"], "muse-spark-1.3")
        self.assertFalse(seen["body"]["stream"])
        self.assertEqual(seen["body"]["input"][0]["type"], "message")
        content = seen["body"]["input"][0]["content"]
        self.assertEqual(content[0]["type"], "input_text")
        self.assertEqual(content[1]["type"], "input_image")
        self.assertEqual(content[1]["image_url"], "data:image/jpeg;base64,AAA")
        self.assertEqual(text, TINY_OBSERVATION)

    def test_extracts_output_text_shapes(self):
        self.assertEqual(
            meta_module.extract_output_text({"output_text": " hi "}), " hi ")
        self.assertEqual(
            meta_module.extract_output_text({"choices": [
                {"message": {"content": "direct"}}]}), "direct")
        with self.assertRaises(ObservationError):
            meta_module.extract_output_text({"output": []})
        with self.assertRaises(ObservationError):
            meta_module.extract_output_text({"output_text": "   "})

    def test_rejects_unknown_model(self):
        with self.assertRaises(ValueError):
            MetaAdapter(model="gpt-4", api_key="k")

    def test_http_error_redacts_secret(self):
        import urllib.error

        adapter = MetaAdapter(model="muse-spark-1.3", api_key="leak-me")
        err = urllib.error.HTTPError(
            "https://api.meta.ai/v1/responses", 401, "Unauthorized",
            {}, io.BytesIO(b"bad leak-me key"))
        with mock.patch.object(meta_module.urllib.request, "urlopen",
                               side_effect=err):
            with self.assertRaises(VisionAPIError) as ctx:
                adapter.request_observation_text(3, "data:image/jpeg;base64,AAA")
        self.assertNotIn("leak-me", str(ctx.exception))

    def test_verify_image_uses_image_payload(self):
        adapter = MetaAdapter(model="muse-wonder-1.0", api_key="k")

        def fake_urlopen(request, timeout=None):
            body = json.loads(request.data.decode("utf-8"))
            assert body["input"][0]["type"] == "message"
            content = body["input"][0]["content"]
            assert content[1]["type"] == "input_image"
            return FakeHTTPResponse(make_response_payload("OK"))

        with mock.patch.object(meta_module.urllib.request, "urlopen",
                               side_effect=fake_urlopen):
            adapter.verify_image()

    def test_verify_image_allows_reasoning_headroom(self):
        adapter = MetaAdapter(model="muse-spark-1.3", api_key="k")

        def fake_urlopen(request, timeout=None):
            body = json.loads(request.data.decode("utf-8"))
            assert body["input"][0]["type"] == "message"
            assert body["max_output_tokens"] == 512
            assert body["reasoning"] == {"effort": "minimal"}
            assert body["input"][0]["content"][1] == {
                "type": "input_image",
                "image_url": meta_module.VERIFY_IMAGE_DATA_URL,
            }
            return FakeHTTPResponse(make_response_payload("Red"))

        with mock.patch.object(meta_module.urllib.request, "urlopen",
                               side_effect=fake_urlopen):
            adapter.verify_image()

    def test_verify_connection_uses_typed_message(self):
        adapter = MetaAdapter(model="muse-spark-1.3", api_key="k")
        seen = {}

        def fake_urlopen(request, timeout=None):
            seen["body"] = json.loads(request.data.decode("utf-8"))
            return FakeHTTPResponse(make_response_payload("OK"))

        with mock.patch.object(meta_module.urllib.request, "urlopen",
                               side_effect=fake_urlopen):
            adapter.verify_connection()
        self.assertEqual(seen["body"]["input"][0]["type"], "message")
        self.assertEqual(seen["body"]["reasoning"], {"effort": "minimal"})

    def test_incomplete_budget_is_not_empty_response(self):
        exhausted = {
            "status": "incomplete",
            "incomplete_details": {"reason": "max_output_tokens"},
            "output": [],
        }
        with self.assertRaises(VisionAPIError) as ctx:
            meta_module.extract_output_text(exhausted)
        self.assertEqual(ctx.exception.code, "output_exhausted")

    def test_incomplete_other_reason_is_bad_response(self):
        filtered = {
            "status": "incomplete",
            "incomplete_details": {"reason": "content_filter"},
            "output": [],
        }
        with self.assertRaises(VisionAPIError) as ctx:
            meta_module.extract_output_text(filtered)
        self.assertEqual(ctx.exception.code, "bad_response")

    def test_verify_image_reports_budget_exhaustion(self):
        adapter = MetaAdapter(model="muse-spark-1.3", api_key="k")
        body = {
            "status": "incomplete",
            "incomplete_details": {"reason": "max_output_tokens"},
            "output": [],
        }
        with mock.patch.object(meta_module.urllib.request, "urlopen",
                               return_value=FakeHTTPResponse(body)):
            with self.assertRaises(VisionAPIError) as ctx:
                adapter.verify_image()
        self.assertEqual(ctx.exception.code, "output_exhausted")


class VerifyFixtureTests(unittest.TestCase):
    def test_fixture_is_a_deterministic_png(self):
        from ai_commentator.vision import verify as verify_module

        png = verify_module.build_verify_png()
        self.assertTrue(png.startswith(b"\x89PNG\r\n\x1a\n"))
        self.assertEqual(verify_module.build_verify_png(), png)
        url = verify_module.build_verify_data_url()
        self.assertTrue(url.startswith("data:image/png;base64,"))
        import base64
        raw = base64.b64decode(url.split(",", 1)[1])
        self.assertTrue(raw.startswith(b"\x89PNG"))
        self.assertGreater(len(raw), 100)
        self.assertIn("color", verify_module.VERIFY_PROMPT.lower())

    def test_validate_verify_text_rejects_silence(self):
        from ai_commentator.vision.verify import validate_verify_text

        self.assertEqual(validate_verify_text("  Red  ", "Meta"), "Red")
        with self.assertRaises(ObservationError):
            validate_verify_text("   ", "Meta")
        with self.assertRaises(ObservationError):
            validate_verify_text("", "Baseten")
        with self.assertRaises(ObservationError):
            validate_verify_text(None, "Baseten")


class ProviderErrorTaxonomyTests(unittest.TestCase):
    def test_baseten_status_codes_map_to_categories(self):
        from openai import (
            AuthenticationError,
            BadRequestError,
            InternalServerError,
            NotFoundError,
            RateLimitError,
        )

        cases = [
            (AuthenticationError, "auth", 401),
            (NotFoundError, "model", 404),
            (BadRequestError, "bad_request", 400),
            (RateLimitError, "rate_limit", 429),
            (InternalServerError, "provider_error", 500),
        ]
        for cls, code, status in cases:
            with self.subTest(cls=cls.__name__):
                adapter = BasetenAdapter(
                    model="meta-models/muse-spark-open",
                    api_key="k", client=FailingApiClient(cls, status=status))
                with self.assertRaises(VisionAPIError) as ctx:
                    adapter.verify_connection()
                self.assertEqual(ctx.exception.code, code)
                self.assertEqual(ctx.exception.status, status)
                self.assertEqual(ctx.exception.provider, "baseten")

    def test_baseten_timeout_and_connection_map(self):
        from openai import APIConnectionError, APITimeoutError

        adapter = BasetenAdapter(
            model="meta-models/muse-spark-open",
            api_key="k", client=FailingApiClient(APITimeoutError))
        with self.assertRaises(VisionAPIError) as ctx:
            adapter.verify_connection()
        self.assertEqual(ctx.exception.code, "timeout")

        adapter = BasetenAdapter(
            model="meta-models/muse-spark-open",
            api_key="k", client=FailingApiClient(APIConnectionError))
        with self.assertRaises(VisionAPIError) as ctx:
            adapter.verify_connection()
        self.assertEqual(ctx.exception.code, "network")

    def test_baseten_verify_image_asks_about_content(self):
        fake = FakeOpenAIClient(content="Red")
        adapter = BasetenAdapter(
            model="meta-models/muse-spark-open",
            api_key="k", client=fake)
        adapter.verify_image()
        prompt = fake.calls[0]["messages"][0]["content"][0]["text"]
        self.assertIn("color", prompt.lower())
        image = fake.calls[0]["messages"][0]["content"][1]["image_url"]["url"]
        self.assertTrue(image.startswith("data:image/png;base64,"))
        self.assertGreater(len(image), 200)

    def test_baseten_verify_image_rejects_empty_answer(self):
        fake = FakeOpenAIClient(content="  ")
        adapter = BasetenAdapter(
            model="meta-models/muse-spark-open",
            api_key="k", client=fake)
        with self.assertRaises(ObservationError):
            adapter.verify_image()

    def test_meta_http_status_maps_to_categories(self):
        import urllib.error

        cases = [(401, "auth"), (403, "auth"), (404, "model"),
                 (400, "bad_request"), (429, "rate_limit"), (500, "provider_error")]
        for status, code in cases:
            with self.subTest(status=status):
                adapter = MetaAdapter(model="muse-spark-1.3", api_key="k")
                err = urllib.error.HTTPError(
                    "https://api.meta.ai/v1/responses", status, "Err",
                    {}, __import__("io").BytesIO(b"bad"))
                self.addCleanup(err.close)
                with mock.patch.object(meta_module.urllib.request, "urlopen",
                                       side_effect=err):
                    with self.assertRaises(VisionAPIError) as ctx:
                        adapter.verify_connection()
                self.assertEqual(ctx.exception.code, code)
                self.assertEqual(ctx.exception.status, status)
                self.assertEqual(ctx.exception.provider, "meta")

    def test_meta_transport_failures_map(self):
        import urllib.error

        adapter = MetaAdapter(model="muse-spark-1.3", api_key="k")
        with mock.patch.object(meta_module.urllib.request, "urlopen",
                               side_effect=urllib.error.URLError("dns fail")):
            with self.assertRaises(VisionAPIError) as ctx:
                adapter.verify_connection()
        self.assertEqual(ctx.exception.code, "network")

        with mock.patch.object(meta_module.urllib.request, "urlopen",
                               side_effect=TimeoutError("slow")):
            with self.assertRaises(VisionAPIError) as ctx:
                adapter.verify_connection()
        self.assertEqual(ctx.exception.code, "timeout")

    def test_meta_verify_image_proves_content_not_just_http(self):
        adapter = MetaAdapter(model="muse-spark-1.3", api_key="k")
        seen = {}

        def fake_urlopen(request, timeout=None):
            body = __import__("json").loads(request.data.decode("utf-8"))
            seen["text"] = body["input"][0]["content"][0]["text"]
            seen["image"] = body["input"][0]["content"][1]["image_url"]
            return FakeHTTPResponse(make_response_payload("   "))

        with mock.patch.object(meta_module.urllib.request, "urlopen",
                               side_effect=fake_urlopen):
            with self.assertRaises(ObservationError):
                adapter.verify_image()
        self.assertIn("color", seen["text"].lower())
        self.assertTrue(seen["image"].startswith("data:image/png;base64,"))


class FailingApiClient:
    """Injectable client whose models.list raises a given API error."""

    def __init__(self, error_cls, status=None):
        self._error_cls = error_cls
        self._status = status
        self.calls = []
        self.closed = False

    @property
    def models(self):
        error_cls = self._error_cls
        status = self._status

        class Raiser:
            def list(self, *args, **kwargs):
                if status is not None:
                    response = mock.Mock()
                    response.status_code = status
                    raise error_cls(
                        message="boom", response=response, body=None)
                request = mock.Mock()
                request.method = "GET"
                raise error_cls(message="boom", request=request, body=None)

        return Raiser()

    def close(self):
        self.closed = True


class RegistryTests(unittest.TestCase):
    def test_catalogue_contents(self):
        self.assertEqual(tuple(get_provider_models("meta")),
                         ("muse-spark-1.3", "muse-wonder-1.0"))
        self.assertEqual(tuple(get_provider_models("baseten")),
                         ("meta-models/muse-spark-open",))
        self.assertTrue(is_supported_model("meta", "muse-spark-1.3"))
        self.assertFalse(is_supported_model("meta", "meta-models/muse-spark-open"))
        self.assertFalse(is_supported_model("baseten", "muse-spark-1.3"))
        with self.assertRaises(ValueError):
            get_provider_models("openai")

    def test_factory_rejects_cross_provider_models(self):
        with self.assertRaises(ValueError):
            create_adapter("baseten", "muse-spark-1.3", "k")
        with self.assertRaises(ValueError):
            create_adapter("meta", "meta-models/muse-spark-open", "k")
        with self.assertRaises(ValueError):
            create_adapter("openai", "x", "k")

    def test_resolve_explicit_env(self):
        env = {"AI_COMMENTATOR_PROVIDER": "meta",
               "AI_COMMENTATOR_MODEL": "muse-spark-1.3",
               "AI_COMMENTATOR_API_KEY": "k"}
        with mock.patch.dict(os.environ, env, clear=False):
            os.environ.pop("BASETEN_API_KEY", None)
            resolved = resolve_provider_config()
        self.assertEqual(resolved,
                         {"provider": "meta", "model": "muse-spark-1.3",
                          "api_key": "k"})

    def test_resolve_legacy_baseten_fallback(self):
        env = {"BASETEN_API_KEY": "legacy",
               "BASETEN_MODEL": "meta-models/muse-spark-open"}
        with mock.patch.dict(os.environ, env, clear=True):
            resolved = resolve_provider_config()
        self.assertEqual(resolved["provider"], "baseten")
        self.assertEqual(resolved["api_key"], "legacy")

    def test_resolve_never_guesses_provider(self):
        with mock.patch.dict(os.environ, {"BASETEN_API_KEY": "x"}, clear=True):
            resolved = resolve_provider_config()
        self.assertEqual(resolved["provider"], "baseten")

    def test_resolve_missing_key_raises(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(RuntimeError):
                resolve_provider_config()

    def test_resolve_explicit_without_key_raises(self):
        env = {"AI_COMMENTATOR_PROVIDER": "meta",
               "AI_COMMENTATOR_MODEL": "muse-spark-1.3"}
        with mock.patch.dict(os.environ, env, clear=True):
            with self.assertRaises(RuntimeError):
                resolve_provider_config()


if __name__ == "__main__":
    unittest.main()
