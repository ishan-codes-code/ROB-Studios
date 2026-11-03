"""Temporary development invocation for the TTS proof of concept.

Reads the Gemini API key from the ``AI_COMMENTATOR_PROVIDER_API_KEY``
environment variable (same handoff the Electron vault uses for the
Python worker), synthesizes one text turn, and saves complete WAV bytes.

Usage (PowerShell):
    $env:AI_COMMENTATOR_PROVIDER_API_KEY = "<key>"
    .\\.venv\\Scripts\\python.exe python/tts_say.py "Hello from the commentary box." --out tts-out.wav
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from ai_commentator.tts.client import GeminiTTSClient
from ai_commentator.tts.config import (
    DEFAULT_TTS_MODEL,
    DEFAULT_TTS_VOICE,
    DEFAULT_TTS_VOICE_DIRECTION,
    TTS_MODELS,
)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Synthesize one text turn with Gemini TTS and save a WAV file."
    )
    parser.add_argument("text", help="Text to speak.")
    parser.add_argument("--model", default=DEFAULT_TTS_MODEL,
                        help=f"TTS model (default {DEFAULT_TTS_MODEL}).")
    parser.add_argument("--voice", default=DEFAULT_TTS_VOICE,
                        help=f"Voice ID (default {DEFAULT_TTS_VOICE}).")
    parser.add_argument("--style", default=DEFAULT_TTS_VOICE_DIRECTION,
                        help="Voice direction (speech style).")
    parser.add_argument("--out", default="tts-out.wav",
                        help="Destination WAV path.")
    args = parser.parse_args(argv)

    import os

    api_key = os.environ.get("AI_COMMENTATOR_PROVIDER_API_KEY", "")
    if not api_key:
        print(
            "error: set AI_COMMENTATOR_PROVIDER_API_KEY before running.",
            file=sys.stderr,
        )
        return 2
    if args.model not in TTS_MODELS:
        print(f"error: unsupported model {args.model!r}.", file=sys.stderr)
        return 2

    client = GeminiTTSClient(api_key=api_key, model=args.model)
    try:
        wav = client.synthesize(args.text, voice=args.voice, style=args.style)
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    finally:
        client.close()

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(wav)
    print(f"saved {len(wav)} bytes to {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
