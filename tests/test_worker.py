"""Tests for the Electron worker protocol (python/worker.py).

Offline only: no Baseten calls. Subprocess runs strip BASETEN_API_KEY
from the environment so a paid call is impossible even by accident.
Run natively:
    .venv/bin/python -m unittest discover -s tests -v
"""

import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))

import cv2
import numpy as np

import worker
from worker import emit, validate_video

WORKER_PATH = Path(worker.__file__)


def write_test_video(path, seconds=7, fps=10):
    path = Path(path)
    writer = cv2.VideoWriter(
        str(path), cv2.VideoWriter_fourcc(*"mp4v"), fps, (64, 48)
    )
    if not writer.isOpened():
        raise AssertionError("test video writer did not open (mp4v unavailable?)")
    frame = np.zeros((48, 64, 3), dtype=np.uint8)
    for _ in range(seconds * fps):
        writer.write(frame)
    writer.release()
    return path


def seed_observations(obs_dir, timestamps=(0, 3, 6)):
    obs_dir = Path(obs_dir)
    obs_dir.mkdir(parents=True, exist_ok=True)
    for timestamp in timestamps:
        doc = {
            "schema_version": "observation-v1",
            "timestamp": timestamp,
            "observations": [
                {
                    "category": "environment",
                    "description": "Arid desert mesas under bright light.",
                    "confidence": "high",
                    "evidence": "Fixture evidence.",
                }
            ],
            "uncertainties": [],
        }
        (obs_dir / f"frame_{timestamp:05d}.json").write_text(
            json.dumps(doc), encoding="utf-8"
        )
    return obs_dir


def offline_env():
    env = dict(os.environ)
    env.pop("BASETEN_API_KEY", None)
    env.pop("AI_COMMENTATOR_API_KEY", None)
    env.pop("AI_COMMENTATOR_PROVIDER_API_KEY", None)
    return env


def run_worker(*argv, env=None):
    return subprocess.run(
        [sys.executable, str(WORKER_PATH), *argv],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=180,
        text=True,
        env=offline_env() if env is None else env,
    )


def parse_stdout_lines(proc):
    lines = proc.stdout.splitlines()
    assert lines, "worker printed nothing on stdout"
    return [json.loads(line) for line in lines]


class ValidateVideoTests(unittest.TestCase):
    def test_missing_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            problem = validate_video(Path(tmp) / "nope.mp4")
        self.assertIsNotNone(problem)
        self.assertIn("not found", problem)

    def test_directory_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            problem = validate_video(Path(tmp))
        self.assertIsNotNone(problem)

    def test_unsupported_extension_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            candidate = Path(tmp) / "clip.txt"
            candidate.write_text("not a video", encoding="utf-8")
            problem = validate_video(candidate)
        self.assertIsNotNone(problem)
        self.assertIn(".txt", problem)

    def test_supported_extensions_accepted(self):
        with tempfile.TemporaryDirectory() as tmp:
            for suffix in worker.SUPPORTED_VIDEO_EXTENSIONS:
                candidate = Path(tmp) / f"clip{suffix}"
                candidate.write_bytes(b"\x00")
                self.assertIsNone(
                    validate_video(candidate), msg=f"extension {suffix}"
                )


class EmitTests(unittest.TestCase):
    def test_emit_is_single_json_line(self):
        out, saved = io.StringIO(), worker.REAL_STDOUT
        worker.REAL_STDOUT = out
        try:
            emit({"type": "progress", "stage": "adaptive_vision"})
        finally:
            worker.REAL_STDOUT = saved
        self.assertEqual(out.getvalue().count("\n"), 1)
        self.assertEqual(
            json.loads(out.getvalue()),
            {"type": "progress", "stage": "adaptive_vision"},
        )


class WorkerCliTests(unittest.TestCase):
    def test_missing_video_argument_exits_2(self):
        with self.assertRaises(SystemExit) as raised:
            worker.main([])
        self.assertEqual(raised.exception.code, 2)

    def test_missing_file_reports_error_json_and_exits_2(self):
        with tempfile.TemporaryDirectory() as tmp:
            proc = run_worker(str(Path(tmp) / "nope.mp4"))
        self.assertEqual(proc.returncode, 2)
        messages = parse_stdout_lines(proc)
        self.assertEqual(len(messages), 1)
        self.assertEqual(messages[0]["type"], "error")
        self.assertEqual(messages[0]["stage"], "validation")

    def test_unsupported_extension_exits_2(self):
        with tempfile.TemporaryDirectory() as tmp:
            candidate = Path(tmp) / "clip.txt"
            candidate.write_text("not a video", encoding="utf-8")
            proc = run_worker(str(candidate))
        self.assertEqual(proc.returncode, 2)
        messages = parse_stdout_lines(proc)
        self.assertEqual(messages[0]["type"], "error")

    def test_missing_key_fails_fast_before_any_work(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            video = write_test_video(root / "clip.mp4")
            out = root / "out"
            proc = run_worker(str(video), "--output-dir", str(out), "--adaptive")
        self.assertEqual(proc.returncode, 1)
        messages = parse_stdout_lines(proc)
        self.assertEqual(messages[0]["type"], "error")
        self.assertEqual(messages[0]["stage"], "adaptive_vision")
        self.assertIn("BASETEN_API_KEY", messages[0]["message"])
        # Fail-fast: no output tree created.
        self.assertFalse(out.exists())

    def test_adaptive_flag_is_required(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            video = write_test_video(root / "clip.mp4")
            proc = run_worker(str(video), "--output-dir", str(root / "out"))
        self.assertEqual(proc.returncode, 2)
        messages = parse_stdout_lines(proc)
        self.assertEqual(messages[0]["type"], "error")
        self.assertEqual(messages[0]["stage"], "validation")
        self.assertIn("--adaptive", messages[0]["message"])

    def test_removed_flags_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            video = write_test_video(root / "clip.mp4")
            for extra in (["--limit", "10"], ["--skip-vision"], ["--force"]):
                proc = run_worker(
                    str(video),
                    "--output-dir",
                    str(root / "out"),
                    "--adaptive",
                    *extra,
                )
                self.assertEqual(proc.returncode, 2, msg=extra)

    def test_missing_key_blocks_opt_in_script(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            video = write_test_video(root / "clip.mp4")
            proc = run_worker(
                str(video),
                "--output-dir",
                str(root / "out"),
                "--adaptive",
                "--with-script",
            )
        self.assertEqual(proc.returncode, 1)
        messages = parse_stdout_lines(proc)
        self.assertEqual(messages[0]["type"], "error")
        self.assertEqual(messages[0]["stage"], "adaptive_vision")

    def test_never_prints_secret_values(self):
        sentinel = "unit-test-sentinel-credential"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            video = write_test_video(root / "clip.mp4")
            env = offline_env()
            env["BASETEN_API_KEY"] = sentinel
            proc = run_worker(
                str(video),
                "--output-dir",
                str(root / "out"),
                env=env,
            )
        self.assertEqual(proc.returncode, 2)
        self.assertNotIn(sentinel, proc.stdout)
        self.assertNotIn(sentinel, proc.stderr)

    def test_generate_tts_requires_with_script(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            video = write_test_video(root / "clip.mp4")
            proc = run_worker(
                str(video),
                "--output-dir",
                str(root / "out"),
                "--adaptive",
                "--generate-tts",
            )
        self.assertEqual(proc.returncode, 2)
        messages = parse_stdout_lines(proc)
        self.assertEqual(messages[0]["type"], "error")
        self.assertEqual(messages[0]["stage"], "validation")
        self.assertIn("--with-script", messages[0]["message"])

    def test_missing_tts_key_fails_fast_before_any_work(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            video = write_test_video(root / "clip.mp4")
            out = root / "out"
            env = offline_env()
            env["BASETEN_API_KEY"] = "unit-test-sentinel-vision-key"
            proc = run_worker(
                str(video),
                "--output-dir",
                str(out),
                "--adaptive",
                "--with-script",
                "--generate-tts",
                env=env,
            )
        self.assertEqual(proc.returncode, 1)
        messages = parse_stdout_lines(proc)
        self.assertEqual(messages[0]["type"], "error")
        self.assertEqual(messages[0]["stage"], "tts")
        self.assertIn("AI_COMMENTATOR_PROVIDER_API_KEY", messages[0]["message"])
        self.assertNotIn("unit-test-sentinel-vision-key", proc.stdout)
        self.assertNotIn("unit-test-sentinel-vision-key", proc.stderr)
        # Fail-fast: no output tree created.
        self.assertFalse(out.exists())

    def test_invalid_tts_config_fails_fast_before_any_work(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            video = write_test_video(root / "clip.mp4")
            out = root / "out"
            env = offline_env()
            env["BASETEN_API_KEY"] = "unit-test-sentinel-vision-key"
            env["AI_COMMENTATOR_PROVIDER_API_KEY"] = "unit-test-sentinel-tts-key"
            proc = run_worker(
                str(video),
                "--output-dir",
                str(out),
                "--adaptive",
                "--with-script",
                "--generate-tts",
                "--tts-model",
                "not-a-real-model",
                env=env,
            )
        self.assertEqual(proc.returncode, 1)
        messages = parse_stdout_lines(proc)
        self.assertEqual(messages[0]["type"], "error")
        self.assertEqual(messages[0]["stage"], "tts")
        self.assertIn("Invalid TTS configuration", messages[0]["message"])
        self.assertNotIn("unit-test-sentinel-vision-key", proc.stdout)
        self.assertNotIn("unit-test-sentinel-tts-key", proc.stderr)
        self.assertFalse(out.exists())

    def test_never_prints_tts_secret_values(self):
        sentinel = "unit-test-sentinel-tts-credential"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            video = write_test_video(root / "clip.mp4")
            env = offline_env()
            env["AI_COMMENTATOR_PROVIDER_API_KEY"] = sentinel
            proc = run_worker(
                str(video),
                "--output-dir",
                str(root / "out"),
                "--adaptive",
                "--generate-tts",
                env=env,
            )
        self.assertEqual(proc.returncode, 2)
        self.assertNotIn(sentinel, proc.stdout)
        self.assertNotIn(sentinel, proc.stderr)

class AdaptivePlanTests(unittest.TestCase):
    """Adaptive-only planning: pure plan, honest failure, no skips."""

    def flags(self, adaptive=True, with_script=False, generate_tts=False):
        import types

        return types.SimpleNamespace(
            adaptive=adaptive,
            adaptive_max_frames=None,
            with_script=with_script,
            generate_tts=generate_tts,
        )

    def test_plan_is_adaptive_with_downstream(self):
        plan = worker.plan_stages(self.flags())
        self.assertEqual(
            [stage for stage, _ in plan],
            [
                "adaptive_vision",
                "state_rebuild",
                "event_detection",
                "commentary",
            ],
        )
        self.assertTrue(all(mode == "run" for _, mode in plan))
        self.assertEqual(worker.run_mode(plan), "adaptive")

    def test_plan_without_adaptive_is_rejected(self):
        with self.assertRaises(ValueError):
            worker.plan_stages(self.flags(adaptive=False))

    def test_plan_appends_script_when_requested(self):
        plan = worker.plan_stages(self.flags(with_script=True))
        self.assertEqual(plan[-1], ("script", "run"))

    def test_plan_appends_tts_after_script_when_requested(self):
        plan = worker.plan_stages(self.flags(with_script=True, generate_tts=True))
        self.assertEqual(plan[-2:], [("script", "run"), ("tts", "run")])

    def test_plan_rejects_tts_without_script(self):
        with self.assertRaises(ValueError):
            worker.plan_stages(self.flags(generate_tts=True))

    def test_corrupt_observations_fail_state_rebuild(self):
        import io as std_io
        import json as std_json

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            video = write_test_video(root / "clip.mp4")
            out = root / "out"
            obs = out / "observations"
            obs.mkdir(parents=True)
            (obs / "frame_00000.json").write_text(
                "{invalid json", encoding="utf-8"
            )

            def fake_adaptive(**kwargs):
                return {
                    "status": "succeeded",
                    "termination": "complete",
                    "observations": 1,
                    "requests": 1,
                    "manifest": None,
                }

            buffer = std_io.StringIO()
            real = worker.REAL_STDOUT
            worker.REAL_STDOUT = buffer
            try:
                with mock.patch.object(
                    worker.engine, "run_adaptive_vision", side_effect=fake_adaptive
                ):
                    code, data = worker.run_pipeline(
                        self._pipeline_args(str(video), str(out))
                    )
            finally:
                worker.REAL_STDOUT = real
            messages = [
                std_json.loads(line) for line in buffer.getvalue().splitlines()
            ]
        self.assertEqual(code, 1)
        self.assertEqual(data, {})
        errors = [m for m in messages if m["type"] == "error"]
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0]["stage"], "state_rebuild")
        self.assertFalse([m for m in messages if m["type"] == "result"])

    def _pipeline_args(self, video, out):
        import types

        return types.SimpleNamespace(
            video=video,
            output_dir=out,
            adaptive=True,
            adaptive_max_frames=None,
            with_script=False,
        )


class AdaptiveRunTests(unittest.TestCase):
    """Adaptive runs: honest success, honest failure, key fail-fast.

    Paid API calls are never made here: ``run_adaptive_vision`` is
    mocked and subprocess runs use the key-stripped offline
    environment."""

    def run_pipeline_quiet(self, args):
        import io as std_io
        import json as std_json

        buffer = std_io.StringIO()
        real = worker.REAL_STDOUT
        worker.REAL_STDOUT = buffer
        try:
            code, data = worker.run_pipeline(args)
        finally:
            worker.REAL_STDOUT = real
        messages = [std_json.loads(line) for line in buffer.getvalue().splitlines()]
        return code, data, messages

    def adaptive_args(self, video, out, **overrides):
        import types

        kwargs = {
            "video": video,
            "output_dir": out,
            "adaptive": True,
            "adaptive_max_frames": None,
            "with_script": False,
        }
        kwargs.update(overrides)
        return types.SimpleNamespace(**kwargs)

    def fake_success(self, obs_dir):
        def fake_adaptive(**kwargs):
            seed_observations(Path(obs_dir))
            return {
                "status": "succeeded",
                "termination": "complete",
                "observations": 3,
                "requests": 2,
                "manifest": None,
            }

        return fake_adaptive

    def test_adaptive_success_completes_pipeline(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            video = write_test_video(root / "clip.mp4")
            out = root / "out"
            with mock.patch.object(
                worker.engine,
                "run_adaptive_vision",
                side_effect=self.fake_success(out / "observations"),
            ):
                code, data, messages = self.run_pipeline_quiet(
                    self.adaptive_args(str(video), str(out))
                )
            self.assertEqual(code, 0)
            self.assertEqual(data["mode"], "adaptive")
            self.assertEqual(
                data["stages"],
                [
                    "adaptive_vision",
                    "state_rebuild",
                    "event_detection",
                    "commentary",
                ],
            )
            self.assertEqual(data["skipped"], [])
            self.assertGreater(data["observations"], 0)
            self.assertIsNotNone(data["artifacts"]["state"])
            self.assertIsNotNone(data["artifacts"]["events"])
            self.assertIsNotNone(data["artifacts"]["commentary"])
            totals = {
                message["total"]
                for message in messages
                if message["type"] in ("progress", "stage_completed")
            }
            self.assertEqual(totals, {4})
            # Artifacts referenced in the result actually exist.
            for key in ("state", "events", "commentary"):
                self.assertTrue(
                    Path(data["artifacts"][key]).is_file(), msg=key
                )

    def test_adaptive_failure_fails_run_without_results(self):
        import tempfile

        def fake_failed(**kwargs):
            return {
                "status": "failed",
                "termination": "request-failed",
                "observations": 0,
                "requests": 1,
                "error": {"phase": "request-failed", "message": "boom"},
            }

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            video = write_test_video(root / "clip.mp4")
            out = root / "out"
            with mock.patch.object(
                worker.engine, "run_adaptive_vision", side_effect=fake_failed
            ):
                code, data, messages = self.run_pipeline_quiet(
                    self.adaptive_args(str(video), str(out))
                )
        self.assertEqual(code, 1)
        self.assertEqual(data, {})
        errors = [m for m in messages if m["type"] == "error"]
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0]["stage"], "adaptive_vision")
        self.assertFalse([m for m in messages if m["type"] == "result"])

    def test_adaptive_run_without_key_fails_fast(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            video = write_test_video(root / "clip.mp4")
            out = root / "out"
            proc = run_worker(
                str(video),
                "--output-dir",
                str(out),
                "--adaptive",
                env=offline_env(),
            )
        self.assertEqual(proc.returncode, 1)
        messages = parse_stdout_lines(proc)
        self.assertEqual(len(messages), 1)
        self.assertEqual(messages[0]["type"], "error")
        self.assertEqual(messages[0]["stage"], "adaptive_vision")
        self.assertIn("BASETEN_API_KEY", messages[0]["message"])
        self.assertFalse(out.exists())


class TtsStageTests(unittest.TestCase):
    """Worker TTS stage: runs after script generation, never before it.

    Paid calls are never made here: the vision, script, and TTS runners
    are all mocked; only the offline downstream stages run for real."""

    def run_pipeline_quiet(self, args):
        import io as std_io
        import json as std_json

        buffer = std_io.StringIO()
        real = worker.REAL_STDOUT
        worker.REAL_STDOUT = buffer
        try:
            code, data = worker.run_pipeline(args)
        finally:
            worker.REAL_STDOUT = real
        messages = [std_json.loads(line) for line in buffer.getvalue().splitlines()]
        return code, data, messages

    def tts_args(self, video, out, **overrides):
        import types

        kwargs = {
            "video": video,
            "output_dir": out,
            "adaptive": True,
            "adaptive_max_frames": None,
            "with_script": True,
            "generate_tts": True,
        }
        kwargs.update(overrides)
        return types.SimpleNamespace(**kwargs)

    def fake_adaptive(self, obs_dir):
        def run(**kwargs):
            seed_observations(Path(obs_dir))
            return {
                "status": "succeeded",
                "termination": "complete",
                "observations": 3,
                "requests": 2,
                "manifest": None,
            }

        return run

    def fake_script(self, **kwargs):
        script_path = Path(kwargs["script_path"])
        script_path.parent.mkdir(parents=True, exist_ok=True)
        script_path.write_text(
            json.dumps(
                {
                    "schema_version": "script-v1",
                    "status": "success",
                    "generated_from": {
                        "observations": ["frame_00000.json"],
                        "match_state": "match_state.json",
                        "events": "events.json",
                    },
                    "segments": [
                        {
                            "segment_id": "segment-001",
                            "timestamp_seconds": 0,
                            "text": "A commentary line with enough words to validate.",
                            "source_claim_ids": ["clm-000000000001"],
                        }
                    ],
                    "omitted": [],
                    "error": None,
                }
            ),
            encoding="utf-8",
        )
        return 0

    def fake_tts_success(self, **kwargs):
        audio_dir = Path(kwargs["audio_dir"])
        audio_dir.mkdir(parents=True, exist_ok=True)
        manifest = worker.engine.build_tts_manifest(
            generation_id="ab" * 32,
            model=worker.engine.DEFAULT_TTS_MODEL,
            voice=worker.engine.DEFAULT_TTS_VOICE,
            voice_direction=worker.engine.DEFAULT_TTS_VOICE_DIRECTION,
            script_name="script.json",
            script_status="success",
            entries=[
                {
                    "segment_id": "segment-001",
                    "timestamp_seconds": 0,
                    "text": "A commentary line with enough words to validate.",
                    "source_claim_ids": ["clm-000000000001"],
                    "audio_file": "segments/segment-001.wav",
                    "status": "success",
                    "error": None,
                }
            ],
        )
        (audio_dir / "tts.json").write_text(json.dumps(manifest), encoding="utf-8")
        return 0

    def test_tts_stage_completes_pipeline(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            video = write_test_video(root / "clip.mp4")
            out = root / "out"
            with (
                mock.patch.object(
                    worker.engine,
                    "run_adaptive_vision",
                    side_effect=self.fake_adaptive(out / "observations"),
                ),
                mock.patch.object(
                    worker.engine, "run_generate_script", side_effect=self.fake_script
                ),
                mock.patch.object(
                    worker.engine, "run_generate_tts", side_effect=self.fake_tts_success
                ),
            ):
                code, data, messages = self.run_pipeline_quiet(
                    self.tts_args(str(video), str(out))
                )
            self.assertEqual(code, 0)
            self.assertEqual(
                data["stages"],
                [
                    "adaptive_vision",
                    "state_rebuild",
                    "event_detection",
                    "commentary",
                    "script",
                    "tts",
                ],
            )
            self.assertEqual(data["tts"], "success")
            self.assertTrue(Path(data["artifacts"]["tts"]).is_file())
            totals = {
                message["total"]
                for message in messages
                if message["type"] in ("progress", "stage_completed")
            }
            self.assertEqual(totals, {6})
            completed = [
                message
                for message in messages
                if message["type"] == "stage_completed" and message["stage"] == "tts"
            ]
            self.assertEqual(len(completed), 1)
            self.assertEqual(
                completed[0]["detail"],
                {"status": "success", "segments": 1, "succeeded": 1, "failed": 0},
            )

    def test_resolve_tts_config_defaults(self):
        import types

        args = types.SimpleNamespace()
        self.assertEqual(
            worker.resolve_tts_config(args),
            (
                worker.engine.DEFAULT_TTS_MODEL,
                worker.engine.DEFAULT_TTS_VOICE,
                worker.engine.DEFAULT_TTS_VOICE_DIRECTION,
            ),
        )

    def test_resolve_tts_config_custom_and_rejections(self):
        import types

        args = types.SimpleNamespace(
            tts_model="gemini-3.8-flash-lite-tts",
            tts_voice="Fenrir",
            tts_voice_direction="Calm and measured.",
        )
        self.assertEqual(
            worker.resolve_tts_config(args),
            ("gemini-3.8-flash-lite-tts", "Fenrir", "Calm and measured."),
        )
        with self.assertRaises(ValueError):
            worker.resolve_tts_config(types.SimpleNamespace(tts_model="bogus"))
        with self.assertRaises(ValueError):
            worker.resolve_tts_config(types.SimpleNamespace(tts_voice=""))
        with self.assertRaises(ValueError):
            worker.resolve_tts_config(
                types.SimpleNamespace(tts_voice_direction="x" * 501)
            )

    def test_tts_stage_threads_configured_voice(self):
        captured = {}
        original = self.fake_tts_success

        def capturing(**kwargs):
            captured.update(
                {
                    key: kwargs[key]
                    for key in ("model", "voice", "voice_direction")
                }
            )
            return original(**kwargs)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            video = write_test_video(root / "clip.mp4")
            out = root / "out"
            with (
                mock.patch.object(
                    worker.engine,
                    "run_adaptive_vision",
                    side_effect=self.fake_adaptive(out / "observations"),
                ),
                mock.patch.object(
                    worker.engine, "run_generate_script", side_effect=self.fake_script
                ),
                mock.patch.object(
                    worker.engine, "run_generate_tts", side_effect=capturing
                ),
            ):
                code, _, _ = self.run_pipeline_quiet(
                    self.tts_args(
                        str(video),
                        str(out),
                        tts_model="gemini-3.8-flash-lite-tts",
                        tts_voice="Fenrir",
                        tts_voice_direction="Calm and measured.",
                    )
                )
            self.assertEqual(code, 0)
            self.assertEqual(
                captured,
                {
                    "model": "gemini-3.8-flash-lite-tts",
                    "voice": "Fenrir",
                    "voice_direction": "Calm and measured.",
                },
            )

    def test_tts_failure_fails_run_without_results(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            video = write_test_video(root / "clip.mp4")
            out = root / "out"
            with (
                mock.patch.object(
                    worker.engine,
                    "run_adaptive_vision",
                    side_effect=self.fake_adaptive(out / "observations"),
                ),
                mock.patch.object(
                    worker.engine, "run_generate_script", side_effect=self.fake_script
                ),
                mock.patch.object(worker.engine, "run_generate_tts", return_value=1),
            ):
                code, data, messages = self.run_pipeline_quiet(
                    self.tts_args(str(video), str(out))
                )
        self.assertEqual(code, 1)
        self.assertEqual(data, {})
        errors = [m for m in messages if m["type"] == "error"]
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0]["stage"], "tts")
        self.assertFalse([m for m in messages if m["type"] == "result"])


if __name__ == "__main__":
    unittest.main()
