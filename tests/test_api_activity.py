"""API activity capture: pairing, redaction, batch/fallback accounting."""

import base64
import io
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))

from ai_commentator import api_activity
from ai_commentator.api_activity import (
    ApiRequestTracker,
    fail_from_error,
    sanitize_metadata,
    usage_of,
)


class FakeRawResponse:
    def __init__(self, text, status_code=200, finish_reason="stop",
                 in_tokens=10, out_tokens=20):
        self.status_code = status_code
        self._text = text
        self._finish = finish_reason
        self._in = in_tokens
        self._out = out_tokens

    def parse(self):
        return SimpleNamespace(
            choices=[SimpleNamespace(
                message=SimpleNamespace(content=self._text),
                finish_reason=self._finish,
            )],
            usage=SimpleNamespace(prompt_tokens=self._in,
                                  completion_tokens=self._out),
        )


class FakeCompletions:
    def __init__(self, raw):
        self._raw = raw
        self.calls = 0

    @property
    def with_raw_response(self):
        return self

    def create(self, **kwargs):
        self.calls += 1
        return self._raw


class FakeChatClient:
    def __init__(self, raw):
        self.chat = SimpleNamespace(completions=FakeCompletions(raw))


def valid_batch_text():
    frames = []
    for stamp in (4, 8):
        frames.append({
            "observation": {
                "schema_version": "observation-v1",
                "timestamp": stamp,
                "observations": [{
                    "category": "scene",
                    "description": "A visible arena.",
                    "confidence": "high",
                    "evidence": "Bright floor and walls.",
                }],
                "uncertainties": [],
            },
            "sampling": {"next_sampling_speed": "NORMAL",
                         "reason": "Steady play."},
        })
    return json.dumps({"frames": frames})


class TrackerPairingTest(unittest.TestCase):
    def tearDown(self):
        api_activity.drain_events()

    def test_started_then_single_terminal(self):
        tracker = ApiRequestTracker("baseten", "vision", model="m",
                                    frame_count=1)
        tracker.start()
        tracker.succeed(http_status=200, input_tokens=3, output_tokens=5)
        tracker.succeed(http_status=200)
        tracker.fail(error_code="x")
        events = api_activity.drain_events()
        self.assertEqual(len(events), 2)
        started, terminal = events
        self.assertEqual(started["event"], "started")
        self.assertEqual(terminal["event"], "terminal")
        self.assertEqual(started["id"], terminal["id"])
        self.assertEqual(terminal["status"], "succeeded")
        self.assertGreaterEqual(terminal["durationMs"], 0)
        self.assertEqual(terminal["httpStatus"], 200)
        self.assertEqual(terminal["inputTokens"], 3)
        self.assertEqual(terminal["outputTokens"], 5)
        self.assertEqual(started["frameCount"], 1)

    def test_fail_carries_code_and_bounded_message(self):
        tracker = ApiRequestTracker("meta", "vision-batch", model="m")
        tracker.start()
        tracker.fail(error_code="output_exhausted", message="x" * 500,
                     http_status=200)
        events = api_activity.drain_events()
        self.assertEqual(len(events), 2)
        terminal = events[1]
        self.assertEqual(terminal["status"], "failed")
        self.assertEqual(terminal["errorCode"], "output_exhausted")
        self.assertLessEqual(len(terminal["errorMessage"]), 301)
        self.assertEqual(terminal["httpStatus"], 200)

    def test_drain_empties_buffer(self):
        tracker = ApiRequestTracker("custom", "commentary")
        tracker.start()
        tracker.cancel()
        self.assertEqual(len(api_activity.drain_events()), 2)
        self.assertEqual(api_activity.drain_events(), [])


class SanitizeMetadataTest(unittest.TestCase):
    def test_drops_secret_and_payload_keys(self):
        cleaned = sanitize_metadata({
            "voice": "Aoede",
            "api_key": "sk-secret",
            "Authorization": "Bearer x",
            "image_data_url": "data:image/png;base64,....",
            "prompt": "describe this",
            "request_body": {"a": 1},
            "attempt": 2,
        })
        self.assertEqual(cleaned, {"voice": "Aoede", "attempt": "2"})

    def test_non_dict_and_long_values(self):
        self.assertEqual(sanitize_metadata(None), {})
        self.assertEqual(sanitize_metadata("x"), {})
        cleaned = sanitize_metadata({"note": "y" * 500})
        self.assertLessEqual(len(cleaned["note"]), 121)


class UsageOfTest(unittest.TestCase):
    def test_openai_style_attributes(self):
        response = SimpleNamespace(
            usage=SimpleNamespace(prompt_tokens=7, completion_tokens=9))
        self.assertEqual(usage_of(response), (7, 9))

    def test_dict_usage(self):
        response = SimpleNamespace(
            usage={"prompt_tokens": 1, "completion_tokens": 2})
        self.assertEqual(usage_of(response), (1, 2))

    def test_meta_body_dict(self):
        body = {"output": [], "usage": {"input_tokens": 4,
                                        "output_tokens": 6}}
        self.assertEqual(usage_of(body), (4, 6))

    def test_missing_usage(self):
        self.assertEqual(usage_of(SimpleNamespace()), (None, None))
        self.assertEqual(usage_of({}), (None, None))


class FailFromErrorTest(unittest.TestCase):
    def tearDown(self):
        api_activity.drain_events()

    def test_structured_fields_survive(self):
        from ai_commentator.errors import VisionAPIError

        tracker = ApiRequestTracker("baseten", "vision")
        tracker.start()
        fail_from_error(
            tracker,
            VisionAPIError("Baseten API HTTP 429: slow down",
                           code="quota", status=429, provider="baseten"))
        terminal = api_activity.drain_events()[1]
        self.assertEqual(terminal["errorCode"], "quota")
        self.assertEqual(terminal["httpStatus"], 429)
        self.assertIn("429", terminal["errorMessage"])

    def test_plain_exception_becomes_unknown(self):
        tracker = ApiRequestTracker("meta", "vision")
        tracker.start()
        fail_from_error(tracker, RuntimeError("boom"))
        terminal = api_activity.drain_events()[1]
        self.assertEqual(terminal["errorCode"], "unknown")
        self.assertNotIn("httpStatus", terminal)


class AdapterAccountingTest(unittest.TestCase):
    def setUp(self):
        api_activity.drain_events()

    def tearDown(self):
        api_activity.drain_events()

    def test_batch_is_one_request(self):
        from ai_commentator.vision.providers.baseten import (
            MODEL,
            BasetenAdapter,
        )

        raw = FakeRawResponse(valid_batch_text())
        adapter = BasetenAdapter(model=MODEL, api_key="test-key",
                                 client=FakeChatClient(raw))
        adapter.request_adaptive_batch_text(
            [4, 8], ["data:image/jpeg;base64,AAA", "data:image/jpeg;base64,BBB"])
        events = api_activity.drain_events()
        self.assertEqual(len(events), 2)
        started, terminal = events
        self.assertEqual(started["event"], "started")
        self.assertEqual(terminal["event"], "terminal")
        self.assertEqual(started["purpose"], "vision-batch")
        self.assertEqual(started["frameCount"], 2)
        self.assertEqual(terminal["status"], "succeeded")
        self.assertEqual(terminal["httpStatus"], 200)
        self.assertEqual(terminal["inputTokens"], 10)
        self.assertEqual(terminal["outputTokens"], 20)

    def test_single_frame_fallback_is_a_separate_request(self):
        from ai_commentator.vision.providers.baseten import (
            MODEL,
            BasetenAdapter,
        )

        text = json.dumps({
            "observation": {
                "schema_version": "observation-v1",
                "timestamp": 4,
                "observations": [],
                "uncertainties": ["Too dark."],
            },
            "sampling": {"next_sampling_speed": "LOW",
                         "reason": "Nothing visible."},
        })
        adapter = BasetenAdapter(model=MODEL, api_key="test-key",
                                 client=FakeChatClient(
                                     FakeRawResponse(text)))
        adapter.request_adaptive_text(4, "data:image/jpeg;base64,AAA")
        adapter.request_adaptive_text(8, "data:image/jpeg;base64,BBB")
        events = api_activity.drain_events()
        starts = [e for e in events if e["event"] == "started"]
        terminals = [e for e in events if e["event"] == "terminal"]
        self.assertEqual(len(starts), 2)
        self.assertEqual(len(terminals), 2)
        self.assertNotEqual(starts[0]["id"], starts[1]["id"])
        self.assertTrue(all(e["purpose"] == "vision-adaptive"
                            for e in starts))

    def test_adapter_error_never_leaks_key_or_image(self):
        from openai import APIError

        from ai_commentator.vision.providers.baseten import (
            MODEL,
            BasetenAdapter,
        )

        class FailingCompletions(FakeCompletions):
            def create(self, **kwargs):
                raise APIError("bad key", request=None, body=None)

        class FailingClient:
            chat = SimpleNamespace(completions=FailingCompletions(None))

        adapter = BasetenAdapter(model=MODEL, api_key="sk-live-test-key",
                                 client=FailingClient())
        with self.assertRaises(Exception):
            adapter.request_observation_text(4, "data:image/jpeg;base64,AAA")
        events = api_activity.drain_events()
        self.assertEqual(len(events), 2)
        terminal = events[1]
        self.assertEqual(terminal["status"], "failed")
        blob = json.dumps(events)
        self.assertNotIn("sk-live-test-key", blob)
        self.assertNotIn("base64,AAA", blob)


class TtsAccountingTest(unittest.TestCase):
    def tearDown(self):
        api_activity.drain_events()

    def test_synthesize_is_one_tracked_utterance(self):
        from ai_commentator.tts.client import GeminiTTSClient

        wav = b"RIFF" + bytes(60)
        interaction = SimpleNamespace(output_audio=SimpleNamespace(
            data=base64.b64encode(wav).decode("ascii"),
            mime_type="audio/wav",
        ))

        class FakeInteractions:
            def __init__(self):
                self.calls = 0

            def create(self, **kwargs):
                self.calls += 1
                self.kwargs = kwargs
                return interaction

        fake = FakeInteractions()
        client = GeminiTTSClient(api_key="tts-key",
                                 client=SimpleNamespace(interactions=fake))
        result = client.synthesize("Hello world.", voice="Aoede",
                                   style="conversational")
        self.assertEqual(result, wav)
        self.assertEqual(fake.calls, 1)
        events = api_activity.drain_events()
        self.assertEqual(len(events), 2)
        started, terminal = events
        self.assertEqual(started["purpose"], "tts")
        self.assertEqual(started["provider"], "google-gemini-tts")
        self.assertEqual(started["metadata"]["voice"], "Aoede")
        self.assertEqual(terminal["status"], "succeeded")
        blob = json.dumps(events)
        self.assertNotIn("Hello world.", blob)
        self.assertNotIn("tts-key", blob)

    def test_synthesize_failure_pairs_terminal(self):
        from ai_commentator.tts.client import GeminiTTSClient

        class FailingInteractions:
            def create(self, **kwargs):
                error = RuntimeError("tts-key rejected by backend")
                error.status_code = 401
                raise error

        client = GeminiTTSClient(
            api_key="tts-key",
            client=SimpleNamespace(interactions=FailingInteractions()))
        with self.assertRaises(Exception):
            client.synthesize("Hi.", voice="Aoede", style="conversational")
        events = api_activity.drain_events()
        self.assertEqual(len(events), 2)
        terminal = events[1]
        self.assertEqual(terminal["status"], "failed")
        self.assertEqual(terminal["errorCode"], "auth")
        self.assertEqual(terminal["httpStatus"], 401)
        self.assertNotIn("tts-key", json.dumps(events))


class WorkerDrainTest(unittest.TestCase):
    def tearDown(self):
        api_activity.drain_events()

    def test_drain_emits_ndjson_activity_messages(self):
        import worker as worker_module

        tracker = ApiRequestTracker("baseten", "vision", model="m")
        tracker.start()
        tracker.succeed(http_status=200)
        captured = io.StringIO()
        previous = worker_module.REAL_STDOUT
        worker_module.REAL_STDOUT = captured
        try:
            written = worker_module.drain_api_activity()
        finally:
            worker_module.REAL_STDOUT = previous
        self.assertEqual(written, 2)
        lines = captured.getvalue().strip().split("\n")
        self.assertEqual(len(lines), 2)
        first = json.loads(lines[0])
        second = json.loads(lines[1])
        self.assertEqual(first["type"], "api_activity")
        self.assertEqual(first["run_id"], worker_module.RUN_ID)
        self.assertEqual(first["activity"]["event"], "started")
        self.assertEqual(second["activity"]["event"], "terminal")
        self.assertEqual(second["activity"]["status"], "succeeded")
        self.assertEqual(first["activity"]["id"],
                         second["activity"]["id"])

    def test_drain_skips_malformed_events(self):
        import worker as worker_module

        api_activity._BUFFER.append({"nope": True})
        captured = io.StringIO()
        previous = worker_module.REAL_STDOUT
        worker_module.REAL_STDOUT = captured
        try:
            written = worker_module.drain_api_activity()
        finally:
            worker_module.REAL_STDOUT = previous
        self.assertEqual(written, 0)
        self.assertEqual(captured.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
