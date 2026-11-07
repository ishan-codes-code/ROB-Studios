"""Offline tests for script-to-audio generation (TTS runner + manifest).

No live API calls: a fake TTS client stands in for the Gemini TTS
endpoint, and fixtures reuse the production script builders.
Run natively from the repository root:
    .venv/bin/python -m unittest discover -s tests -v
"""

import contextlib
import hashlib
import io
import json
import os
import sys
import tempfile
import unittest
from unittest import mock
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))

import main
from main import (
    ObservationError,
    run_generate_tts,
    sanitize_segment_filename,
    validate_tts_manifest,
)

TTS_KEY = "test-tts-key-not-a-secret"


def wav_bytes(duration_seconds=0.5, rate=24000):
    """Build real, wave-readable WAV bytes for fake synthesis output."""
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(b"\x00\x00" * int(rate * duration_seconds))
    return buffer.getvalue()


def script_segment(index, text=None, timestamp=None):
    return {
        "segment_id": f"segment-{index:03d}",
        "timestamp_seconds": float(index * 3 if timestamp is None else timestamp),
        "text": (
            text
            if text is not None
            else f"Commentary line number {index} with enough words to validate."
        ),
        "source_claim_ids": [f"clm-{index:012x}"],
    }


def script_doc(segments, status="success", error=None):
    return {
        "schema_version": "script-v1",
        "status": status,
        "generated_from": {
            "observations": ["frame_00000.json"],
            "match_state": "match_state.json",
            "events": "events.json",
        },
        "segments": list(segments),
        "omitted": [],
        "error": error,
    }


def write_script(directory, doc):
    path = Path(directory) / "script.json"
    path.write_text(json.dumps(doc), encoding="utf-8")
    return path


class FakeTTSClient:
    """Mimics GeminiTTSClient.synthesize with scripted per-text output."""

    def __init__(self, handler=None):
        self._handler = handler or (lambda text: wav_bytes())
        self.calls = []
        self.close_calls = 0

    def synthesize(self, text, *, voice, style):
        self.calls.append({"text": text, "voice": voice, "style": style})
        return self._handler(text)

    def close(self):
        self.close_calls += 1


def failing_handler(fail_on, exc):
    def handle(text):
        if text == fail_on:
            raise exc
        return wav_bytes(duration_seconds=0.25 + len(text) % 5 / 10.0)

    return handle


class TtsRunnerTests(unittest.TestCase):
    maxDiff = 4000

    def run_tts(self, script_path, audio_dir, **kwargs):
        stdout = io.StringIO()
        stderr = io.StringIO()
        kwargs.setdefault("api_key", TTS_KEY)
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = run_generate_tts(
                script_path=script_path, audio_dir=audio_dir, **kwargs
            )
        return code, stdout.getvalue(), stderr.getvalue()

    def test_success_writes_one_wav_per_segment(self):
        segments = [script_segment(1), script_segment(2), script_segment(3)]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_path = write_script(root, script_doc(segments))
            before = hashlib.sha256(script_path.read_bytes()).hexdigest()
            audio_dir = root / "audio"
            fake = FakeTTSClient(
                lambda text: wav_bytes(duration_seconds=0.2 + len(text) % 3 / 10.0)
            )
            code, _, _ = self.run_tts(script_path, audio_dir, client=fake)
            self.assertEqual(code, 0)
            self.assertEqual(fake.close_calls, 0)
            # Exact texts passed in order with the configured voice/style.
            self.assertEqual(
                [call["text"] for call in fake.calls],
                [segment["text"] for segment in segments],
            )
            self.assertTrue(all(call["voice"] == "Kore" for call in fake.calls))
            # One stable WAV per segment with the exact synthesized bytes.
            for segment in segments:
                wav_path = audio_dir / "segments" / f"{segment['segment_id']}.wav"
                self.assertTrue(wav_path.is_file(), wav_path)
                with wave.open(str(wav_path), "rb") as handle:
                    self.assertEqual(
                        (handle.getframerate(), handle.getnchannels()),
                        (24000, 1),
                    )
            manifest = validate_tts_manifest(
                json.loads((audio_dir / "tts.json").read_text(encoding="utf-8"))
            )
            self.assertEqual(manifest["status"], "success")
            self.assertEqual(len(manifest["entries"]), 3)
            entry = manifest["entries"][0]
            self.assertEqual(entry["segment_id"], "segment-001")
            self.assertEqual(entry["timestamp_seconds"], 3.0)
            self.assertEqual(entry["text"], segments[0]["text"])
            self.assertEqual(entry["source_claim_ids"], ["clm-000000000001"])
            self.assertEqual(entry["audio_file"], "segments/segment-001.wav")
            self.assertEqual(entry["status"], "success")
            self.assertIsNone(entry["error"])
            self.assertEqual(
                hashlib.sha256(script_path.read_bytes()).hexdigest(), before
            )

    def test_entries_follow_script_order(self):
        segments = [
            script_segment(1, timestamp=0),
            script_segment(2, timestamp=3),
            script_segment(3, timestamp=3),
            script_segment(4, timestamp=7),
        ]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_path = write_script(root, script_doc(segments))
            audio_dir = root / "audio"
            code, _, _ = self.run_tts(
                script_path, audio_dir, client=FakeTTSClient()
            )
            self.assertEqual(code, 0)
            manifest = json.loads((audio_dir / "tts.json").read_text(encoding="utf-8"))
            self.assertEqual(
                [entry["segment_id"] for entry in manifest["entries"]],
                [segment["segment_id"] for segment in segments],
            )

    def test_out_of_order_script_rejected_before_any_call(self):
        segments = [script_segment(1, timestamp=6), script_segment(2, timestamp=3)]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_path = write_script(root, script_doc(segments))
            audio_dir = root / "audio"
            fake = FakeTTSClient()
            code, _, stderr = self.run_tts(
                script_path, audio_dir, client=fake
            )
            self.assertEqual(code, 1)
            self.assertEqual(fake.calls, [])
            self.assertIn("chronological", stderr)
            self.assertFalse(audio_dir.exists())

    def test_empty_text_rejected_before_any_call(self):
        segments = [script_segment(1, text="")]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_path = write_script(root, script_doc(segments))
            audio_dir = root / "audio"
            fake = FakeTTSClient()
            code, _, _ = self.run_tts(script_path, audio_dir, client=fake)
            self.assertEqual(code, 1)
            self.assertEqual(fake.calls, [])
            self.assertFalse((audio_dir / "tts.json").exists())

    def test_silence_writes_empty_manifest_without_calls(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_path = write_script(root, script_doc([], status="silence"))
            audio_dir = root / "audio"
            fake = FakeTTSClient()
            code, _, _ = self.run_tts(script_path, audio_dir, client=fake)
            self.assertEqual(code, 0)
            self.assertEqual(fake.calls, [])
            manifest = validate_tts_manifest(
                json.loads((audio_dir / "tts.json").read_text(encoding="utf-8"))
            )
            self.assertEqual(manifest["status"], "silence")
            self.assertEqual(manifest["entries"], [])

    def test_error_status_script_fails_without_calls_or_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_path = write_script(
                root, script_doc([], status="error", error="The model failed.")
            )
            audio_dir = root / "audio"
            fake = FakeTTSClient()
            code, _, stderr = self.run_tts(script_path, audio_dir, client=fake)
            self.assertEqual(code, 1)
            self.assertEqual(fake.calls, [])
            self.assertIn("error", stderr.lower())
            self.assertFalse((audio_dir / "tts.json").exists())

    def test_missing_key_fails_before_any_call(self):
        segments = [script_segment(1)]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_path = write_script(root, script_doc(segments))
            audio_dir = root / "audio"
            fake = FakeTTSClient()
            env = dict(os.environ)
            env.pop("AI_COMMENTATOR_PROVIDER_API_KEY", None)
            with mock.patch.dict(os.environ, env, clear=True):
                code, _, stderr = self.run_tts(
                    script_path, audio_dir, api_key=None, client=fake
                )
            self.assertEqual(code, 1)
            self.assertEqual(fake.calls, [])
            self.assertIn("AI_COMMENTATOR_PROVIDER_API_KEY", stderr)
            self.assertFalse(audio_dir.exists())

    def test_invalid_model_rejected_before_any_call(self):
        segments = [script_segment(1)]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_path = write_script(root, script_doc(segments))
            audio_dir = root / "audio"
            fake = FakeTTSClient()
            code, _, _ = self.run_tts(
                script_path, audio_dir, model="gemini-2.0-flash", client=fake
            )
            self.assertEqual(code, 1)
            self.assertEqual(fake.calls, [])

    def test_segment_failure_isolated_and_reported(self):
        segments = [script_segment(1), script_segment(2), script_segment(3)]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_path = write_script(root, script_doc(segments))
            before = hashlib.sha256(script_path.read_bytes()).hexdigest()
            audio_dir = root / "audio"
            from main import TtsError

            fake = FakeTTSClient(
                failing_handler(segments[1]["text"], TtsError("provider blew up"))
            )
            code, _, _ = self.run_tts(script_path, audio_dir, client=fake)
            self.assertEqual(code, 1)
            # Every segment was attempted in order despite the failure.
            self.assertEqual(
                [call["text"] for call in fake.calls],
                [segment["text"] for segment in segments],
            )
            manifest = validate_tts_manifest(
                json.loads((audio_dir / "tts.json").read_text(encoding="utf-8"))
            )
            self.assertEqual(manifest["status"], "partial")
            statuses = [entry["status"] for entry in manifest["entries"]]
            self.assertEqual(statuses, ["success", "error", "success"])
            failed = manifest["entries"][1]
            self.assertIsNone(failed["audio_file"])
            self.assertIn("provider blew up", failed["error"])
            self.assertEqual(
                manifest["entries"][0]["audio_file"], "segments/segment-001.wav"
            )
            self.assertEqual(
                manifest["entries"][2]["audio_file"], "segments/segment-003.wav")
            self.assertEqual(
                hashlib.sha256(script_path.read_bytes()).hexdigest(), before
            )

    def test_successful_wavs_preserved_after_later_failure(self):
        segments = [script_segment(1), script_segment(2)]
        expected_first = wav_bytes(duration_seconds=0.7)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_path = write_script(root, script_doc(segments))
            audio_dir = root / "audio"
            from main import TtsError

            def handle(text):
                if text == segments[1]["text"]:
                    raise TtsError("second segment failed")
                return expected_first

            code, _, _ = self.run_tts(
                script_path, audio_dir, client=FakeTTSClient(handle)
            )
            self.assertEqual(code, 1)
            first_wav = audio_dir / "segments" / "segment-001.wav"
            self.assertTrue(first_wav.is_file())
            self.assertEqual(first_wav.read_bytes(), expected_first)
            self.assertFalse((audio_dir / "segments" / "segment-002.wav").exists())

    def test_all_failed_manifest_reports_error(self):
        segments = [script_segment(1), script_segment(2)]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_path = write_script(root, script_doc(segments))
            audio_dir = root / "audio"
            from main import TtsError

            # Every synthesis raises: the handler ignores its argument.
            fake = FakeTTSClient(lambda text: (_ for _ in ()).throw(TtsError("down")))
            code, _, _ = self.run_tts(script_path, audio_dir, client=fake)
            self.assertEqual(code, 1)
            manifest = validate_tts_manifest(
                json.loads((audio_dir / "tts.json").read_text(encoding="utf-8"))
            )
            self.assertEqual(manifest["status"], "error")
            self.assertEqual(len(manifest["entries"]), 2)
            self.assertTrue(all(entry["status"] == "error" for entry in manifest["entries"]))

    def test_credential_redaction(self):
        segments = [script_segment(1)]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_path = write_script(root, script_doc(segments))
            audio_dir = root / "audio"
            leaky_key = "leaky-tts-key-abcdef"
            fake = FakeTTSClient(
                lambda text: (_ for _ in ()).throw(
                    RuntimeError(f"auth failed for {leaky_key} end")
                )
            )
            code, stdout, stderr = self.run_tts(
                script_path, audio_dir, api_key=leaky_key, client=fake
            )
            self.assertEqual(code, 1)
            manifest_text = (audio_dir / "tts.json").read_text(encoding="utf-8")
            for surface in (manifest_text, stdout, stderr):
                self.assertNotIn(leaky_key, surface)
            self.assertIn("[REDACTED]", manifest_text)

    def test_filenames_are_stable_and_sanitized(self):
        self.assertEqual(sanitize_segment_filename("segment-001"), "segment-001")
        self.assertEqual(
            sanitize_segment_filename("seg 01/final:take"), "seg_01_final_take"
        )
        with self.assertRaises(ValueError):
            sanitize_segment_filename("")
        with self.assertRaises(ValueError):
            sanitize_segment_filename("  ")
        segments = [
            {
                "segment_id": "seg 01/final:take",
                "timestamp_seconds": 0,
                "text": "A commentary line with enough words to validate here.",
                "source_claim_ids": ["clm-000000000001"],
            }
        ]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_path = write_script(root, script_doc(segments))
            first = root / "audio-first"
            second = root / "audio-second"
            code, _, _ = self.run_tts(
                script_path, first, client=FakeTTSClient()
            )
            self.assertEqual(code, 0)
            code, _, _ = self.run_tts(
                script_path, second, client=FakeTTSClient()
            )
            self.assertEqual(code, 0)
            for audio_dir in (first, second):
                manifest = json.loads(
                    (audio_dir / "tts.json").read_text(encoding="utf-8")
                )
                self.assertEqual(
                    manifest["entries"][0]["audio_file"],
                    "segments/seg_01_final_take.wav",
                )
                self.assertTrue(
                    (audio_dir / "segments" / "seg_01_final_take.wav").is_file()
                )

    def test_filename_collision_fails_before_any_call(self):
        segments = [
            {
                "segment_id": "a/b",
                "timestamp_seconds": 0,
                "text": "First commentary line with enough words to validate.",
                "source_claim_ids": ["clm-000000000001"],
            },
            {
                "segment_id": "a_b",
                "timestamp_seconds": 3,
                "text": "Second commentary line with enough words to validate.",
                "source_claim_ids": ["clm-000000000002"],
            },
        ]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_path = write_script(root, script_doc(segments))
            audio_dir = root / "audio"
            fake = FakeTTSClient()
            code, _, stderr = self.run_tts(script_path, audio_dir, client=fake)
            self.assertEqual(code, 1)
            self.assertEqual(fake.calls, [])
            self.assertIn("filename", stderr.lower())
            self.assertFalse((audio_dir / "tts.json").exists())

    def test_generation_id_binds_script_and_config(self):
        from ai_commentator.tts.config import generation_identity

        segments = [script_segment(1)]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_path = write_script(root, script_doc(segments))
            audio_dir = root / "audio"
            code, _, _ = self.run_tts(
                script_path,
                audio_dir,
                model="gemini-3.8-flash-lite-tts",
                voice="Fenrir",
                voice_direction="Calm and measured.",
                client=FakeTTSClient(),
            )
            self.assertEqual(code, 0)
            manifest = json.loads((audio_dir / "tts.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["model"], "gemini-3.8-flash-lite-tts")
            self.assertEqual(manifest["voice"], "Fenrir")
            self.assertEqual(manifest["voice_direction"], "Calm and measured.")
            self.assertEqual(
                manifest["generation_id"],
                generation_identity(
                    script_path.read_bytes(),
                    "gemini-3.8-flash-lite-tts",
                    "Fenrir",
                    "Calm and measured.",
                ),
            )


class TtsManifestValidationTests(unittest.TestCase):
    def valid_manifest(self):
        return {
            "schema_version": "tts-v1",
            "status": "success",
            "generation_id": "ab" * 32,
            "model": "gemini-3.8-flash-tts",
            "voice": "Kore",
            "voice_direction": "Energetic esports commentator.",
            "generated_from": {"script": "script.json"},
            "entries": [
                {
                    "segment_id": "segment-001",
                    "timestamp_seconds": 3.0,
                    "text": "A commentary line with enough words to validate.",
                    "source_claim_ids": ["clm-000000000001"],
                    "audio_file": "segments/segment-001.wav",
                    "status": "success",
                    "error": None,
                }
            ],
        }

    def test_valid_manifest_accepted(self):
        self.assertEqual(validate_tts_manifest(self.valid_manifest())["status"], "success")

    def test_skipped_entry_accepted(self):
        doc = self.valid_manifest()
        doc["entries"] = [
            {
                "segment_id": "segment-001",
                "timestamp_seconds": 3.0,
                "text": "A commentary line with enough words to validate.",
                "source_claim_ids": ["clm-000000000001"],
                "audio_file": None,
                "status": "skipped",
                "error": None,
            }
        ]
        self.assertEqual(validate_tts_manifest(doc)["entries"][0]["status"], "skipped")

    def test_rejects(self):
        cases = []
        bad_version = self.valid_manifest()
        bad_version["schema_version"] = "tts-v0"
        cases.append(("schema_version", bad_version))
        extra_field = self.valid_manifest()
        extra_field["extra"] = 1
        cases.append(("extra top-level field", extra_field))
        bad_status = self.valid_manifest()
        bad_status["status"] = "done"
        cases.append(("run status", bad_status))
        silence_with_entries = self.valid_manifest()
        silence_with_entries["status"] = "silence"
        cases.append(("silence with entries", silence_with_entries))
        success_with_error = self.valid_manifest()
        success_with_error["entries"][0]["status"] = "error"
        success_with_error["entries"][0]["audio_file"] = None
        success_with_error["entries"][0]["error"] = "boom"
        cases.append(("success with error entry", success_with_error))
        error_file = self.valid_manifest()
        error_file["status"] = "error"
        error_file["entries"][0]["status"] = "error"
        error_file["entries"][0]["error"] = "boom"
        cases.append(("error entry with audio file", error_file))
        missing_error_text = self.valid_manifest()
        missing_error_text["status"] = "error"
        missing_error_text["entries"][0]["status"] = "error"
        missing_error_text["entries"][0]["audio_file"] = None
        cases.append(("error entry without message", missing_error_text))
        reordered = self.valid_manifest()
        reordered["entries"] = [
            dict(reordered["entries"][0], timestamp_seconds=9.0),
            dict(
                reordered["entries"][0],
                segment_id="segment-002",
                timestamp_seconds=3.0,
                audio_file="segments/segment-002.wav",
            ),
        ]
        cases.append(("out-of-order entries", reordered))
        for name, doc in cases:
            with self.subTest(name):
                with self.assertRaises(ObservationError):
                    validate_tts_manifest(doc)


class WriteBytesAtomicTests(unittest.TestCase):
    def test_round_trip_without_leftovers(self):
        from main import write_bytes_atomic

        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "sub" / "clip.wav"
            payload = wav_bytes()
            write_bytes_atomic(target, payload)
            self.assertEqual(target.read_bytes(), payload)
            leftovers = list(Path(tmp).rglob("*.tmp"))
            self.assertEqual(leftovers, [])


class TtsClientConstructionTests(unittest.TestCase):
    """Owned SDK clients must target v1beta (offline, fake google modules)."""

    def test_owned_client_pins_v1beta_api_version(self):
        import types as stdlib_types

        from ai_commentator.tts.client import GeminiTTSClient

        captured = {}

        def fake_http_options(**kwargs):
            captured.update(kwargs)
            return stdlib_types.SimpleNamespace(**kwargs)

        class FakeSdkClient:
            def __init__(self, **kwargs):
                self.init_kwargs = kwargs

            def close(self):
                pass

        fake_genai = stdlib_types.SimpleNamespace(Client=FakeSdkClient)
        fake_types = stdlib_types.SimpleNamespace(HttpOptions=fake_http_options)
        google = stdlib_types.ModuleType("google")
        google.genai = fake_genai
        fake_genai.types = fake_types
        modules = {"google": google, "google.genai": fake_genai,
                   "google.genai.types": fake_types}
        with mock.patch.dict(sys.modules, modules):
            client = GeminiTTSClient(api_key="construction-probe-not-a-secret")
        try:
            self.assertEqual(captured.get("api_version"), "v1beta")
            self.assertEqual(captured.get("timeout"), 60000)
        finally:
            client.close()


if __name__ == "__main__":
    unittest.main()
