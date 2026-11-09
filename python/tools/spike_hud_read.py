"""MANUAL SPIKE: probe broadcast-overlay (v3) HUD reading on real video.

Never called by tests with a live adapter and never by the app. Makes
paid vision calls with the operator's own key.

Usage:
    python -I python/tools/spike_hud_read.py --video PATH \\
        --times 3,21,40,52,58.7,62.5 --game-pack free-fire \\
        --repeat 2 --out DIR [--labels labels.json]

For each timestamp the tool grabs the frame (same
``ScheduledVideoReader`` capture the adaptive loop uses), encodes the
full frame as JPEG plus a 2x-upscaled crop of the top 22% ("hud
strip"), and sends two variants per repeat: full-frame only, and
full+strip in one request. Responses parse with
``validate_observation_v3``; raw and parsed JSON are saved per call. A
table per frame shows timer, scores, alive per team, focus
name/weapon/state, cues, latency, output tokens, and parse errors;
repeats report whether the readings agree, and ``--labels`` scores
per-field accuracy against expected timer/scores/alive.

Key handling mirrors the worker (environment provider config via the
registry); the key and all base64 bytes are never printed or logged.
Failures are per-frame/per-call; the run continues.
"""

import argparse
import json
import math
import sys
import time
from pathlib import Path

# Mirror tests/: the engine lives in <repo>/python, which is not an
# installed package, so put it on sys.path from this file's location.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import cv2  # noqa: E402

from ai_commentator.api_activity import drain_events  # noqa: E402
from ai_commentator.config import (  # noqa: E402
    OBSERVATION_V3_CONFIDENCES,
    OBSERVATION_V3_CUES,
    OBSERVATION_V3_SCENES,
    OBSERVATION_V3_STATES,
)
from ai_commentator.errors import ObservationError, VisionAPIError  # noqa: E402
from ai_commentator.prompts import coerce_pack  # noqa: E402
from ai_commentator.vision.client import (  # noqa: E402
    build_image_data_url,
    encode_frame_image,
)
from ai_commentator.vision.observations_v3 import (  # noqa: E402
    parse_observation_v3,
    validate_observation_v3,
)
from ai_commentator.vision.providers.base import (  # noqa: E402
    VisionProviderAdapter,
)
from ai_commentator.vision.providers.registry import (  # noqa: E402
    resolve_live_adapter,
)
from ai_commentator.vision.reader import ScheduledVideoReader  # noqa: E402

#: Top fraction of the frame kept for the HUD-strip crop.
HUD_STRIP_FRACTION = 0.22

#: Upscale applied to the HUD strip before JPEG encoding.
HUD_STRIP_UPSCALE = 2.0

VARIANTS = ("full", "full+strip")


def parse_times(value: str) -> list:
    """Parse ``--times`` into finite non-negative seconds."""
    times = []
    for chunk in value.split(","):
        chunk = chunk.strip()
        if not chunk:
            raise ValueError("--times holds an empty entry.")
        try:
            moment = float(chunk)
        except ValueError:
            raise ValueError(f"--times holds a non-number: {chunk!r}.") from None
        if not math.isfinite(moment) or moment < 0:
            raise ValueError(f"--times holds an invalid second: {chunk!r}.")
        times.append(moment)
    if not times:
        raise ValueError("--times needs at least one timestamp.")
    return times


def load_labels(path: str | None):
    """Load ``{time: {timer, scores, alive}}`` expectations keyed by float."""
    if path is None:
        return {}
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise SystemExit(f"error: labels file not found: {path}")
    except json.JSONDecodeError as exc:
        raise SystemExit(f"error: labels file is not valid JSON: {exc}")
    if not isinstance(raw, dict):
        raise SystemExit("error: labels file must be a JSON object.")
    labels = {}
    for key, expected in raw.items():
        try:
            moment = float(key)
        except (TypeError, ValueError):
            raise SystemExit(f"error: labels key is not a time: {key!r}.")
        if not isinstance(expected, dict):
            raise SystemExit(f"error: labels[{key!r}] must be an object.")
        labels[moment] = expected
    return labels


def build_broadcast_prompt(pack_fields: dict, timestamp: float) -> str:
    """Spike-only prompt: pack wording plus the compact v3 shape."""
    try:
        wording = pack_fields["broadcast_vision_prompt"]
    except KeyError:
        raise SystemExit(
            "error: game pack has no 'broadcast_vision_prompt' field."
        )
    shape = (
        "Respond with ONLY a single JSON object, no markdown fences, no "
        "commentary: {\"schema_version\": \"observation-v3\", "
        "\"timestamp\": <number>, \"scene\": <one of: "
        + ", ".join(OBSERVATION_V3_SCENES)
        + ">, \"round\": {\"timer\": \"MM:SS\" or null, \"timer_red\": "
        "true/false, \"round_no\": int or null}, \"teams\": [{\"id\": "
        "\"A\"/\"B\"..., \"color\": str, \"score\": int|null, \"alive\": "
        "int|null, \"total\": int|null}], \"focus\": {\"name\", "
        "\"team\", \"weapon\", \"state\": <one of: "
        + ", ".join(OBSERVATION_V3_STATES)
        + ">, \"hp_pct\": int|null} or null, \"in_view\": [{\"name\", "
        "\"team\", \"state\"}], \"cues\": [{\"cue\": <one of: "
        + ", ".join(OBSERVATION_V3_CUES)
        + ">, \"evidence\": \"<=12 words\"}], \"notes\": str or null, "
        "\"confidence\": <one of: "
        + ", ".join(OBSERVATION_V3_CONFIDENCES)
        + ">}."
    )
    return f"Frame timestamp: {timestamp:g}s. {wording} {shape}"


def broadcast_supported(adapter) -> bool:
    """True when the adapter implements broadcast requests (no I/O)."""
    method = getattr(adapter, "request_broadcast_text", None)
    if not callable(method):
        return False
    own = getattr(type(adapter), "request_broadcast_text", None)
    return own is not VisionProviderAdapter.request_broadcast_text


def hud_strip(frame):
    """Crop the top strip of a BGR frame and upscale it 2x."""
    height = frame.shape[0]
    rows = max(1, int(height * HUD_STRIP_FRACTION))
    cropped = frame[0:rows, :]
    return cv2.resize(
        cropped, None, fx=HUD_STRIP_UPSCALE, fy=HUD_STRIP_UPSCALE,
        interpolation=cv2.INTER_CUBIC,
    )


def slug_time(moment: float) -> str:
    return f"t{moment:g}".replace(".", "p").replace("-", "m")


def truncate(text: str, width: int) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= width else text[: max(0, width - 1)] + "…"


def one_line_error(exc: BaseException, width: int = 60) -> str:
    return truncate(f"{type(exc).__name__}: {exc}", width)


def drain_output_tokens():
    """Provider-reported output tokens from the last terminal event."""
    tokens = None
    for event in drain_events():
        if (
            isinstance(event, dict)
            and event.get("event") == "terminal"
            and isinstance(event.get("outputTokens"), int)
        ):
            tokens = event["outputTokens"]
    return tokens


def format_reading(parsed: dict | None) -> dict:
    """Render one parsed doc (or blanks) for the table."""
    if parsed is None:
        return {
            "timer": "-", "scores": "-", "alive": "-",
            "focus": "-", "cues": "-",
        }
    teams = {
        team["id"]: team for team in parsed.get("teams", [])
        if isinstance(team, dict) and team.get("id")
    }
    scores = " ".join(
        f"{key}={teams[key]['score']}" for key in sorted(teams)
    ) or "-"
    alive = " ".join(
        f"{key}={teams[key]['alive']}" for key in sorted(teams)
    ) or "-"
    focus = parsed.get("focus") or {}
    if focus:
        focus_text = "{}/{}/{}".format(
            focus.get("name") or "?", focus.get("weapon") or "?",
            focus.get("state") or "?",
        )
    else:
        focus_text = "-"
    cues = " ".join(
        cue.get("cue", "?") for cue in parsed.get("cues", [])
        if isinstance(cue, dict)
    ) or "-"
    timer = (parsed.get("round") or {}).get("timer")
    return {
        "timer": str(timer) if timer is not None else "-",
        "scores": scores,
        "alive": alive,
        "focus": focus_text,
        "cues": cues,
    }


def score_labels(parsed: dict | None, expected: dict) -> tuple:
    """Score one reading against labels; return (matched, total, notes)."""
    matched, total, notes = 0, 0, []
    if parsed is None:
        return 0, 0, ["no parsed reading"]
    if "timer" in expected:
        total += 1
        got = (parsed.get("round") or {}).get("timer")
        if got == expected["timer"]:
            matched += 1
            notes.append("timer ok")
        else:
            notes.append(f"timer WRONG exp={expected['timer']} got={got}")
    teams = {
        team["id"]: team for team in parsed.get("teams", [])
        if isinstance(team, dict) and team.get("id")
    }
    for field, key in (("scores", "score"), ("alive", "alive")):
        want = expected.get(field) or {}
        if not isinstance(want, dict):
            continue
        for team_id, exp_value in want.items():
            total += 1
            got = teams.get(team_id, {}).get(key) if team_id in teams else None
            if team_id in teams and got == exp_value:
                matched += 1
                notes.append(f"{field} {team_id}:ok")
            else:
                notes.append(
                    f"{field} {team_id}:WRONG exp={exp_value} got={got}"
                )
    return matched, total, notes


def run_spike(*, video, times, game_pack, repeat, out_dir, labels,
              adapter_factory=None, out_stream=None) -> int:
    """Run the spike; return a process exit code (0 unless fatal)."""
    out = out_stream if out_stream is not None else sys.stdout
    if repeat < 1:
        print("error: --repeat must be at least 1.", file=sys.stderr)
        return 1
    try:
        pack_fields = coerce_pack(game_pack)["fields"]
        prompt_for = build_broadcast_prompt(pack_fields, 0)
    except (ValueError, SystemExit) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    _ = prompt_for  # per-timestamp prompts are built below
    out_path = Path(out_dir)
    try:
        out_path.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        print(f"error: cannot create --out dir: {exc}", file=sys.stderr)
        return 1
    try:
        adapter = (
            adapter_factory()
            if adapter_factory is not None
            else resolve_live_adapter()
        )
    except (RuntimeError, ValueError, OSError) as exc:
        print(f"error: cannot resolve vision adapter: {exc}", file=sys.stderr)
        return 1
    if not broadcast_supported(adapter):
        provider = getattr(adapter, "provider_id", "?")
        print(
            f"error: provider {provider!r} does not implement "
            "request_broadcast_text; the broadcast spike needs an adapter "
            "with multi-image broadcast support.",
            file=sys.stderr,
        )
        return 1
    close = getattr(adapter, "close", None)
    try:
        try:
            with ScheduledVideoReader(video) as reader:
                return _run_frames(
                    out, adapter, reader, times, pack_fields, repeat,
                    out_path, labels,
                )
        except (FileNotFoundError, RuntimeError, OSError) as exc:
            print(f"error: cannot open video: {exc}", file=sys.stderr)
            return 1
    finally:
        try:
            if callable(close):
                close()
        except Exception:
            pass


def _run_frames(out, adapter, reader, times, pack_fields, repeat, out_path,
                labels) -> int:
    frames_ok = 0
    frames_failed = 0
    calls = 0
    parsed_ok = 0
    label_matched = 0
    label_total = 0
    label_times = 0
    for moment in times:
        try:
            frame = reader.capture_at(moment)
            full_bytes, full_mime, _, _ = encode_frame_image(frame)
            strip_bytes, strip_mime, _, _ = encode_frame_image(
                hud_strip(frame)
            )
        except (ValueError, RuntimeError, OSError) as exc:
            frames_failed += 1
            out.write(f"== t={moment:g}s == FAILED: {one_line_error(exc)}\n")
            continue
        frames_ok += 1
        full_url = build_image_data_url(full_bytes, full_mime)
        strip_url = build_image_data_url(strip_bytes, strip_mime)
        prompt = build_broadcast_prompt(pack_fields, moment)
        out.write(f"== t={moment:g}s ==\n")
        out.write(
            "variant     rep  timer   scores       alive        "
            "focus                cues                 lat_ms  out_tok  parse\n"
        )
        variants = {
            "full": [full_url],
            "full+strip": [full_url, strip_url],
        }
        canonical_by_variant: dict = {}
        first_parsed_full = None
        for variant in VARIANTS:
            canonical_by_variant[variant] = []
            for rep in range(repeat):
                calls += 1
                parsed, latency_ms, out_tokens, status = _one_call(
                    adapter, moment, variants[variant], prompt, out_path,
                    variant, rep,
                )
                if parsed is not None:
                    parsed_ok += 1
                    canonical_by_variant[variant].append(
                        json.dumps(parsed, sort_keys=True)
                    )
                    if variant == "full" and first_parsed_full is None:
                        first_parsed_full = parsed
                shown = format_reading(parsed)
                out.write(
                    f"{variant:<11} {rep:<4} "
                    f"{truncate(shown['timer'], 6):<6} "
                    f"{truncate(shown['scores'], 12):<12} "
                    f"{truncate(shown['alive'], 12):<12} "
                    f"{truncate(shown['focus'], 20):<20} "
                    f"{truncate(shown['cues'], 20):<20} "
                    f"{latency_ms:<7} "
                    f"{out_tokens if out_tokens is not None else '-':<7} "
                    f"{status}\n"
                )
        for variant in VARIANTS:
            have = canonical_by_variant[variant]
            if len(have) < repeat:
                verdict = f"INCOMPLETE ({len(have)}/{repeat} parsed)"
            elif all(item == have[0] for item in have):
                verdict = f"AGREE ({len(have)}/{repeat} identical)"
            else:
                verdict = f"DISAGREE ({len(have)}/{repeat} parsed)"
            out.write(f"agreement({variant}): {verdict}\n")
        expected = labels.get(moment)
        if expected is not None:
            label_times += 1
            matched, total, notes = score_labels(first_parsed_full, expected)
            label_matched += matched
            label_total += total
            out.write(
                f"labels(t={moment:g}): {matched}/{total} "
                f"({'; '.join(notes)})\n"
            )
    out.write(
        f"frames: {len(times)} ok={frames_ok} failed={frames_failed} "
        f"calls={calls} parsed={parsed_ok}\n"
    )
    if label_times:
        out.write(
            f"labels total: {label_matched}/{label_total} fields "
            f"across {label_times}/{len(times)} times\n"
        )
    return 0


def _one_call(adapter, moment, urls, prompt, out_path, variant, rep):
    """One spike request; return (parsed|None, lat_ms, out_tok, status)."""
    slug = f"frame_{slug_time(moment)}_{variant.replace('+', '')}_r{rep}"
    drain_events()
    started = time.perf_counter()
    try:
        raw = adapter.request_broadcast_text(moment, urls, prompt)
    except NotImplementedError:
        latency_ms = int((time.perf_counter() - started) * 1000)
        return None, latency_ms, None, "CALL-FAIL adapter lacks broadcast support"
    except (VisionAPIError, ObservationError, OSError, ValueError) as exc:
        latency_ms = int((time.perf_counter() - started) * 1000)
        return None, latency_ms, None, f"CALL-FAIL {one_line_error(exc)}"
    except Exception as exc:  # never let one call kill the spike
        latency_ms = int((time.perf_counter() - started) * 1000)
        return None, latency_ms, None, f"CALL-FAIL {one_line_error(exc)}"
    latency_ms = int((time.perf_counter() - started) * 1000)
    out_tokens = drain_output_tokens()
    (out_path / f"{slug}_raw.txt").write_text(
        raw if isinstance(raw, str) else str(raw), encoding="utf-8"
    )
    try:
        parsed = validate_observation_v3(parse_observation_v3(raw))
    except ObservationError as exc:
        (out_path / f"{slug}_parse_error.txt").write_text(
            f"{type(exc).__name__}: {exc}\n", encoding="utf-8"
        )
        return None, latency_ms, out_tokens, f"ERR {one_line_error(exc)}"
    (out_path / f"{slug}_parsed.json").write_text(
        json.dumps(parsed, indent=2), encoding="utf-8"
    )
    return parsed, latency_ms, out_tokens, "ok"


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Manual paid spike: probe v3 HUD reading on video frames."
    )
    parser.add_argument("--video", required=True, help="Source video path.")
    parser.add_argument(
        "--times", required=True,
        help="Comma-separated frame timestamps in seconds.",
    )
    parser.add_argument(
        "--game-pack", default="free-fire",
        help="Prompt pack id (default: free-fire).",
    )
    parser.add_argument(
        "--repeat", type=int, default=1,
        help="Calls per variant per frame (default: 1).",
    )
    parser.add_argument(
        "--out", default="spike_out",
        help="Output directory (default: ./spike_out).",
    )
    parser.add_argument(
        "--labels", default=None,
        help="Optional labels.json with expected timer/scores/alive.",
    )
    args = parser.parse_args(argv)
    try:
        times = parse_times(args.times)
    except ValueError as exc:
        parser.error(str(exc))
    try:
        labels = load_labels(args.labels)
    except SystemExit as exc:
        print(exc, file=sys.stderr)
        return 1
    return run_spike(
        video=args.video,
        times=list(times),
        game_pack=args.game_pack,
        repeat=args.repeat,
        out_dir=args.out,
        labels=labels,
    )


if __name__ == "__main__":
    raise SystemExit(main())
