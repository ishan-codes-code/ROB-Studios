"""Offline tests for the streaming pipeline (Vision → Script → TTS).

No live API calls: fake text and TTS clients stand in for the paid
endpoints, and fixture observations reuse the production builders.
"""

import io
import json
import os
import re
import sys
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import main as engine
import worker
from test_commentary import obs_doc, obs_item

ENV_A = "Arid desert mesas under bright light."
ENV_B = "Green containers near a rocky ledge."
FAKE_WAV = b"RIFF\x24\x00\x00\x00WAVEfmt payload-bytes-here"
SAFE_WORDING = "Possible movement in the view, unconfirmed."


class FakeTextClient:
    """Text-only fake: words every prompted claim with safe wording."""

    def __init__(self, fail_calls=()):
        self.calls = []
        self.fail_calls = set(fail_calls)

    def request_text(self, prompt):
        index = len(self.calls)
        self.calls.append(prompt)
        if index in self.fail_calls:
            raise engine.WriterAPIError("Fake script failure.")
        ids = re.findall(r"Claim (\S+)", prompt)
        return json.dumps(
            {"segments": [{"source_claim_ids": [i], "text": SAFE_WORDING} for i in ids]}
        )

    def close(self):
        pass


class FakeTtsClient:
    def __init__(self, fail_texts=(), gate=None, payload=FAKE_WAV):
        self.calls = []
        self.fail_texts = set(fail_texts)
        self.gate = gate
        self.payload = payload

    def synthesize(self, text, voice=None, style=None):
        self.calls.append(text)
        if self.gate is not None:
            self.gate.wait(timeout=30)
        if text in self.fail_texts:
            raise RuntimeError("Fake TTS failure.")
        return self.payload

    def close(self):
        pass


def validated_obs(timestamp, items):
    doc = obs_doc(timestamp, items)
    return engine.validate_observation(doc)


def scene_obs(timestamp, description):
    return (
        timestamp,
        f"frame_{timestamp:05d}.json",
        validated_obs(timestamp, [obs_item("environment", description)]),
    )


def echo_obs(timestamp):
    return (
        timestamp,
        f"frame_{timestamp:05d}.json",
        validated_obs(
            timestamp,
            [
                obs_item("environment", ENV_A),
                obs_item(
                    "hud",
                    "Kill feed shows a fresh entry.",
                    "high",
                    "RRQ.JEEK eliminated OG.IQOOPAWDI in the kill feed",
                ),
            ],
        ),
    )


def drain_pipeline(pipeline, submissions, tts=True):
    """Submit observations through a started pipeline; return events+result."""
    script_events = []
    tts_events = []
    lock = threading.Lock()

    def on_script(record):
        with lock:
            script_events.append(record)

    def on_tts(record):
        with lock:
            tts_events.append(record)

    pipeline._on_script_segment = on_script
    pipeline._on_tts_segment = on_tts
    pipeline.start()
    for timestamp, source, validated, speed in submissions:
        pipeline.submit_observation(timestamp, source, validated, speed)
    pipeline.finish_vision()
    result = pipeline.wait()
    return script_events, tts_events, result


class QueueTests(unittest.TestCase):
    def test_observation_queue_blocks_until_drained(self):
        q = engine.ObservationQueue(maxsize=1)
        q.put_observation("first")
        done = threading.Event()

        def producer():
            q.put_observation("second")
            done.set()

        thread = threading.Thread(target=producer)
        thread.start()
        self.assertFalse(done.wait(timeout=0.3))
        self.assertEqual(q.get(), "first")
        self.assertTrue(done.wait(timeout=5))
        thread.join(timeout=5)
        self.assertEqual(q.get(), "second")

    def test_observation_queue_close_ends_stream(self):
        q = engine.ObservationQueue(maxsize=4)
        q.put_observation("x")
        q.close()
        self.assertEqual(q.get(), "x")
        self.assertIsNone(q.get())

    def test_priority_queue_orders_and_supersedes(self):
        q = engine.PrioritySegmentQueue(maxsize=8)
        q.put(engine.PRIORITY_LOW, {"utterance_id": "u-0001"})
        q.put(engine.PRIORITY_NORMAL, {"utterance_id": "u-0002"})
        dropped = q.supersede(engine.PRIORITY_HIGH)
        self.assertEqual(
            {d["utterance_id"] for d in dropped}, {"u-0001", "u-0002"}
        )
        self.assertEqual(len(q), 0)
        q.put(engine.PRIORITY_LOW, {"utterance_id": "u-0003"})
        q.put(engine.PRIORITY_HIGH, {"utterance_id": "u-0004"})
        # Urgent first regardless of arrival order.
        self.assertEqual(q.get()["utterance_id"], "u-0004")
        self.assertEqual(q.get()["utterance_id"], "u-0003")
        q.close()
        self.assertIsNone(q.get())

    def test_priority_queue_applies_backpressure(self):
        q = engine.PrioritySegmentQueue(maxsize=1)
        q.put(engine.PRIORITY_LOW, {"utterance_id": "u-0001"})
        done = threading.Event()

        def producer():
            q.put(engine.PRIORITY_LOW, {"utterance_id": "u-0002"})
            done.set()

        thread = threading.Thread(target=producer)
        thread.start()
        self.assertFalse(done.wait(timeout=0.3))
        self.assertEqual(q.get()["utterance_id"], "u-0001")
        self.assertTrue(done.wait(timeout=5))
        thread.join(timeout=5)

    def test_utterance_priority_ranks_echoes_first(self):
        echo = [{"type": "event_echo"}]
        dev = [{"type": "development"}]
        scene = [{"type": "scene"}]
        self.assertLess(engine.utterance_priority(echo), engine.utterance_priority(dev))
        self.assertLess(engine.utterance_priority(dev), engine.utterance_priority(scene))
        self.assertEqual(
            engine.utterance_priority(echo + dev), engine.PRIORITY_HIGH
        )


class WindowTests(unittest.TestCase):
    def test_window_words_fresh_claims_once(self):
        observations = [
            scene_obs(0, ENV_A),
            scene_obs(3, ENV_B),
            scene_obs(6, ENV_A),
        ]
        seen: set = set()
        client = FakeTextClient()
        utterances, omitted, fresh, error = engine.run_script_window(
            observations, [], seen, client
        )
        self.assertIsNone(error)
        self.assertGreater(len(utterances), 0)
        self.assertEqual(len(fresh), len(seen))
        for utterance in utterances:
            self.assertIn("timestamp", utterance)
            self.assertTrue(utterance["text"].strip())
            self.assertTrue(utterance["source_claim_ids"])
        # A second window over the same prefix words nothing new.
        again, omitted2, _fresh2, error2 = engine.run_script_window(
            observations, [], seen, client
        )
        self.assertIsNone(error2)
        self.assertEqual(again, [])
        self.assertTrue(
            any(entry["rule"] == "already-emitted" for entry in omitted2)
        )

    def test_window_failure_is_reported_not_raised(self):
        observations = [scene_obs(0, ENV_A)]
        utterances, omitted, _fresh, error = engine.run_script_window(
            observations, [], set(), FakeTextClient(fail_calls={0})
        )
        self.assertEqual(utterances, [])
        self.assertIsNotNone(error)
        self.assertTrue(
            any(entry["rule"] == "model-output" for entry in omitted)
        )


class OrchestratorTests(unittest.TestCase):
    def make_pipeline(self, root, script_client, tts_client=None, **kwargs):
        root = Path(root)
        tts_config = None
        if tts_client is not None or kwargs.pop("want_tts", False):
            tts_config = ("gemini-3.8-flash-tts", "Kore", "Energetic delivery.")
        params = dict(
            script_path=root / "script" / "script.json",
            commentary_path=root / "commentary.json",
            audio_dir=root / "audio",
            tts_config=tts_config,
            script_client=script_client,
            tts_client=tts_client,
        )
        params.update(kwargs)
        return engine.StreamingPipeline(**params)

    def test_end_to_end_script_and_tts_with_final_layout(self):
        with tempfile.TemporaryDirectory() as tmp:
            script_client = FakeTextClient()
            tts_client = FakeTtsClient()
            pipeline = self.make_pipeline(
                tmp, script_client, tts_client, window_min_observations=2
            )
            submissions = [
                (*scene_obs(0, ENV_A), "NORMAL"),
                (*scene_obs(3, ENV_B), "NORMAL"),
                (*scene_obs(6, ENV_A), "NORMAL"),
            ]
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                script_events, tts_events, result = drain_pipeline(
                    pipeline, submissions
                )
            self.assertEqual(result["script_status"], "success")
            self.assertEqual(result["tts_status"], "success")
            self.assertGreater(result["segments"], 0)
            self.assertTrue(script_client.calls)
            # Incremental callbacks fired for every utterance.
            worded = [e for e in script_events if e["status"] == "worded"]
            self.assertEqual(len(worded), result["utterances"])
            by_utterance = {}
            for event in tts_events:
                by_utterance.setdefault(event["utterance_id"], []).append(
                    event["status"]
                )
            self.assertEqual(len(by_utterance), result["utterances"])
            for uid, statuses in by_utterance.items():
                self.assertEqual(statuses, ["started", "success"], uid)
            # Final script.json validates with provenance.
            script_doc = json.loads(
                Path(result["script_path"]).read_text(encoding="utf-8")
            )
            self.assertEqual(script_doc["status"], "success")
            engine.validate_script(script_doc, pipeline._claims_by_id)
            ids = [s["segment_id"] for s in script_doc["segments"]]
            self.assertEqual(ids, [f"segment-{i + 1:03d}" for i in range(len(ids))])
            # Final layout matches the sequential runner: segment-named
            # WAVs plus a validated manifest.
            tts_doc = json.loads(
                Path(result["tts_path"]).read_text(encoding="utf-8")
            )
            engine.validate_tts_manifest(tts_doc)
            self.assertEqual(tts_doc["status"], "success")
            for entry in tts_doc["entries"]:
                wav = Path(tmp) / "audio" / entry["audio_file"]
                self.assertTrue(wav.is_file(), entry["audio_file"])
                self.assertTrue(wav.name.startswith("segment-"))
            leftovers = list((Path(tmp) / "audio" / "segments").glob("u-*.wav"))
            self.assertEqual(leftovers, [])

    def test_tts_reports_started_before_terminal_status(self):
        with tempfile.TemporaryDirectory() as tmp:
            script_client = FakeTextClient()
            tts_client = FakeTtsClient()
            pipeline = self.make_pipeline(
                tmp, script_client, tts_client, window_min_observations=2
            )
            submissions = [
                (*scene_obs(0, ENV_A), "NORMAL"),
                (*scene_obs(3, ENV_B), "NORMAL"),
                (*scene_obs(6, ENV_A), "NORMAL"),
            ]
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                script_events, tts_events, result = drain_pipeline(
                    pipeline, submissions
                )
            # Every synthesized utterance reports `started` first, then
            # exactly one terminal outcome — the UI joins on this order
            # to show Generating vs Ready/Failed per segment.
            self.assertGreater(result["utterances"], 0)
            by_utterance = {}
            for event in tts_events:
                by_utterance.setdefault(event["utterance_id"], []).append(
                    event["status"]
                )
            self.assertEqual(len(by_utterance), result["utterances"])
            for uid, statuses in by_utterance.items():
                self.assertEqual(
                    statuses,
                    ["started", "success"],
                    f"unexpected TTS event order for {uid}",
                )

    def test_high_priority_supersedes_queued_commentary(self):
        gate = threading.Event()
        with tempfile.TemporaryDirectory() as tmp:
            script_client = FakeTextClient()
            tts_client = FakeTtsClient(gate=gate)
            pipeline = self.make_pipeline(
                tmp,
                script_client,
                tts_client,
                window_min_observations=2,
                seg_queue_size=8,
            )
            script_events = []
            tts_events = []
            lock = threading.Lock()

            def on_script(record):
                with lock:
                    script_events.append(record)

            def on_tts(record):
                with lock:
                    tts_events.append(record)

            pipeline._on_script_segment = on_script
            pipeline._on_tts_segment = on_tts
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                pipeline.start()
                # Ordinary scenes first. TTS takes one utterance and
                # blocks on the gate; the rest stay queued.
                pipeline.submit_observation(*scene_obs(0, ENV_A), "NORMAL")
                pipeline.submit_observation(*scene_obs(3, ENV_B), "NORMAL")
                pipeline.submit_observation(*scene_obs(6, ENV_A), "NORMAL")
                pipeline.submit_observation(*scene_obs(9, ENV_B), "NORMAL")
                deadline = time.time() + 10
                while not tts_client.calls and time.time() < deadline:
                    time.sleep(0.01)
                self.assertTrue(tts_client.calls, "TTS never took an utterance")
                deadline = time.time() + 10
                while len(script_events) < 2 and time.time() < deadline:
                    time.sleep(0.01)
                self.assertGreaterEqual(
                    len(script_events), 2, "expected queued utterances"
                )
                # An echo event at high speed: the important development
                # must pre-empt the lower-priority utterances still
                # waiting, never the one already synthesizing.
                pipeline.submit_observation(*echo_obs(12), "HIGH")
                pipeline.finish_vision()
                deadline = time.time() + 10
                while pipeline._script_thread.is_alive() and time.time() < deadline:
                    time.sleep(0.01)
                gate.set()
                result = pipeline.wait()
            superseded = {
                e["utterance_id"]
                for e in script_events
                if e["status"] == "superseded"
            }
            self.assertGreater(len(superseded), 0)
            spoken = {
                e["utterance_id"]
                for e in tts_events
                if e["status"] == "success"
            }
            self.assertTrue(spoken)
            self.assertTrue(superseded.isdisjoint(spoken))
            self.assertEqual(result["superseded"], len(superseded))
            script_doc = json.loads(
                Path(result["script_path"]).read_text(encoding="utf-8")
            )
            self.assertTrue(
                any(entry["rule"] == "superseded" for entry in script_doc["omitted"])
            )
            # The important event itself is never lost: its echo claim
            # is worded in the final script.
            accepted = [
                scene_obs(0, ENV_A),
                scene_obs(3, ENV_B),
                scene_obs(6, ENV_A),
                scene_obs(9, ENV_B),
                echo_obs(12),
            ]
            state = engine.build_match_state(accepted)
            events, _counts = engine.detect_events(accepted, state)
            claims, _suppressed = engine.gate_commentary_claims(accepted, state, events)
            echo_ids = {
                engine.claim_id_of(claim)
                for claim in claims
                if claim["type"] == "event_echo"
            }
            self.assertTrue(echo_ids, "fixture produced no echo claim")
            cited = {
                claim_id
                for segment in script_doc["segments"]
                for claim_id in segment["source_claim_ids"]
            }
            self.assertTrue(echo_ids & cited, "echo claim missing from script")

    def test_tts_failure_isolated_per_utterance(self):
        with tempfile.TemporaryDirectory() as tmp:
            script_client = FakeTextClient()
            tts_client = FakeTtsClient(fail_texts={SAFE_WORDING})
            pipeline = self.make_pipeline(
                tmp, script_client, tts_client, window_min_observations=2
            )
            submissions = [
                (*scene_obs(0, ENV_A), "NORMAL"),
                (*scene_obs(3, ENV_B), "NORMAL"),
            ]
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                _script_events, tts_events, result = drain_pipeline(
                    pipeline, submissions
                )
            self.assertEqual(result["script_status"], "success")
            self.assertEqual(result["tts_status"], "error")
            self.assertFalse(result["tts_ok"])
            self.assertTrue(tts_events)
            by_utterance = {}
            for event in tts_events:
                by_utterance.setdefault(event["utterance_id"], []).append(
                    event["status"]
                )
            for uid, statuses in by_utterance.items():
                self.assertEqual(statuses, ["started", "error"], uid)
            tts_doc = json.loads(
                Path(result["tts_path"]).read_text(encoding="utf-8")
            )
            self.assertEqual(tts_doc["status"], "error")

    def test_invalid_audio_bytes_fail_the_utterance(self):
        with tempfile.TemporaryDirectory() as tmp:
            script_client = FakeTextClient()
            tts_client = FakeTtsClient(payload=b"not-a-wav")
            pipeline = self.make_pipeline(
                tmp, script_client, tts_client, window_min_observations=2
            )
            submissions = [
                (*scene_obs(0, ENV_A), "NORMAL"),
                (*scene_obs(3, ENV_B), "NORMAL"),
            ]
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                _script_events, tts_events, result = drain_pipeline(
                    pipeline, submissions
                )
            self.assertEqual(result["tts_status"], "error")
            by_utterance = {}
            for event in tts_events:
                by_utterance.setdefault(event["utterance_id"], []).append(event)
            self.assertTrue(by_utterance)
            for uid, events in by_utterance.items():
                self.assertEqual(
                    [e["status"] for e in events], ["started", "error"], uid
                )
                self.assertIn("invalid audio", events[-1]["error"])
            self.assertFalse(list((Path(tmp) / "audio" / "segments").glob("*.wav")))

    def test_wav_validation(self):
        self.assertTrue(engine.wav_bytes_valid(FAKE_WAV))
        self.assertTrue(engine.wav_bytes_valid(bytearray(FAKE_WAV)))
        self.assertFalse(engine.wav_bytes_valid(b"short"))
        self.assertFalse(engine.wav_bytes_valid(b"NOPE____WAVE_nope"))
        self.assertFalse(engine.wav_bytes_valid("RIFF____WAVE__"))
        self.assertFalse(engine.wav_bytes_valid(None))

    def test_silence_when_nothing_is_claimable(self):
        with tempfile.TemporaryDirectory() as tmp:
            low = (
                0,
                "frame_00000.json",
                validated_obs(0, [obs_item("hud", "Blurry counter digits.", "low")]),
            )
            script_client = FakeTextClient()
            pipeline = self.make_pipeline(
                tmp, script_client, window_min_observations=1
            )
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                _s, _t, result = drain_pipeline(pipeline, [(*low, "NORMAL")])
            self.assertEqual(result["script_status"], "silence")
            self.assertEqual(script_client.calls, [])

    def test_script_errors_do_not_stop_later_windows(self):
        with tempfile.TemporaryDirectory() as tmp:
            script_client = FakeTextClient(fail_calls={0})
            pipeline = self.make_pipeline(
                tmp, script_client, window_min_observations=2
            )
            submissions = [
                (*scene_obs(0, ENV_A), "NORMAL"),
                (*scene_obs(3, ENV_B), "NORMAL"),
                (*scene_obs(6, ENV_A), "NORMAL"),
                (*scene_obs(9, ENV_B), "NORMAL"),
            ]
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                _s, _t, result = drain_pipeline(pipeline, submissions)
            # First window failed, later windows still worded segments.
            self.assertEqual(result["script_status"], "success")
            self.assertGreater(result["segments"], 0)
            self.assertTrue(result["window_errors"])


class FakeClientCM:
    def __init__(self, client):
        self._client = client

    def __enter__(self):
        return self._client

    def __exit__(self, *exc_info):
        return False


class WorkerStreamingTests(unittest.TestCase):
    def run_pipeline_quiet(self, args):
        buffer = io.StringIO()
        real = worker.REAL_STDOUT
        worker.REAL_STDOUT = buffer
        try:
            with redirect_stderr(io.StringIO()):
                code, data = worker.run_pipeline(args)
        finally:
            worker.REAL_STDOUT = real
        messages = [json.loads(line) for line in buffer.getvalue().splitlines()]
        return code, data, messages

    def streaming_args(self, video, out, **overrides):
        kwargs = {
            "video": video,
            "output_dir": out,
            "with_script": False,
            "generate_tts": False,
            "adaptive": True,
            "adaptive_max_frames": 4,
            "streaming": True,
            "game_pack": None,
            "tts_model": None,
            "tts_voice": None,
            "tts_voice_direction": None,
        }
        kwargs.update(overrides)
        return SimpleNamespace(**kwargs)

    def fake_vision(self, specs, terminal="completed", wait_for=()):
        """Build a vision mock: persist fixtures, fire hooks, then return.

        ``specs`` is [(timestamp, doc, speed)]. When ``wait_for`` holds
        threading events, the mock blocks for them after the third hook
        — proving downstream stages ran while vision was still producing.
        """

        def run(video_path=None, observations_dir=None, on_iteration=None, **kwargs):
            obs_dir = Path(observations_dir)
            obs_dir.mkdir(parents=True, exist_ok=True)
            for index, (timestamp, doc, speed) in enumerate(specs):
                path = engine.observation_path_for_timestamp(timestamp, obs_dir)
                path.write_text(json.dumps(doc), encoding="utf-8")
                on_iteration(
                    {
                        "timestamp": timestamp,
                        "speed": speed,
                        "reason": "Fixture iteration.",
                        "next_timestamp": None,
                        "observations": index + 1,
                        "requests": index + 1,
                    }
                )
                if index == 2:
                    for event in wait_for:
                        event.wait(timeout=30)
            return {
                "status": terminal,
                "termination": (
                    "video-end" if terminal == "completed" else terminal
                ),
                "video": str(video_path),
                "observations_dir": str(obs_dir),
                "duration": 12.0,
                "requested_timestamps": [s[0] for s in specs],
                "observations": len(specs),
                "requests": len(specs),
                "failed_requests": 0,
                "speed_counts": {"HIGH": 0, "NORMAL": len(specs), "LOW": 0},
                "manifest": str(obs_dir / "adaptive_run.json"),
                "error": None if terminal != "failed" else {
                    "phase": "request-failed",
                    "message": "Fixture failure.",
                },
            }

        return run

    def test_plan_and_mode_cover_streaming(self):
        args = worker.build_parser().parse_args(
            ["clip.mp4", "--adaptive", "--streaming"]
        )
        plan = worker.plan_stages(args)
        self.assertIn(("script", "run"), plan)
        self.assertEqual(worker.run_mode(plan, args), "streaming")
        tts_args = worker.build_parser().parse_args(
            ["clip.mp4", "--adaptive", "--streaming", "--generate-tts"]
        )
        tts_plan = worker.plan_stages(tts_args)
        self.assertIn(("tts", "run"), tts_plan)
        # Sequential mode still requires --with-script for TTS.
        offline = worker.build_parser().parse_args(
            ["clip.mp4", "--adaptive", "--generate-tts"]
        )
        with self.assertRaises(ValueError):
            worker.plan_stages(offline)

    def test_concurrent_progress_and_artifacts(self):
        script_called = threading.Event()
        tts_called = threading.Event()

        class SignallingTextClient(FakeTextClient):
            def request_text(self, prompt):
                try:
                    return super().request_text(prompt)
                finally:
                    script_called.set()

        class SignallingTtsClient(FakeTtsClient):
            def synthesize(self, text, voice=None, style=None):
                try:
                    return super().synthesize(text, voice=voice, style=style)
                finally:
                    tts_called.set()

        specs = [
            (0, obs_doc(0, [obs_item("environment", ENV_A)]), "NORMAL"),
            (3, obs_doc(3, [obs_item("environment", ENV_B)]), "NORMAL"),
            (6, obs_doc(6, [obs_item("environment", ENV_A)]), "NORMAL"),
            (9, obs_doc(9, [obs_item("environment", ENV_B)]), "NORMAL"),
        ]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            video = root / "clip.mp4"
            video.write_bytes(b"fake-video")
            out = root / "out"
            text_client = SignallingTextClient()
            tts_client = SignallingTtsClient()
            env = {"AI_COMMENTATOR_PROVIDER_API_KEY": "test-tts-key"}
            with (
                mock.patch.object(
                    worker.engine,
                    "run_adaptive_vision",
                    side_effect=self.fake_vision(
                        specs, wait_for=(script_called, tts_called)
                    ),
                ),
                mock.patch.object(
                    worker.engine,
                    "open_live_text_client",
                    return_value=(FakeClientCM(text_client), "fake-key"),
                ),
                mock.patch.object(
                    worker.engine, "GeminiTTSClient", return_value=tts_client
                ),
                mock.patch.dict(os.environ, env),
            ):
                code, data, messages = self.run_pipeline_quiet(
                    self.streaming_args(str(video), str(out), generate_tts=True)
                )
            # The vision mock only finished after both downstream stages
            # made progress: overlap is proven, not assumed.
            self.assertTrue(script_called.is_set())
            self.assertTrue(tts_called.is_set())
            self.assertEqual(code, 0)
            self.assertEqual(data["mode"], "streaming")
            kinds = [message["type"] for message in messages]
            self.assertIn("script_segment", kinds)
            self.assertIn("tts_segment", kinds)
            # The NDJSON stream reports synthesis start before the
            # terminal outcome per utterance.
            by_utterance = {}
            for message in messages:
                if message["type"] != "tts_segment":
                    continue
                payload = message["data"]
                by_utterance.setdefault(payload["utterance_id"], []).append(
                    payload["status"]
                )
            self.assertTrue(by_utterance)
            for uid, statuses in by_utterance.items():
                self.assertEqual(statuses[0], "started", uid)
                self.assertEqual(len(statuses), 2, uid)
                self.assertIn(statuses[1], ("success", "error"), uid)
            # run_pipeline leaves the terminal `result` to main().
            self.assertNotIn("error", kinds)
            totals = {
                message["total"]
                for message in messages
                if message["type"] in ("progress", "stage_completed")
            }
            self.assertEqual(totals, {6})
            self.assertEqual(data["script"], "success")
            self.assertEqual(data["tts"], "success")
            script_doc = json.loads(
                Path(data["artifacts"]["script"]).read_text(encoding="utf-8")
            )
            self.assertEqual(script_doc["status"], "success")
            self.assertGreater(len(script_doc["segments"]), 0)
            tts_doc = json.loads(
                Path(data["artifacts"]["tts"]).read_text(encoding="utf-8")
            )
            self.assertEqual(tts_doc["status"], "success")
            for entry in tts_doc["entries"]:
                self.assertTrue(
                    (out / "audio" / entry["audio_file"]).is_file()
                )
            # Timestamps and source references survive across stages.
            segment = script_doc["segments"][0]
            tts_entry = next(
                e for e in tts_doc["entries"]
                if e["segment_id"] == segment["segment_id"]
            )
            self.assertEqual(
                tts_entry["timestamp_seconds"], segment["timestamp_seconds"]
            )
            self.assertEqual(tts_entry["text"], segment["text"])
            self.assertEqual(
                tts_entry["source_claim_ids"], segment["source_claim_ids"]
            )

    def test_streaming_without_tts_skips_audio(self):
        specs = [
            (0, obs_doc(0, [obs_item("environment", ENV_A)]), "NORMAL"),
            (3, obs_doc(3, [obs_item("environment", ENV_B)]), "NORMAL"),
            (6, obs_doc(6, [obs_item("environment", ENV_A)]), "NORMAL"),
        ]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            video = root / "clip.mp4"
            video.write_bytes(b"fake-video")
            out = root / "out"
            with (
                mock.patch.object(
                    worker.engine,
                    "run_adaptive_vision",
                    side_effect=self.fake_vision(specs),
                ),
                mock.patch.object(
                    worker.engine,
                    "open_live_text_client",
                    return_value=(FakeClientCM(FakeTextClient()), "fake-key"),
                ),
            ):
                code, data, messages = self.run_pipeline_quiet(
                    self.streaming_args(str(video), str(out))
                )
            self.assertEqual(code, 0)
            self.assertEqual(data["tts"], "skipped")
            self.assertIsNone(data["artifacts"]["tts"])
            kinds = [message["type"] for message in messages]
            self.assertIn("script_segment", kinds)
            self.assertNotIn("tts_segment", kinds)

    def test_streaming_stop_finalizes_partials(self):
        specs = [
            (0, obs_doc(0, [obs_item("environment", ENV_A)]), "NORMAL"),
            (3, obs_doc(3, [obs_item("environment", ENV_B)]), "NORMAL"),
            (6, obs_doc(6, [obs_item("environment", ENV_A)]), "NORMAL"),
        ]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            video = root / "clip.mp4"
            video.write_bytes(b"fake-video")
            out = root / "out"
            with (
                mock.patch.object(
                    worker.engine,
                    "run_adaptive_vision",
                    side_effect=self.fake_vision(specs, terminal="stopped"),
                ),
                mock.patch.object(
                    worker.engine,
                    "open_live_text_client",
                    return_value=(FakeClientCM(FakeTextClient()), "fake-key"),
                ),
            ):
                code, data, messages = self.run_pipeline_quiet(
                    self.streaming_args(str(video), str(out))
                )
            self.assertEqual(code, 0)
            kinds = [message["type"] for message in messages]
            self.assertIn("stopped", kinds)
            self.assertNotIn("result", kinds)
            stopped = next(m for m in messages if m["type"] == "stopped")
            self.assertEqual(stopped["data"]["mode"], "streaming")
            self.assertEqual(stopped["data"]["script"], "success")
            self.assertTrue(Path(stopped["data"]["artifacts"]["script"]).is_file())

    def test_streaming_vision_failure_reports_error(self):
        specs = [
            (0, obs_doc(0, [obs_item("environment", ENV_A)]), "NORMAL"),
            (3, obs_doc(3, [obs_item("environment", ENV_B)]), "NORMAL"),
            (6, obs_doc(6, [obs_item("environment", ENV_A)]), "NORMAL"),
        ]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            video = root / "clip.mp4"
            video.write_bytes(b"fake-video")
            out = root / "out"
            with (
                mock.patch.object(
                    worker.engine,
                    "run_adaptive_vision",
                    side_effect=self.fake_vision(specs, terminal="failed"),
                ),
                mock.patch.object(
                    worker.engine,
                    "open_live_text_client",
                    return_value=(FakeClientCM(FakeTextClient()), "fake-key"),
                ),
            ):
                code, _data, messages = self.run_pipeline_quiet(
                    self.streaming_args(str(video), str(out))
                )
            self.assertEqual(code, 1)
            error = next(m for m in messages if m["type"] == "error")
            self.assertEqual(error["stage"], "adaptive_vision")
            # Partial script artifacts still finalized from the ledger.
            self.assertTrue((out / "script" / "script.json").is_file())


if __name__ == "__main__":
    unittest.main()
