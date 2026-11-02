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
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import main as engine  # noqa: E402

SUPPORTED_VIDEO_EXTENSIONS = (".mp4", ".avi", ".mov", ".mkv", ".webm")

REAL_STDOUT = sys.stdout


def emit(message: dict) -> None:
    """Write one protocol message as a single JSON line on stdout."""
    REAL_STDOUT.write(json.dumps(message, ensure_ascii=False) + "\n")
    REAL_STDOUT.flush()


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
        help="Maximum sampled frames for --adaptive (positive integer, "
        f"default {engine.ADAPTIVE_DEFAULT_MAX_FRAMES}).",
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


def plan_stages(args):
    """Determine the stage plan for an adaptive run.

    Returns ``(stage, mode)`` pairs with mode ``"run"``. Adaptive
    sampling is the only supported analysis mode: on adaptive success
    the deterministic downstream stages always run (a stopped or failed
    adaptive stage returns before they start).
    """
    if not getattr(args, "adaptive", False):
        raise ValueError(
            "Adaptive sampling is the only supported analysis mode."
        )
    plan = [
        ("adaptive_vision", "run"),
        ("state_rebuild", "run"),
        ("event_detection", "run"),
        ("commentary", "run"),
    ]
    if getattr(args, "with_script", False):
        plan.append(("script", "run"))
    if getattr(args, "generate_tts", False):
        if not getattr(args, "with_script", False):
            raise ValueError("--generate-tts requires --with-script.")
        plan.append(("tts", "run"))
    return plan


def run_mode(plan):
    """Classify a run from its plan: always adaptive sampling."""
    return "adaptive"


def read_json_summary(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


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


def run_pipeline(args: argparse.Namespace) -> tuple[int, dict]:
    """Run every stage; return (exit_code, result_data)."""
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
        # Adaptive vision (paid, sequential): capture one frame at a time
        # from the video, request one observation + sampling decision per
        # frame, and schedule the next timestamp from that decision. No
        # extracted JPEG set is written beforehand.
        progress("adaptive_vision")
        stop_token = engine.StopToken()
        previous_handler = install_stop_handler(stop_token)
        # Stdin control channel (M4.2-A): a daemon thread pumps control
        # lines into the same token without blocking the loop. Detached
        # in the finally below; late commands then become no-ops.
        control_listener = engine.start_control_listener(stop_token)

        def report_iteration(summary) -> None:
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
        try:
            with contextlib.redirect_stdout(sys.stderr):
                adaptive_result = engine.run_adaptive_vision(
                    video_path=video,
                    observations_dir=obs_dir,
                    max_frames=(
                        args.adaptive_max_frames
                        if getattr(args, "adaptive_max_frames", None)
                        is not None
                        else engine.ADAPTIVE_DEFAULT_MAX_FRAMES
                    ),
                    stop_token=stop_token,
                    on_iteration=report_iteration,
                )
        finally:
            engine.detach_control_listener(control_listener)
            restore_stop_handler(previous_handler)
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
        with contextlib.redirect_stdout(sys.stderr):
            code = engine.run_generate_tts(
                script_path=script_path,
                audio_dir=audio_dir,
            )
        if code != 0:
            emit_error(
                "tts",
                "Commentary audio generation failed; see worker stderr.",
            )
            return 1, {}
        tts_doc = read_json_summary(tts_path) or {}
        tts_status = str(tts_doc.get("status", "unknown"))
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
        "mode": run_mode(plan_list),
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
    if getattr(args, "generate_tts", False) and not getattr(args, "with_script", False):
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
    if args.with_script:
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
