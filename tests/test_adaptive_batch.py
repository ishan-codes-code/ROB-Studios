"""Offline tests for HIGH-speed multi-frame adaptive analysis.

No live API calls: an adapter-shaped fake stands in for the vision
providers, synthetic MP4s stand in for gameplay video. Run natively
from the repository root:
    .venv/Scripts/python -m unittest tests.test_adaptive_batch -v
"""

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from main import (  # noqa: E402
    analyze_adaptive_batch,
    build_adaptive_batch_prompt,
    parse_adaptive_batch_response,
    run_adaptive_vision,
)

from test_adaptive import FakeClient, echo_handler, observation_doc, write_test_video  # noqa: E402


def batch_text(entries):
    """Build a multi-frame wrapper text from (timestamp, speed) pairs."""
    return json.dumps(
        {
            "frames": [
                {
                    "observation": observation_doc(timestamp),
                    "sampling": {
                        "next_sampling_speed": speed,
                        "reason": f"{speed} action.",
                    },
                }
                for timestamp, speed in entries
            ]
        }
    )


def single_text(timestamp, speed="NORMAL"):
    return json.dumps(
        {
            "observation": observation_doc(timestamp),
            "sampling": {
                "next_sampling_speed": speed,
                "reason": f"{speed} action.",
            },
        }
    )


class FakeBatchAdapter:
    """Adapter-shaped fake: single-frame plus multi-frame methods."""

    def __init__(self, single_speeds=("NORMAL",), batch_speeds=("HIGH",)):
        self.single_speeds = list(single_speeds)
        self.batch_speeds = list(batch_speeds)
        self.single_calls = []
        self.batch_calls = []

    def request_observation_text(self, timestamp, image_data_url):
        raise AssertionError("batch tests never call the frame pipeline")

    def request_adaptive_text(self, timestamp, image_data_url, previous=None):
        self.single_calls.append(timestamp)
        speed = self.single_speeds.pop(0) if self.single_speeds else "NORMAL"
        return single_text(timestamp, speed)

    def request_adaptive_batch_text(self, timestamps, image_data_urls, previous=None):
        assert len(timestamps) == len(image_data_urls)
        self.batch_calls.append(list(timestamps))
        speeds = [
            self.batch_speeds.pop(0) if self.batch_speeds else "NORMAL"
            for _ in timestamps
        ]
        return batch_text(list(zip(timestamps, speeds)))


class BatchPromptTests(unittest.TestCase):
    def test_prompt_lists_frames_in_order(self):
        prompt = build_adaptive_batch_prompt([0.5, 0.667, 0.833])
        self.assertIn("frame 1 at 0.5 seconds", prompt)
        self.assertIn("frame 2 at 0.667 seconds", prompt)
        self.assertIn("frame 3 at 0.833 seconds", prompt)
        self.assertIn('"frames"', prompt)
        self.assertIn("observation-v1", prompt)
        self.assertLess(
            prompt.index("frame 1"), prompt.index("frame 2")
        )

    def test_prompt_carries_previous_context(self):
        prompt = build_adaptive_batch_prompt([1], previous=observation_doc(0))
        self.assertIn("Previous validated observation", prompt)


class BatchParseTests(unittest.TestCase):
    def test_round_trip_returns_per_frame_results(self):
        results = parse_adaptive_batch_response(
            batch_text([(0.5, "HIGH"), (0.667, "NORMAL")]), [0.5, 0.667]
        )
        self.assertEqual(len(results), 2)
        self.assertEqual(results[0][0]["timestamp"], 0.5)
        self.assertEqual(results[0][1], "HIGH")
        self.assertEqual(results[1][1], "NORMAL")
        self.assertEqual(results[0][3], [])
        self.assertEqual(results[1][3], [])

    def test_count_mismatch_fails(self):
        with self.assertRaises(Exception) as raised:
            parse_adaptive_batch_response(batch_text([(0.5, "HIGH")]), [0.5, 0.667])
        self.assertIn("expected 2", str(raised.exception))

    def test_timestamp_mismatch_names_expected(self):
        bad = json.dumps(
            {
                "frames": [
                    {
                        "observation": observation_doc(0),
                        "sampling": {
                            "next_sampling_speed": "HIGH",
                            "reason": "x",
                        },
                    }
                ]
            }
        )
        with self.assertRaises(Exception) as raised:
            parse_adaptive_batch_response(bad, [0.5])
        self.assertIn("expected 0.5", str(raised.exception))

    def test_extra_fields_rejected(self):
        bad = json.dumps({"frames": [], "extra": 1})
        with self.assertRaises(Exception) as raised:
            parse_adaptive_batch_response(bad, [])
        self.assertIn("unsupported fields", str(raised.exception))

    def test_missing_sampling_falls_back_to_normal(self):
        text = json.dumps(
            {"frames": [{"observation": observation_doc(1)}]}
        )
        (validated, speed, _reason, diagnostics) = parse_adaptive_batch_response(
            text, [1]
        )[0]
        self.assertEqual(validated["timestamp"], 1)
        self.assertEqual(speed, "NORMAL")
        self.assertEqual(diagnostics, ["sampling-missing"])


class BatchLoopTests(unittest.TestCase):
    def run_loop(self, client, seconds=7, **kwargs):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        video = write_test_video(root / "clip.mp4", seconds=seconds)
        obs_dir = root / "out" / "observations"
        with contextlib.redirect_stdout(io.StringIO()):
            with contextlib.redirect_stderr(io.StringIO()):
                result = run_adaptive_vision(
                    video_path=video,
                    observations_dir=obs_dir,
                    client=client,
                    **kwargs,
                )
        manifest = json.loads(
            (obs_dir / "adaptive_run.json").read_text(encoding="utf-8")
        )
        return result, manifest, obs_dir

    def test_high_speed_sends_one_multi_frame_request(self):
        seen = []
        client = FakeBatchAdapter(
            single_speeds=("HIGH",), batch_speeds=("HIGH", "HIGH", "NORMAL")
        )
        result, manifest, obs_dir = self.run_loop(
            client, max_frames=10, on_iteration=seen.append
        )
        # First frame single (no previous speed yet), then one batch.
        self.assertEqual(client.batch_calls, [[0.5, 0.667, 0.834]])
        self.assertEqual(len(client.single_calls), 3)
        self.assertEqual(result["status"], "completed")
        # One paid request for the batch, three persisted observations.
        self.assertEqual(result["requests"], 4)
        self.assertEqual(result["observations"], 6)
        self.assertEqual(manifest["requests"], 4)
        self.assertEqual(manifest["observations"], 6)
        self.assertEqual(
            result["requested_timestamps"],
            [0, 0.5, 0.667, 0.834, 3.834, 6.834],
        )
        for name in (
            "frame_00000.json",
            "frame_00000.5.json",
            "frame_00000.667.json",
            "frame_00000.834.json",
        ):
            self.assertTrue((obs_dir / name).is_file(), name)
        # Every persisted frame reported its own iteration in order.
        self.assertEqual(
            [entry["timestamp"] for entry in seen],
            [0, 0.5, 0.667, 0.834, 3.834, 6.834],
        )
        self.assertEqual(manifest["speed_counts"]["HIGH"], 3)

    def test_normal_and_low_never_batch(self):
        client = FakeBatchAdapter(single_speeds=("NORMAL", "NORMAL", "NORMAL"))
        result, manifest, _ = self.run_loop(client, max_frames=3)
        self.assertEqual(client.batch_calls, [])
        self.assertEqual(len(client.single_calls), 3)
        self.assertEqual(result["requests"], 3)
        self.assertEqual(result["observations"], 3)

        low = FakeBatchAdapter(single_speeds=("LOW",))
        low_result, _, _ = self.run_loop(low, max_frames=1)
        self.assertEqual(low.batch_calls, [])
        self.assertEqual(len(low.single_calls), 1)
        self.assertEqual(low_result["requests"], 1)

    def test_raw_client_falls_back_to_single_frame(self):
        client = FakeClient(echo_handler(("HIGH", "HIGH", "NORMAL")))
        result, manifest, _ = self.run_loop(client, max_frames=3)
        self.assertEqual(result["requests"], 3)
        self.assertEqual(result["observations"], 3)

    def test_batch_count_mismatch_terminates_with_partial_progress(self):
        client = FakeBatchAdapter(single_speeds=("HIGH",))

        def short_batch(timestamps, image_data_urls, previous=None):
            client.batch_calls.append(list(timestamps))
            return batch_text([(timestamps[0], "HIGH")])

        client.request_adaptive_batch_text = short_batch
        result, manifest, obs_dir = self.run_loop(client, max_frames=10)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["termination"], "response-invalid")
        self.assertIn("expected 3", result["error"]["message"])
        # The failed batch recorded one failed request; the first frame
        # survived.
        self.assertEqual(result["requests"], 2)
        self.assertEqual(result["failed_requests"], 1)
        self.assertEqual(result["requested_timestamps"], [0])
        self.assertTrue((obs_dir / "frame_00000.json").is_file())

    def test_batch_respects_max_frames_bound(self):
        client = FakeBatchAdapter(single_speeds=("HIGH",))
        result, _manifest, _ = self.run_loop(client, max_frames=2)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["termination"], "max-frames")
        # One single frame plus one three-frame batch: the bound counts
        # persisted observations, so paid requests stay under it too.
        self.assertEqual(result["observations"], 4)
        self.assertEqual(result["requests"], 2)

    def test_batch_stops_cleanly_at_video_end(self):
        client = FakeBatchAdapter(single_speeds=("HIGH",))
        result, _manifest, _ = self.run_loop(client, seconds=1)
        # 0 single, then a short batch (0.5, 0.667, 0.833 all fit), then
        # NORMAL scheduling reaches the 1s duration.
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["termination"], "video-end")
        self.assertEqual(len(client.batch_calls), 1)
        self.assertLessEqual(len(client.batch_calls[0]), 3)


class AnalyzeBatchTests(unittest.TestCase):
    def test_requires_batch_capable_client(self):
        import numpy as np

        frame = np.zeros((48, 64, 3), dtype=np.uint8)
        with self.assertRaises(TypeError):
            analyze_adaptive_batch(
                FakeClient(echo_handler()), [frame], [0], None
            )
