"""Offline tests for the manual HUD-read spike (fake adapter only).

The spike makes paid calls in real use; these tests never touch the
network: a fake adapter serves canned v3 JSON and the video is a tiny
synthetic file written with cv2.VideoWriter.
"""

import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "python" / "tools"))

import cv2  # noqa: E402
import numpy  # noqa: E402

import spike_hud_read  # noqa: E402


def canned_doc(timestamp):
    return {
        "schema_version": "observation-v3",
        "timestamp": timestamp,
        "scene": "gameplay",
        "round": {"timer": "01:23", "timer_red": False, "round_no": 2},
        "teams": [
            {"id": "A", "color": "blue", "score": 1, "alive": 4, "total": 4}
        ],
        "focus": {
            "name": "RAJ",
            "team": "A",
            "weapon": "M1887",
            "state": "alive",
            "hp_pct": 80,
        },
        "in_view": [],
        "cues": [
            {"cue": "muzzle_flash", "evidence": "yellow flash at weapon muzzle"}
        ],
        "notes": "RAJ holds the lane.",
        "confidence": "high",
    }


class FakeBroadcastAdapter:
    provider_id = "fake-test"

    def __init__(self, responder=None):
        self.calls = []
        self.responder = responder or (lambda ts, urls, prompt: canned_doc(ts))

    def request_broadcast_text(self, timestamp, image_data_urls, prompt):
        self.calls.append(
            {
                "timestamp": timestamp,
                "images": len(image_data_urls),
                "prompt": prompt,
            }
        )
        return json.dumps(self.responder(timestamp, image_data_urls, prompt))


def make_video(path, width=96, height=64, fps=5.0, frames=15):
    writer = cv2.VideoWriter(
        str(path), cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height)
    )
    try:
        for index in range(frames):
            frame = numpy.zeros((height, width, 3), dtype=numpy.uint8)
            frame[:, :] = (index * 16 % 256, 80, 160)
            writer.write(frame)
    finally:
        writer.release()
    return path


class SpikeHudReadTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.video = make_video(self.root / "tiny.mp4")
        probe = cv2.VideoCapture(str(self.video))
        frames = int(probe.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        probe.release()
        if frames <= 0:
            self.skipTest("synthetic video is unreadable in this build")

    def run_tool(self, adapter, times, repeat=2, labels=None, video=None):
        out = io.StringIO()
        code = spike_hud_read.run_spike(
            video=str(video or self.video),
            times=list(times),
            game_pack="free-fire",
            repeat=repeat,
            out_dir=str(self.root / "out"),
            labels=dict(labels or {}),
            adapter_factory=lambda: adapter,
            out_stream=out,
        )
        return code, out.getvalue()

    def test_table_and_agreement_output(self):
        adapter = FakeBroadcastAdapter()
        code, stdout = self.run_tool(adapter, [0.5, 1.5])
        self.assertEqual(code, 0)
        self.assertIn("== t=0.5s ==", stdout)
        self.assertIn("variant", stdout)
        self.assertIn("01:23", stdout)
        self.assertIn("A=1", stdout)
        self.assertIn("A=4", stdout)
        self.assertIn("RAJ/M1887/alive", stdout)
        self.assertIn("muzzle_flash", stdout)
        self.assertIn("agreement(full): AGREE (2/2 identical)", stdout)
        self.assertIn("agreement(full+strip): AGREE (2/2 identical)", stdout)
        self.assertIn("frames: 2 ok=2 failed=0 calls=8 parsed=8", stdout)
        self.assertNotIn("base64", stdout)
        self.assertLess(len(stdout), 20000)
        # Both variants were requested: 1-image and 2-image calls.
        self.assertEqual({call["images"] for call in adapter.calls}, {1, 2})
        self.assertEqual(len(adapter.calls), 8)
        self.assertIn("broadcast overlay", adapter.calls[0]["prompt"])
        self.assertIn("observation-v3", adapter.calls[0]["prompt"])
        # Raw plus parsed JSON saved per call.
        saved = list((self.root / "out").glob("*"))
        self.assertEqual(len(saved), 16)
        self.assertEqual(
            len(list((self.root / "out").glob("*_raw.txt"))), 8
        )
        self.assertEqual(
            len(list((self.root / "out").glob("*_parsed.json"))), 8
        )

    def test_labels_accuracy_reported(self):
        adapter = FakeBroadcastAdapter()
        labels = {
            0.5: {"timer": "01:23", "scores": {"A": 1}, "alive": {"A": 4}},
            1.5: {"timer": "09:99", "scores": {"A": 1}, "alive": {"A": 4}},
        }
        code, stdout = self.run_tool(adapter, [0.5, 1.5], labels=labels)
        self.assertEqual(code, 0)
        self.assertIn("labels(t=0.5): 3/3", stdout)
        self.assertIn("WRONG", stdout)
        self.assertIn("labels total: 5/6 fields across 2/2 times", stdout)

    def test_parse_failures_recorded_and_run_continues(self):
        def responder(timestamp, urls, prompt):
            if len(urls) == 2:
                return "not json at all"
            return canned_doc(timestamp)

        adapter = FakeBroadcastAdapter(responder=responder)
        code, stdout = self.run_tool(adapter, [0.5], repeat=2)
        self.assertEqual(code, 0)
        self.assertIn("agreement(full): AGREE (2/2 identical)", stdout)
        self.assertIn("agreement(full+strip): INCOMPLETE (0/2 parsed)", stdout)
        self.assertIn("ERR", stdout)
        self.assertIn("frames: 1 ok=1 failed=0 calls=4 parsed=2", stdout)
        self.assertEqual(
            len(list((self.root / "out").glob("*_parse_error.txt"))), 2
        )

    def test_unsupported_adapter_fails_without_calls(self):
        class Plain:
            provider_id = "plain-test"

        code, _ = self.run_tool(Plain(), [0.5])
        self.assertEqual(code, 1)

    def test_missing_video_fails(self):
        adapter = FakeBroadcastAdapter()
        code, _ = self.run_tool(
            adapter, [0.5], video=self.root / "absent.mp4"
        )
        self.assertEqual(code, 1)
        self.assertEqual(adapter.calls, [])

    def test_out_of_range_time_fails_per_frame(self):
        adapter = FakeBroadcastAdapter()
        code, stdout = self.run_tool(adapter, [0.5, 99.0])
        self.assertEqual(code, 0)
        self.assertIn("== t=99s == FAILED", stdout)
        self.assertIn("frames: 2 ok=1 failed=1", stdout)

    def test_help_exits_zero(self):
        with self.assertRaises(SystemExit) as raised:
            spike_hud_read.main(["--help"])
        self.assertEqual(raised.exception.code, 0)


if __name__ == "__main__":
    unittest.main()
