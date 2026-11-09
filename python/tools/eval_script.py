"""Offline automated eval of a commentary script (rubric Prompt 0.2 subset).

Usage:
    python -I python/tools/eval_script.py <script.json>
        [--timeline <events.json>] [--wav-dir DIR]

Reads a ``script.json``-shaped document (any JSON object with a
``segments`` list; each segment needs ``timestamp_seconds`` and ``text``)
and reports the currently automated metrics:

- lines count, words/sec per line, lines per minute over the script
  span (last line end minus first line start),
- forbidden-meta-word hits (see ``FORBIDDEN_META_PHRASES``),
- digit / number-word tokens present per line,
- overlap count over per-line ``[timestamp, timestamp+duration]``
  intervals, where duration is the ``--wav-dir`` ``<segment_id>.wav``
  duration via stdlib ``wave`` when available, else ``words/2.5``.

``--timeline`` accepts an ``events.json`` for future grounding metrics;
today it is only parsed and its event count reported. Prints a
human-readable report, then the same report as JSON after a
``--- JSON ---`` marker line. Fully offline: no network, no model.
"""

import argparse
import json
import re
import sys
import wave
from pathlib import Path

# Mirror tests/: the engine lives in <repo>/python, which is not an
# installed package, so put it on sys.path from this file's location.
# Only the SCRIPT_WORD_NUMBERS constant is reused; metrics are stdlib.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main as engine  # noqa: E402

#: Spoken-text meta language that must never be worded, derived from the
#: script-v1 spoken-text bans (the docs/eval/commentary-rubric.md file
#: does not exist in this repo, so the list is fixed here and reported
#: verbatim in the JSON output for auditability).
FORBIDDEN_META_PHRASES = (
    "not established",
    "unconfirmed",
    "claim_id",
    "source_claim_ids",
)

#: Assumed speech rate (words per second) when no WAV duration exists.
WORDS_PER_SECOND = 2.5

DIGIT_RE = re.compile(r"\d+(?:\.\d+)?")


def count_words(text: str) -> int:
    return len(text.split())


def forbidden_hits(text: str) -> int:
    lowered = text.lower()
    return sum(lowered.count(phrase) for phrase in FORBIDDEN_META_PHRASES)


def number_tokens(text: str) -> list:
    tokens = DIGIT_RE.findall(text)
    lowered = text.lower()
    for word in engine.SCRIPT_WORD_NUMBERS:
        if re.search(rf"\b{re.escape(word)}\b", lowered):
            tokens.append(word)
    return tokens


def wav_duration(wav_dir: Path | None, segment_id) -> float | None:
    if wav_dir is None or not segment_id:
        return None
    path = wav_dir / f"{segment_id}.wav"
    if not path.is_file():
        return None
    try:
        with wave.open(str(path), "rb") as handle:
            frames = handle.getnframes()
            rate = handle.getframerate()
        if rate <= 0 or frames < 0:
            return None
        return frames / rate
    except (wave.Error, OSError, EOFError):
        return None


def load_segments(script_path: Path) -> list:
    try:
        doc = json.loads(script_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise SystemExit(f"error: script not found: {script_path}")
    except json.JSONDecodeError as exc:
        raise SystemExit(f"error: script is not valid JSON: {exc}")
    if not isinstance(doc, dict) or not isinstance(doc.get("segments"), list):
        raise SystemExit("error: script must be an object with a 'segments' list.")
    segments = []
    for index, entry in enumerate(doc["segments"]):
        where = f"segments[{index}]"
        if not isinstance(entry, dict):
            raise SystemExit(f"error: {where} must be an object.")
        timestamp = entry.get("timestamp_seconds")
        text = entry.get("text")
        if (
            isinstance(timestamp, bool)
            or not isinstance(timestamp, (int, float))
            or not isinstance(text, str)
            or not text.strip()
        ):
            raise SystemExit(
                f"error: {where} needs a numeric 'timestamp_seconds' "
                f"and non-empty 'text'."
            )
        segments.append(
            {
                "segment_id": entry.get("segment_id", f"line-{index + 1}"),
                "timestamp_seconds": timestamp,
                "text": text,
            }
        )
    return segments


def load_timeline(timeline_path: str | None) -> dict | None:
    if timeline_path is None:
        return None
    path = Path(timeline_path)
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise SystemExit(f"error: timeline not found: {path}")
    except json.JSONDecodeError as exc:
        raise SystemExit(f"error: timeline is not valid JSON: {exc}")
    if not isinstance(doc, dict) or not isinstance(doc.get("events"), list):
        raise SystemExit("error: timeline must be an object with an 'events' list.")
    return {"path": str(path), "events": len(doc["events"])}


def evaluate(
    segments: list,
    wav_dir: Path | None,
    timeline: dict | None,
    script_path: Path,
) -> dict:
    rows = []
    for segment in segments:
        words = count_words(segment["text"])
        duration = wav_duration(wav_dir, segment["segment_id"])
        source = "wav"
        if duration is None:
            duration = words / WORDS_PER_SECOND if words else 0.0
            source = "estimate"
        rows.append(
            {
                "segment_id": segment["segment_id"],
                "timestamp_seconds": segment["timestamp_seconds"],
                "words": words,
                "duration_seconds": duration,
                "duration_source": source,
                "words_per_second": (words / duration) if duration > 0 else 0.0,
                "forbidden_hits": forbidden_hits(segment["text"]),
                "number_tokens": number_tokens(segment["text"]),
            }
        )
    rows.sort(key=lambda row: row["timestamp_seconds"])
    starts = [row["timestamp_seconds"] for row in rows]
    ends = [
        row["timestamp_seconds"] + row["duration_seconds"] for row in rows
    ]
    span = (max(ends) - min(starts)) if rows else 0.0
    overlap_count = 0
    for left in range(len(rows)):
        for right in range(left + 1, len(rows)):
            if starts[right] < ends[left]:
                overlap_count += 1
    number_present = sorted(
        {token for row in rows for token in row["number_tokens"]}
    )
    return {
        "script": str(script_path),
        "lines": len(rows),
        "span_seconds": span,
        "lines_per_minute": (len(rows) * 60.0 / span) if span > 0 else 0.0,
        "forbidden_meta_word_hits": sum(row["forbidden_hits"] for row in rows),
        "forbidden_meta_phrases": list(FORBIDDEN_META_PHRASES),
        "number_tokens_present": number_present,
        "overlap_count": overlap_count,
        "segments": rows,
        "timeline": timeline,
    }


def print_report(report: dict) -> None:
    print(f"lines: {report['lines']}")
    print(f"span_seconds: {report['span_seconds']:.3f}")
    print(f"lines_per_minute: {report['lines_per_minute']:.3f}")
    print(f"forbidden_meta_word_hits: {report['forbidden_meta_word_hits']}")
    present = report["number_tokens_present"]
    print(f"number_tokens_present: {', '.join(present) if present else '-'}")
    print(f"overlap_count: {report['overlap_count']}")
    if report["timeline"] is not None:
        print(f"timeline_events: {report['timeline']['events']}")
    for row in report["segments"]:
        tokens = row["number_tokens"]
        print(
            f"  - {row['segment_id']} ts={row['timestamp_seconds']} "
            f"words={row['words']} "
            f"duration={row['duration_seconds']:.3f} ({row['duration_source']}) "
            f"wps={row['words_per_second']:.3f} "
            f"forbidden={row['forbidden_hits']} "
            f"numbers={','.join(tokens) if tokens else '-'}"
        )


def main(argv: list | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Offline automated eval of a commentary script."
    )
    parser.add_argument("script_json", help="Path to script.json.")
    parser.add_argument("--timeline", default=None, help="Path to events.json.")
    parser.add_argument("--wav-dir", default=None, help="Directory of WAV audio.")
    args = parser.parse_args(argv)

    segments = load_segments(Path(args.script_json))
    wav_dir = Path(args.wav_dir) if args.wav_dir else None
    if wav_dir is not None and not wav_dir.is_dir():
        print(f"error: not a directory: {wav_dir}", file=sys.stderr)
        return 1
    timeline = load_timeline(args.timeline)
    report = evaluate(segments, wav_dir, timeline, Path(args.script_json))
    print_report(report)
    print("--- JSON ---")
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
