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
    def __init__(self, content):
        self.message = FakeMessage(content)


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
            model="meta-models/muse-spark-open-1026",
            api_key="k", client=fake)
        text = adapter.request_observation_text(3, "data:image/jpeg;base64,AAA")
        self.assertEqual(text, TINY_OBSERVATION)
        call = fake.calls[0]
        self.assertEqual(call["model"], "meta-models/muse-spark-open-1026")
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
            model="meta-models/muse-spark-open-1026",
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
            model="meta-models/muse-spark-open-1026",
            api_key="secret-key-123", client=FailingClient())
        with self.assertRaises(VisionAPIError) as ctx:
            adapter.request_observation_text(3, "data:image/jpeg;base64,AAA")
        self.assertNotIn("secret-key-123", str(ctx.exception))
        self.assertIn("[REDACTED]", str(ctx.exception))

    def test_text_only_request(self):
        fake = FakeOpenAIClient(content='{"lines": []}')
        adapter = BasetenAdapter(
            model="meta-models/muse-spark-open-1026",
            api_key="k", client=fake)
        self.assertEqual(adapter.request_text("hello"), '{"lines": []}')
        self.assertEqual(fake.calls[0]["messages"],
                         [{"role": "user", "content": "hello"}])

    def test_injected_client_never_closed(self):
        fake = FakeOpenAIClient()
        adapter = BasetenAdapter(
            model="meta-models/muse-spark-open-1026",
            api_key="k", client=fake)
        adapter.close()
        self.assertFalse(fake.closed)


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
            content = body["input"][0]["content"]
            assert content[1]["type"] == "input_image"
            return FakeHTTPResponse(make_response_payload("OK"))

        with mock.patch.object(meta_module.urllib.request, "urlopen",
                               side_effect=fake_urlopen):
            adapter.verify_image()


class RegistryTests(unittest.TestCase):
    def test_catalogue_contents(self):
        self.assertEqual(tuple(get_provider_models("meta")),
                         ("muse-spark-1.3", "muse-wonder-1.0"))
        self.assertEqual(tuple(get_provider_models("baseten")),
                         ("meta-models/muse-spark-open-1026",))
        self.assertTrue(is_supported_model("meta", "muse-spark-1.3"))
        self.assertFalse(is_supported_model("meta", "meta-models/muse-spark-open-1026"))
        self.assertFalse(is_supported_model("baseten", "muse-spark-1.3"))
        with self.assertRaises(ValueError):
            get_provider_models("openai")

    def test_factory_rejects_cross_provider_models(self):
        with self.assertRaises(ValueError):
            create_adapter("baseten", "muse-spark-1.3", "k")
        with self.assertRaises(ValueError):
            create_adapter("meta", "meta-models/muse-spark-open-1026", "k")
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
               "BASETEN_MODEL": "meta-models/muse-spark-open-1026"}
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
