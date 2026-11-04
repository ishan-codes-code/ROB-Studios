"""Electron worker: orchestrate the AI Commentator engine over stdio.

Launched by the Electron main process as ``python worker.py VIDEO``.
Communicates exclusively with newline-delimited JSON (NDJSON) on stdout;
every line is one JSON object (see ``docs/contracts/worker-protocol.md``).
All engine diagnostics and legacy ``print`` output are redirected to
stderr so stdout stays parseable. No secrets are ever printed.

Exit codes: 0 when every stage succeeds, 1 when a pipeline stage fails,
2 for argument or input validation errors.
"""

import argparse
import contextlib

import json
import os
import signal
import sys
import threading
import time
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import main as engine  # noqa: E402
from ai_commentator import api_activity  # noqa: E402

SUPPORTED_VIDEO_EXTENSIONS = (".mp4", ".avi", ".mov", ".mkv", ".webm")

REAL_STDOUT = sys.stdout
_EMIT_LOCK = threading.Lock()

# Unique per worker process: the main process already tags the project,
# so run_id only needs to distinguish runs within it.
RUN_ID = f"run-{os.getpid()}-{int(time.time() * 1000)}"


def emit(message: dict) -> None:
    """Write one protocol message as a single JSON line on stdout.

    Locked: streaming stages report from worker threads, and NDJSON
    lines must never interleave. Buffered API activity is flushed
    after every protocol message so diagnostics stream in real time.
    """
    line = json.dumps(message, ensure_ascii=False) + "\n"
    with _EMIT_LOCK:
        REAL_STDOUT.write(line)
        REAL_STDOUT.flush()
    try:
        drain_api_activity()
    except Exception:
        # Diagnostics must never break the pipeline.
        pass


def drain_api_activity() -> int:
    """Emit buffered API activity as ``api_activity`` NDJSON messages.

    Returns the number of messages written. Started events and their
    terminal events are separate protocol messages sharing the request
    ``id``; the main process pairs them for persistence.
    """
    try:
        events = api_activity.drain_events()
    except Exception:
        return 0
    written = 0
    for event in events:
        try:
            if (not isinstance(event, dict)
                    or not isinstance(event.get("id"), str)
                    or event.get("event") not in ("started", "terminal")):
                raise ValueError("malformed activity event")
            message = {"type": "api_activity", "run_id": RUN_ID,
                       "activity": event}
            line = json.dumps(message, ensure_ascii=False) + "\n"
        except (TypeError, ValueError) as exc:
            print(f"API activity report skipped: {exc}", file=sys.stderr)
            continue
        with _EMIT_LOCK:
            REAL_STDOUT.write(line)
            REAL_STDOUT.flush()
        written += 1
    return written


def emit_error(stage: str, message: str) -> None:
    emit({"type": "error", "stage": stage, "message": message})


def install_stop_handler(token):
    """Route SIGTERM to an adaptive StopToken; return the previous handler.

    Installed only around the adaptive stage: Electron's cancel sends
    SIGTERM, which then becomes a graceful stop (finish the in-flight
    request, persist it, halt) instead of a kill. Returns None when the
    handler cannot be installed (non-main thread); the run still works,
    only the graceful path is unavailable.
    """
    try:
        previous = signal.getsignal(signal.SIGTERM)
        signal.signal(signal.SIGTERM, lambda signum, frame: token.request_stop())
    except (ValueError, OSError, RuntimeError):
        return None
    return previous


def restore_stop_handler(previous):
    """Restore the SIGTERM handler saved by install_stop_handler."""
    if previous is None:
        return
    try:
        signal.signal(signal.SIGTERM, previous)
    except (ValueError, OSError, RuntimeError):
        pass


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run the AI Commentator adaptive pipeline on a video "
        "file, reporting NDJSON progress on stdout. Adaptive sampling is "
        "the only supported analysis mode.",
    )
    parser.add_argument(
        "video",
        type=Path,
        help="Gameplay video file to process.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=None,
        metavar="DIR",
        help="Base output directory holding frames/, observations/, "
        "events/, commentary/, and script/ "
        f"(default {engine.PROJECT_ROOT / 'output'}).",
    )
    parser.add_argument(
        "--with-script",
        action="store_true",
        help="Also generate the final casting script (one paid text-only "
        "model call).",
    )
    parser.add_argument(
        "--generate-tts",
        action="store_true",
        help="Also synthesize commentary audio from the generated script "
        "with Gemini TTS (paid, one request per segment; requires "
        "--with-script).",
    )
    parser.add_argument(
        "--tts-model",
        default=None,
        metavar="MODEL",
        help="TTS model for --generate-tts (pinned catalogue choice; "
        f"default {engine.DEFAULT_TTS_MODEL}).",
    )
    parser.add_argument(
        "--tts-voice",
        default=None,
        metavar="VOICE",
        help="TTS voice for --generate-tts "
        f"(default {engine.DEFAULT_TTS_VOICE}).",
    )
    parser.add_argument(
        "--tts-voice-direction",
        default=None,
        metavar="TEXT",
        help="TTS voice direction for --generate-tts (delivery style, "
        "not commentary content).",
    )
    parser.add_argument(
        "--adaptive",
        action="store_true",
        help="Sample the video adaptively: one captured frame, one vision "
        "request, and one sampling decision per step (paid).",
    )
    parser.add_argument(
        "--adaptive-max-frames",
        type=engine.parse_max_frames_argument,
        default=None,
        metavar="N",
        help="Maximum sampled frames for --adaptive (positive integer up "
        f"to {engine.ADAPTIVE_HARD_MAX_FRAMES}; omit for unlimited, which "
        "samples to video end unless stopped).",
    )
    parser.add_argument(
        "--game-pack",
        default=None,
        metavar="PACK",
        help="Game prompt pack for LLM wording (free-fire, cod, bgmi; "
        "default free-fire). Electron runs pass the resolved pack "
        "through the child environment instead.",
    )
    parser.add_argument(
        "--streaming",
        action="store_true",
        help="Run Vision, script generation, and TTS concurrently over "
        "bounded queues (requires --adaptive; implies the script "
        "stage; --generate-tts adds streaming audio).",
    )
    return parser


def validate_video(video: Path) -> str | None:
    """Return an error message when the video path is unusable, else None."""
    if not video.exists():
        return f"Video not found: {video}"
    if not video.is_file():
        return f"Not a file: {video}"
    if video.suffix.lower() not in SUPPORTED_VIDEO_EXTENSIONS:
        supported = ", ".join(SUPPORTED_VIDEO_EXTENSIONS)
        return (
            f"Unsupported video extension {video.suffix!r} "
            f"(supported: {supported})."
        )
    return None


def count_frames(frames_dir: Path) -> int:
    return len(engine.discover_candidate_frames(frames_dir))


def count_observations(obs_dir: Path) -> int:
    return len(engine.discover_observation_files(obs_dir))


def emit_adaptive_sample(summary) -> None:
    """Forward one persisted iteration as an NDJSON message.

    Reporting-only: the engine contains hook errors, and this
    function never triggers requests. Malformed summaries are
    noted on stderr and skipped so the stream stays clean.
    """
    try:
        message = {
            "type": "adaptive_sample",
            "data": {
                "timestamp": float(summary["timestamp"]),
                "speed": summary["speed"],
                "reason": str(summary.get("reason") or ""),
                "next_timestamp": (
                    None
                    if summary.get("next_timestamp") is None
                    else float(summary["next_timestamp"])
                ),
                "observations": int(summary["observations"]),
                "requests": int(summary["requests"]),
            },
        }
    except (KeyError, TypeError, ValueError) as exc:
        print(
            f"Adaptive progress report skipped: {exc}",
            file=sys.stderr,
        )
        return
    emit(message)


def emit_script_segment(record: dict) -> None:
    """Forward one validated script utterance as an NDJSON message.

    Reporting-only from the streaming script thread. Malformed records
    are noted on stderr and skipped so the stream stays clean.
    """
    try:
        message = {
            "type": "script_segment",
            "data": {
                "utterance_id": str(record["utterance_id"]),
                "timestamp_seconds": float(record["timestamp_seconds"]),
                "text": str(record["text"]),
                "source_claim_ids": [str(i) for i in record["source_claim_ids"]],
                "priority": int(record["priority"]),
                "status": str(record["status"]),
            },
        }
        if message["data"]["status"] not in ("worded", "superseded"):
            raise ValueError("unknown script segment status")
        if message["data"]["priority"] not in (0, 1, 2):
            raise ValueError("unknown script segment priority")
    except (KeyError, TypeError, ValueError) as exc:
        print(f"Script segment report skipped: {exc}", file=sys.stderr)
        return
    emit(message)


def emit_tts_segment(record: dict) -> None:
    """Forward one TTS utterance outcome as an NDJSON message.

    Reporting-only from the streaming TTS thread. Malformed records
    are noted on stderr and skipped so the stream stays clean.
    """
    try:
        error = record.get("error")
        message = {
            "type": "tts_segment",
            "data": {
                "utterance_id": str(record["utterance_id"]),
                "timestamp_seconds": float(record["timestamp_seconds"]),
                "status": str(record["status"]),
                "error": None if error is None else str(error),
            },
        }
        if message["data"]["status"] not in ("success", "error", "skipped", "started"):
            raise ValueError("unknown TTS segment status")
    except (KeyError, TypeError, ValueError) as exc:
        print(f"TTS segment report skipped: {exc}", file=sys.stderr)
        return
    emit(message)


def run_adaptive_stage(args, video: Path, obs_dir: Path, on_iteration) -> dict:
    """Run the adaptive vision loop; return the engine result dict.

    Shared by the sequential and streaming paths: frames are captured
    from the video (batched into one request per iteration at HIGH
    speed), one observation + sampling decision persisted per frame.
    Cooperative stop via the stdin control channel. No extracted JPEG set
    is written beforehand.
    """
    stop_token = engine.StopToken()
    previous_handler = install_stop_handler(stop_token)
    # Stdin control channel (M4.2-A): a daemon thread pumps control
    # lines into the same token without blocking the loop. Detached
    # in the finally below; late commands then become no-ops.
    control_listener = engine.start_control_listener(stop_token)
    try:
        with contextlib.redirect_stdout(sys.stderr):
            return engine.run_adaptive_vision(
                video_path=video,
                observations_dir=obs_dir,
                # None is the unlimited sentinel: omitted flag means no
                # user-imposed bound (video end or stop terminates).
                max_frames=getattr(args, "adaptive_max_frames", None),
                stop_token=stop_token,
                on_iteration=on_iteration,
            )
    finally:
        engine.detach_control_listener(control_listener)
        restore_stop_handler(previous_handler)


def plan_stages(args):
    """Determine the stage plan for an adaptive run.

    Returns ``(stage, mode)`` pairs with mode ``"run"``. Adaptive
    sampling is the only supported analysis mode: on adaptive success
    the deterministic downstream stages always run (a stopped or failed
    adaptive stage returns before they start). Streaming runs always
    include the script stage; ``--generate-tts`` adds TTS to either mode.
    """
    if not getattr(args, "adaptive", False):
        raise ValueError(
            "Adaptive sampling is the only supported analysis mode."
        )
    streaming = bool(getattr(args, "streaming", False))
    plan = [
        ("adaptive_vision", "run"),
        ("state_rebuild", "run"),
        ("event_detection", "run"),
        ("commentary", "run"),
    ]
    if streaming or getattr(args, "with_script", False):
        plan.append(("script", "run"))
    if getattr(args, "generate_tts", False):
        if not streaming and not getattr(args, "with_script", False):
            raise ValueError("--generate-tts requires --with-script.")
        plan.append(("tts", "run"))
    return plan


def run_mode(plan, args=None):
    """Classify a run: ``"streaming"`` for concurrent runs, else adaptive."""
    if args is not None and getattr(args, "streaming", False):
        return "streaming"
    return "adaptive"


def read_json_summary(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


class StageTracker:
    """Emit stage-level progress for one run (sequential or streaming)."""

    def __init__(self, plan_list):
        self.plan = dict(plan_list)
        self.total = len(plan_list)
        self.done: list[str] = []

    def progress(self, stage: str) -> None:
        if stage not in self.plan:
            return
        emit(
            {
                "type": "progress",
                "stage": stage,
                "completed": len(self.done),
                "total": self.total,
                "progress": round(100 * len(self.done) / self.total),
            }
        )

    def complete(self, stage: str, detail: dict | None = None) -> None:
        if stage not in self.plan:
            return
        self.done.append(stage)
        message: dict = {
            "type": "stage_completed",
            "stage": stage,
            "completed": len(self.done),
            "total": self.total,
        }
        if detail:
            message["detail"] = detail
        emit(message)


def close_client_quietly(client) -> None:
    try:
        client.close()
    except Exception:
        pass


def submit_stream_observation(pipeline, obs_dir: Path, summary) -> None:
    """Submit one persisted iteration to the streaming consumers.

    Best-effort: the observation file was just validated and written by
    the vision loop, so failures are unexpected; they are noted on
    stderr and never break vision. Skipped observations stay out of the
    script's ``generated_from`` so coverage stays honest.
    """
    try:
        timestamp = summary["timestamp"]
        source_path = engine.observation_path_for_timestamp(timestamp, obs_dir)
        validated = engine.validate_observation(
            json.loads(source_path.read_text(encoding="utf-8"))
        )
        engine.ensure_observation_timestamp(validated, timestamp)
        pipeline.submit_observation(
            timestamp, source_path.name, validated, summary.get("speed")
        )
    except Exception as exc:
        print(f"Streaming submit skipped: {exc}", file=sys.stderr)


def require_key() -> str | None:
    if os.environ.get("AI_COMMENTATOR_API_KEY"):
        return None
    if os.environ.get("BASETEN_API_KEY"):
        return None
    return (
        "AI_COMMENTATOR_API_KEY is not set in the environment "
        "(legacy BASETEN_API_KEY also absent)."
    )
    return None


def require_tts_key() -> str | None:
    if os.environ.get(engine.TTS_API_KEY_ENV_VAR):
        return None
    return (
        f"{engine.TTS_API_KEY_ENV_VAR} is not set in the environment."
    )


def resolve_tts_config(args) -> tuple[str, str, str]:
    """Validate the TTS voice configuration for a `--generate-tts` run.

    Unset options fall back to the engine defaults; anything else must
    pass the authoritative ``validate_tts_config`` gate. Raises
    ``ValueError`` with a secret-free message. Used both for fail-fast
    validation in ``main`` and for the stage call in ``run_pipeline``.
    """
    model = getattr(args, "tts_model", None)
    voice = getattr(args, "tts_voice", None)
    direction = getattr(args, "tts_voice_direction", None)
    return engine.validate_tts_config(
        engine.DEFAULT_TTS_MODEL if model is None else model,
        engine.DEFAULT_TTS_VOICE if voice is None else voice,
        engine.DEFAULT_TTS_VOICE_DIRECTION if direction is None else direction,
    )


def run_pipeline(args: argparse.Namespace) -> tuple[int, dict]:
    """Run every stage; return (exit_code, result_data)."""
    if getattr(args, "streaming", False):
        return run_streaming_pipeline(args)
    base = (
        Path(args.output_dir)
        if args.output_dir is not None
        else engine.PROJECT_ROOT / "output"
    )
    frames_dir = base / "frames"
    obs_dir = base / "observations"
    state_path = obs_dir / engine.MATCH_STATE_FILENAME
    events_path = base / "events" / engine.EVENTS_FILENAME
    commentary_path = base / "commentary" / engine.COMMENTARY_FILENAME
    script_path = base / "script" / engine.SCRIPT_FILENAME
    audio_dir = base / engine.TTS_AUDIO_DIRNAME
    tts_path = audio_dir / engine.TTS_MANIFEST_FILENAME

    plan_list = plan_stages(args)
    plan = dict(plan_list)
    total = len(plan_list)
    done: list[str] = []
    skipped: list[str] = []
    events: list = []
    lines: list = []

    def progress(stage: str) -> None:
        if stage not in plan:
            return
        emit(
            {
                "type": "progress",
                "stage": stage,
                "completed": len(done),
                "total": total,
                "progress": round(100 * len(done) / total),
            }
        )

    def complete(stage: str, detail: dict | None = None) -> None:
        if stage not in plan:
            return
        done.append(stage)
        message: dict = {
            "type": "stage_completed",
            "stage": stage,
            "completed": len(done),
            "total": total,
        }
        if detail:
            message["detail"] = detail
        emit(message)

    video = Path(args.video)
    emit({"type": "started", "message": f"Processing video {video.name}"})

    if getattr(args, "adaptive", False):
        # Adaptive vision (paid): capture one frame at a time from the
        # video, request one observation + sampling decision per frame,
        # and schedule the next timestamp from that decision. No
        # extracted JPEG set is written beforehand.
        progress("adaptive_vision")
        adaptive_result = run_adaptive_stage(
            args, video, obs_dir, emit_adaptive_sample
        )
        if adaptive_result["status"] == "failed":
            failure = adaptive_result.get("error")
            if not isinstance(failure, dict):
                failure = {}
            failure_message = failure.get("message")
            emit_error(
                "adaptive_vision",
                "Adaptive sampling failed "
                f"({adaptive_result['termination']})"
                + (
                    f": {failure_message}"
                    if failure_message
                    else "; see worker stderr."
                ),
            )
            return 1, {}
        adaptive_observations = count_observations(obs_dir)
        if adaptive_result["status"] == "stopped":
            stopped_data = {
                "video": str(video),
                "output_dir": str(base),
                "stages": done,
                "skipped": skipped,
                "mode": "adaptive",
                "frames": count_frames(frames_dir),
                "observations": adaptive_observations,
                "events": 0,
                "commentary_lines": 0,
                "script": "skipped",
                "tts": "skipped",
                "status": "stopped",
                "termination": adaptive_result["termination"],
                "requests": adaptive_result["requests"],
                "artifacts": {
                    "state": str(state_path)
                    if state_path.is_file()
                    else None,
                    "events": str(events_path)
                    if events_path.is_file()
                    else None,
                    "commentary": (
                        str(commentary_path)
                        if commentary_path.is_file()
                        else None
                    ),
                    "script": None,
                    "tts": None,
                    "manifest": str(adaptive_result["manifest"]),
                },
            }
            emit({"type": "stopped", "data": stopped_data})
            return 0, stopped_data
        complete(
            "adaptive_vision",
            {
                "observations": adaptive_observations,
                "requests": adaptive_result["requests"],
                "termination": adaptive_result["termination"],
            },
        )

    # Match-state rebuild (offline).
    progress("state_rebuild")
    with contextlib.redirect_stdout(sys.stderr):
        code = engine.run_state_rebuild(
            observations_dir=obs_dir,
            state_path=state_path,
            frames_dir=frames_dir,
        )
    if code != 0:
        emit_error(
            "state_rebuild",
            "State rebuild failed; see worker stderr.",
        )
        return 1, {}
    complete("state_rebuild", {"state": str(state_path)})

    # Event detection (offline).
    progress("event_detection")
    with contextlib.redirect_stdout(sys.stderr):
        code = engine.run_detect_events(
            observations_dir=obs_dir,
            state_path=state_path,
            events_path=events_path,
            frames_dir=frames_dir,
        )
    if code != 0:
        emit_error(
            "event_detection",
            "Event detection failed; see worker stderr.",
        )
        return 1, {}
    events_doc = read_json_summary(events_path) or {}
    events = events_doc.get("events", [])
    complete("event_detection", {"events": len(events)})

    # Commentary generation, deterministic wording (offline).
    progress("commentary")
    with contextlib.redirect_stdout(sys.stderr):
        code = engine.run_generate_commentary(
            observations_dir=obs_dir,
            state_path=state_path,
            events_path=events_path,
            commentary_path=commentary_path,
            frames_dir=frames_dir,
        )
    if code != 0:
        emit_error(
            "commentary",
            "Commentary generation failed; see worker stderr.",
        )
        return 1, {}
    commentary_doc = read_json_summary(commentary_path) or {}
    lines = commentary_doc.get("lines", [])
    complete("commentary", {"lines": len(lines)})

    # Final casting script (paid, opt-in).
    script_status = "skipped"
    if args.with_script:
        progress("script")
        with contextlib.redirect_stdout(sys.stderr):
            code = engine.run_generate_script(
                observations_dir=obs_dir,
                state_path=state_path,
                events_path=events_path,
                commentary_path=commentary_path,
                script_path=script_path,
                frames_dir=frames_dir,
            )
        if code != 0:
            emit_error(
                "script",
                "Script generation failed; see worker stderr.",
            )
            return 1, {}
        script_doc = read_json_summary(script_path) or {}
        script_status = str(script_doc.get("status", "unknown"))
        complete("script", {"status": script_status})

    # Commentary audio (paid, opt-in): synthesize the script's segments.
    tts_status = "skipped"
    if getattr(args, "generate_tts", False):
        progress("tts")
        tts_model, tts_voice, tts_direction = resolve_tts_config(args)
        with contextlib.redirect_stdout(sys.stderr):
            code = engine.run_generate_tts(
                script_path=script_path,
                audio_dir=audio_dir,
                model=tts_model,
                voice=tts_voice,
                voice_direction=tts_direction,
            )
        if code != 0:
            # Spoken audio is best-effort: a TTS failure must not discard
            # completed text commentary. The tts stage completes with its
            # recorded error status and the run still reports results.
            print(
                "Warning: commentary audio generation failed; keeping text "
                "commentary without audio.",
                file=sys.stderr,
            )
        tts_doc = read_json_summary(tts_path) or {}
        tts_status = str(tts_doc.get("status", "unknown"))
        if code != 0 and tts_status == "unknown":
            tts_status = "error"
        tts_entries = tts_doc.get("entries", [])
        if not isinstance(tts_entries, list):
            tts_entries = []
        complete(
            "tts",
            {
                "status": tts_status,
                "segments": len(tts_entries),
                "succeeded": sum(
                    1 for e in tts_entries
                    if isinstance(e, dict) and e.get("status") == "success"
                ),
                "failed": sum(
                    1 for e in tts_entries
                    if isinstance(e, dict) and e.get("status") == "error"
                ),
            },
        )

    data = {
        "video": str(video),
        "output_dir": str(base),
        "stages": done,
        "skipped": skipped,
        "mode": run_mode(plan_list, args),
        "frames": count_frames(frames_dir),
        "observations": count_observations(obs_dir),
        "events": len(events),
        "commentary_lines": len(lines),
        "script": script_status,
        "tts": tts_status,
        "artifacts": {
            "state": str(state_path) if state_path.is_file() else None,
            "events": str(events_path) if events_path.is_file() else None,
            "commentary": (
                str(commentary_path) if commentary_path.is_file() else None
            ),
            "script": str(script_path) if args.with_script else None,
            "tts": (
                str(tts_path)
                if getattr(args, "generate_tts", False)
                else None
            ),
        },
    }
    return 0, data


def run_streaming_pipeline(args: argparse.Namespace) -> tuple[int, dict]:
    """Run Vision, script, and TTS concurrently; return (exit, result).

    The vision loop produces validated observations into a bounded
    queue while the script and TTS consumers make progress on earlier
    observations. Script/TTS artifacts finalize from the ledger when
    vision ends (completed, stopped, or failed); then the deterministic
    state/events/commentary tail runs once over the final observation
    set so even partial runs leave consistent artifacts.
    """
    base = (
        Path(args.output_dir)
        if args.output_dir is not None
        else engine.PROJECT_ROOT / "output"
    )
    frames_dir = base / "frames"
    obs_dir = base / "observations"
    state_path = obs_dir / engine.MATCH_STATE_FILENAME
    events_path = base / "events" / engine.EVENTS_FILENAME
    commentary_path = base / "commentary" / engine.COMMENTARY_FILENAME
    script_path = base / "script" / engine.SCRIPT_FILENAME
    audio_dir = base / engine.TTS_AUDIO_DIRNAME
    tts_path = audio_dir / engine.TTS_MANIFEST_FILENAME

    plan_list = plan_stages(args)
    tracker = StageTracker(plan_list)
    want_tts = bool(getattr(args, "generate_tts", False))

    def tail_stages(best_effort: bool) -> tuple[int, list, list]:
        """Run the offline state/events/commentary tail once.

        Returns ``(exit_code, events, lines)``. Strict on the success
        path (a tail failure fails the run, like the sequential mode);
        best-effort on stopped/failed runs (noted on stderr, original
        terminal preserved) so partial runs still gain artifacts.
        """
        events: list = []
        lines: list = []
        tracker.progress("state_rebuild")
        with contextlib.redirect_stdout(sys.stderr):
            code = engine.run_state_rebuild(
                observations_dir=obs_dir,
                state_path=state_path,
                frames_dir=frames_dir,
            )
        if code != 0:
            message = "State rebuild failed; see worker stderr."
            if best_effort:
                print(f"Streaming tail skipped: {message}", file=sys.stderr)
                return 0, events, lines
            emit_error("state_rebuild", message)
            return 1, events, lines
        tracker.complete("state_rebuild", {"state": str(state_path)})
        tracker.progress("event_detection")
        with contextlib.redirect_stdout(sys.stderr):
            code = engine.run_detect_events(
                observations_dir=obs_dir,
                state_path=state_path,
                events_path=events_path,
                frames_dir=frames_dir,
            )
        if code != 0:
            message = "Event detection failed; see worker stderr."
            if best_effort:
                print(f"Streaming tail skipped: {message}", file=sys.stderr)
                return 0, events, lines
            emit_error("event_detection", message)
            return 1, events, lines
        events_doc = read_json_summary(events_path) or {}
        events = events_doc.get("events", [])
        tracker.complete("event_detection", {"events": len(events)})
        tracker.progress("commentary")
        with contextlib.redirect_stdout(sys.stderr):
            code = engine.run_generate_commentary(
                observations_dir=obs_dir,
                state_path=state_path,
                events_path=events_path,
                commentary_path=commentary_path,
                frames_dir=frames_dir,
            )
        if code != 0:
            message = "Commentary generation failed; see worker stderr."
            if best_effort:
                print(f"Streaming tail skipped: {message}", file=sys.stderr)
                return 0, events, lines
            emit_error("commentary", message)
            return 1, events, lines
        commentary_doc = read_json_summary(commentary_path) or {}
        lines = commentary_doc.get("lines", [])
        tracker.complete("commentary", {"lines": len(lines)})
        return 0, events, lines

    video = Path(args.video)
    emit({"type": "started", "message": f"Processing video {video.name}"})
    tracker.progress("adaptive_vision")
    tracker.progress("script")
    if want_tts:
        tracker.progress("tts")
    try:
        script_cm, _script_key = engine.open_live_text_client()
    except (RuntimeError, ValueError) as exc:
        emit_error("script", f"Script generation failed: {exc}")
        return 1, {}
    tts_cfg = None
    if want_tts:
        try:
            tts_cfg = resolve_tts_config(args)
        except ValueError as exc:
            emit_error("tts", f"Invalid TTS configuration: {exc}")
            return 1, {}
    with contextlib.ExitStack() as stack:
        script_client = stack.enter_context(script_cm)
        tts_client = None
        if want_tts:
            tts_key = os.environ.get(engine.TTS_API_KEY_ENV_VAR, "")
            if not tts_key:
                emit_error(
                    "tts",
                    f"{engine.TTS_API_KEY_ENV_VAR} is not set in the environment.",
                )
                return 1, {}
            try:
                tts_client = engine.GeminiTTSClient(
                    api_key=tts_key, model=tts_cfg[0]
                )
            except Exception as exc:
                detail = str(exc) or type(exc).__name__
                emit_error(
                    "tts",
                    "Commentary audio generation failed: "
                    f"{detail.replace(tts_key, '[REDACTED]')}",
                )
                return 1, {}
            stack.callback(close_client_quietly, tts_client)
        pipeline = engine.StreamingPipeline(
            script_path=script_path,
            commentary_path=commentary_path,
            audio_dir=audio_dir,
            tts_config=tts_cfg,
            on_script_segment=emit_script_segment,
            on_tts_segment=emit_tts_segment,
            script_client=script_client,
            tts_client=tts_client,
        )
        pipeline.start()

        def on_iteration(summary) -> None:
            emit_adaptive_sample(summary)
            submit_stream_observation(pipeline, obs_dir, summary)

        try:
            adaptive_result = run_adaptive_stage(args, video, obs_dir, on_iteration)
        except BaseException:
            # Cancel or crash: halt consumers without finalizing so a
            # cancelled run gains no fresh downstream artifacts, then
            # let the terminal handling in main() report it.
            pipeline.halt()
            raise
        pipeline.finish_vision()
        stream = pipeline.wait()

    adaptive_observations = count_observations(obs_dir)
    script_status = stream["script_status"]
    tts_status = stream["tts_status"]
    if adaptive_result["status"] == "failed":
        failure = adaptive_result.get("error")
        if not isinstance(failure, dict):
            failure = {}
        failure_message = failure.get("message")
        tracker.complete(
            "script",
            {"status": script_status, "segments": stream["segments"]},
        )
        if want_tts:
            tracker.complete("tts", {"status": tts_status})
        tail_stages(best_effort=True)
        emit_error(
            "adaptive_vision",
            "Adaptive sampling failed "
            f"({adaptive_result['termination']})"
            + (
                f": {failure_message}"
                if failure_message
                else "; see worker stderr."
            ),
        )
        return 1, {}
    if adaptive_result["status"] == "stopped":
        tracker.complete(
            "script",
            {"status": script_status, "segments": stream["segments"]},
        )
        if want_tts:
            tracker.complete("tts", {"status": tts_status})
        tail_stages(best_effort=True)
        commentary_doc = read_json_summary(commentary_path) or {}
        stopped_data = {
            "video": str(video),
            "output_dir": str(base),
            "stages": tracker.done,
            "skipped": [],
            "mode": "streaming",
            "frames": count_frames(frames_dir),
            "observations": adaptive_observations,
            "events": len((read_json_summary(events_path) or {}).get("events", [])),
            "commentary_lines": len(commentary_doc.get("lines", [])),
            "script": script_status,
            "tts": tts_status,
            "status": "stopped",
            "termination": adaptive_result["termination"],
            "requests": adaptive_result["requests"],
            "artifacts": {
                "state": str(state_path) if state_path.is_file() else None,
                "events": str(events_path) if events_path.is_file() else None,
                "commentary": (
                    str(commentary_path) if commentary_path.is_file() else None
                ),
                "script": stream["script_path"],
                "tts": stream["tts_path"],
                "manifest": str(adaptive_result["manifest"]),
            },
        }
        emit({"type": "stopped", "data": stopped_data})
        return 0, stopped_data
    tracker.complete(
        "adaptive_vision",
        {
            "observations": adaptive_observations,
            "requests": adaptive_result["requests"],
            "termination": adaptive_result["termination"],
        },
    )
    tracker.complete(
        "script",
        {
            "status": script_status,
            "segments": stream["segments"],
            "utterances": stream["utterances"],
            "superseded": stream["superseded"],
        },
    )
    if want_tts:
        tts_doc = read_json_summary(tts_path) or {}
        tts_entries = tts_doc.get("entries", [])
        if not isinstance(tts_entries, list):
            tts_entries = []
        tracker.complete(
            "tts",
            {
                "status": tts_status,
                "segments": len(tts_entries),
                "succeeded": sum(
                    1 for e in tts_entries
                    if isinstance(e, dict) and e.get("status") == "success"
                ),
                "failed": sum(
                    1 for e in tts_entries
                    if isinstance(e, dict) and e.get("status") == "error"
                ),
            },
        )
    tail_code, events, lines = tail_stages(best_effort=False)
    if tail_code != 0:
        return 1, {}
    if script_status == "error":
        emit_error("script", "Script generation failed; see worker stderr.")
        return 1, {}
    if want_tts and tts_status not in ("success", "silence"):
        emit_error("tts", "Commentary audio generation failed; see worker stderr.")
        return 1, {}
    data = {
        "video": str(video),
        "output_dir": str(base),
        "stages": tracker.done,
        "skipped": [],
        "mode": "streaming",
        "frames": count_frames(frames_dir),
        "observations": adaptive_observations,
        "events": len(events),
        "commentary_lines": len(lines),
        "script": script_status,
        "tts": tts_status,
        "artifacts": {
            "state": str(state_path) if state_path.is_file() else None,
            "events": str(events_path) if events_path.is_file() else None,
            "commentary": (
                str(commentary_path) if commentary_path.is_file() else None
            ),
            "script": stream["script_path"],
            "tts": stream["tts_path"],
        },
    }
    return 0, data


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    problem = validate_video(Path(args.video))
    if not getattr(args, "adaptive", False):
        emit_error(
            "validation",
            "Adaptive sampling is the only supported analysis mode; "
            "pass --adaptive.",
        )
        return 2
    if problem is not None:
        emit_error("validation", problem)
        return 2
    if getattr(args, "game_pack", None) is not None:
        try:
            engine.get_factory_pack(args.game_pack)
        except ValueError as exc:
            emit_error("validation", str(exc))
            return 2
        os.environ["AI_COMMENTATOR_PACK_ID"] = args.game_pack
    streaming = bool(getattr(args, "streaming", False))
    if (
        getattr(args, "generate_tts", False)
        and not getattr(args, "with_script", False)
        and not streaming
    ):
        emit_error(
            "validation",
            "--generate-tts requires --with-script.",
        )
        return 2
    key_problem = require_key()
    if key_problem is not None:
        # Fail fast before any paid call: report the missing key as
        # structured output, never the key itself.
        emit_error("adaptive_vision", key_problem)
        return 1
    if args.with_script or streaming:
        key_problem = require_key()
        if key_problem is not None:
            emit_error("script", key_problem)
            return 1
    if getattr(args, "generate_tts", False):
        tts_key_problem = require_tts_key()
        if tts_key_problem is not None:
            emit_error("tts", tts_key_problem)
            return 1
        try:
            resolve_tts_config(args)
        except ValueError as exc:
            emit_error("tts", f"Invalid TTS configuration: {exc}")
            return 1
    try:
        # Engine diagnostics print to stderr from here on; protocol
        # messages keep using the saved real stdout via emit().
        # (run_pipeline also redirects around each engine call, so it is
        # stdout-clean when reused directly.)
        code, data = run_pipeline(args)
    except KeyboardInterrupt:
        emit_error("worker", "Processing was cancelled.")
        return 130
    except Exception as exc:  # defensive: never die without a message
        traceback.print_exc(file=sys.stderr)
        emit_error("worker", f"Unexpected worker failure: {exc}")
        return 1
    if code == 0 and data.get("status") != "stopped":
        # A gracefully stopped run already emitted its terminal `stopped`
        # message; emitting `result` too would blur the terminal state.
        emit({"type": "result", "data": data})
    return code


if __name__ == "__main__":
    raise SystemExit(main())
