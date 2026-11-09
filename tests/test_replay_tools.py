"""Offline tests for the replay and eval tools (no network, no keys).

Runs python/tools/replay_legacy.py on the golden Clash Squad fixture
and python/tools/eval_script.py on a tiny hand-written script, both as
``python -I`` subprocesses with API keys scrubbed from the environment.
"""

import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
import wave
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
TOOLS_DIR = REPO_ROOT / "python" / "tools"
FIXTURE_DIR = REPO_ROOT / "tests" / "fixtures" / "real_clash_squad_run1"


def scrubbed_env():
    env = dict(os.environ)
    for key in (
        "BASETEN_API_KEY",
        "AI_COMMENTATOR_API_KEY",
        "AI_COMMENTATOR_SETTINGS_JSON",
        "GEMINI_API_KEY",
    ):
        env.pop(key, None)
    return env


def run_tool(*args):
    return subprocess.run(
        [sys.executable, "-I", *[str(arg) for arg in args]],
        cwd=REPO_ROOT,
        env=scrubbed_env(),
        capture_output=True,
        text=True,
        timeout=300,
    )


def report_json(stdout):
    marker = "--- JSON ---\n"
    assert marker in stdout, "eval output has no JSON marker"
    return json.loads(stdout.split(marker, 1)[1])


class ReplayLegacyTests(unittest.TestCase):
    def test_replay_runs_offline_with_expected_stats(self):
        with tempfile.TemporaryDirectory() as tmp:
            out_dir = Path(tmp) / "out"
            proc = run_tool(
                TOOLS_DIR / "replay_legacy.py", FIXTURE_DIR, "--out", out_dir
            )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("observations: 30 validated, 0 failed", proc.stdout)
        self.assertIn("entries: 122", proc.stdout)
        for part in ("environment=30", "other=16", "combat=43", "character=33"):
            self.assertIn(part, proc.stdout)
        self.assertIn("entries_with_subjects: 0", proc.stdout)
        self.assertIn("entries_with_action: 0", proc.stdout)
        self.assertIn("entries_with_spatial: 0", proc.stdout)
        self.assertIn("negation_entries: 29", proc.stdout)
        self.assertIn("combat=28", proc.stdout)
        self.assertIn("other=1", proc.stdout)
        match = re.search(r"^windows: (\d+)$", proc.stdout, re.MULTILINE)
        self.assertIsNotNone(match, "replay printed no window count")
        self.assertGreaterEqual(int(match.group(1)), 1)

    def test_replay_writes_one_prompt_per_window(self):
        with tempfile.TemporaryDirectory() as tmp:
            out_dir = Path(tmp) / "out"
            proc = run_tool(
                TOOLS_DIR / "replay_legacy.py", FIXTURE_DIR, "--out", out_dir
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            match = re.search(r"^windows: (\d+)$", proc.stdout, re.MULTILINE)
            windows = int(match.group(1))
            prompts = sorted(out_dir.glob("prompt_window_*.txt"))
            self.assertEqual(len(prompts), windows)
            self.assertTrue(
                all(path.stat().st_size > 0 for path in prompts),
                "every window prompt must be non-empty",
            )

    def test_replay_rejects_missing_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            proc = run_tool(
                TOOLS_DIR / "replay_legacy.py",
                Path(tmp) / "does-not-exist",
                "--out",
                Path(tmp) / "out",
            )
        self.assertNotEqual(proc.returncode, 0)


class EvalScriptTests(unittest.TestCase):
    SCRIPT = {
        "segments": [
            {
                "segment_id": "segment-001",
                "timestamp_seconds": 0,
                "text": "Three players push while 2 defenders hold here now",
            },
            {
                "segment_id": "segment-002",
                "timestamp_seconds": 1.0,
                "text": "Possible rotation unconfirmed near crates",
            },
            {
                "segment_id": "segment-003",
                "timestamp_seconds": 10,
                "text": "Quiet moment across the open ground",
            },
        ]
    }

    def write_script(self, directory):
        path = Path(directory) / "script.json"
        path.write_text(json.dumps(self.SCRIPT), encoding="utf-8")
        return path

    def test_eval_returns_expected_metrics(self):
        with tempfile.TemporaryDirectory() as tmp:
            script_path = self.write_script(tmp)
            proc = run_tool(TOOLS_DIR / "eval_script.py", script_path)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        report = report_json(proc.stdout)
        self.assertEqual(report["lines"], 3)
        # Durations are word-count estimates (words/2.5): 9w -> 3.6s,
        # 5w -> 2.0s, 6w -> 2.4s; line 2 overlaps line 1 only.
        self.assertEqual(report["overlap_count"], 1)
        self.assertEqual(report["forbidden_meta_word_hits"], 1)
        self.assertEqual(sorted(report["number_tokens_present"]), ["2", "three"])
        by_id = {row["segment_id"]: row for row in report["segments"]}
        self.assertAlmostEqual(by_id["segment-001"]["duration_seconds"], 3.6)
        self.assertEqual(by_id["segment-001"]["duration_source"], "estimate")
        self.assertAlmostEqual(by_id["segment-001"]["words_per_second"], 2.5)
        self.assertAlmostEqual(by_id["segment-002"]["words_per_second"], 2.5)
        self.assertEqual(by_id["segment-002"]["forbidden_hits"], 1)
        self.assertAlmostEqual(report["span_seconds"], 12.4)
        self.assertAlmostEqual(report["lines_per_minute"], 3 * 60.0 / 12.4)
        self.assertIsNone(report["timeline"])

    def test_eval_uses_wav_durations_and_timeline(self):
        with tempfile.TemporaryDirectory() as tmp:
            script_path = self.write_script(tmp)
            wav_dir = Path(tmp) / "wavs"
            wav_dir.mkdir()
            with wave.open(str(wav_dir / "segment-001.wav"), "wb") as handle:
                handle.setnchannels(1)
                handle.setsampwidth(2)
                handle.setframerate(8000)
                handle.writeframes(bytes(8000 * 2))  # exactly 1.0s
            timeline_path = Path(tmp) / "events.json"
            timeline_path.write_text(
                json.dumps({"events": [{"id": "evt-1"}, {"id": "evt-2"}]}),
                encoding="utf-8",
            )
            proc = run_tool(
                TOOLS_DIR / "eval_script.py",
                script_path,
                "--timeline",
                timeline_path,
                "--wav-dir",
                wav_dir,
            )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        report = report_json(proc.stdout)
        by_id = {row["segment_id"]: row for row in report["segments"]}
        first = by_id["segment-001"]
        self.assertEqual(first["duration_source"], "wav")
        self.assertAlmostEqual(first["duration_seconds"], 1.0)
        self.assertAlmostEqual(first["words_per_second"], 9.0)
        self.assertEqual(by_id["segment-002"]["duration_source"], "estimate")
        # Line 1 now ends exactly where line 2 starts: no overlap.
        self.assertEqual(report["overlap_count"], 0)
        self.assertEqual(report["timeline"]["events"], 2)

    def test_eval_rejects_malformed_script(self):
        with tempfile.TemporaryDirectory() as tmp:
            bad_path = Path(tmp) / "bad.json"
            bad_path.write_text(json.dumps({"segments": [{"text": "x"}]}),
                                encoding="utf-8")
            proc = run_tool(TOOLS_DIR / "eval_script.py", bad_path)
        self.assertNotEqual(proc.returncode, 0)


if __name__ == "__main__":
    unittest.main()
