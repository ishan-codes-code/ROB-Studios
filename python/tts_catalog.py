"""TTS catalogue probe: expose the Python TTS source of truth as JSON.

Offline one-shot for the Electron main process (no key, no network):
prints one JSON line describing the pinned models, prebuilt voices,
defaults, and validation limits straight from
``ai_commentator.tts.config``. The renderer must never hardcode its own
catalogue; it receives this document through IPC instead.

Exit codes: 0 with ``{"ok": true, ...}`` on success, 1 with
``{"ok": false, "error": ...}`` on unexpected failure.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from ai_commentator.tts.config import (
    DEFAULT_TTS_MODEL,
    DEFAULT_TTS_VOICE,
    DEFAULT_TTS_VOICE_DIRECTION,
    MAX_TTS_VOICE_DIRECTION_LENGTH,
    MAX_TTS_VOICE_LENGTH,
    PREBUILT_VOICES,
    TTS_MODEL_DESCRIPTIONS,
    TTS_MODELS,
)


def build_tts_catalog() -> dict:
    """Assemble the catalogue document from the pinned TTS config."""
    return {
        "ok": True,
        "models": [
            {
                "id": model,
                "description": TTS_MODEL_DESCRIPTIONS.get(model, ""),
            }
            for model in TTS_MODELS
        ],
        "voices": [
            {"id": voice_id, "character": character}
            for voice_id, character in PREBUILT_VOICES
        ],
        "defaults": {
            "model": DEFAULT_TTS_MODEL,
            "voice": DEFAULT_TTS_VOICE,
            "voiceDirection": DEFAULT_TTS_VOICE_DIRECTION,
        },
        "limits": {
            "voiceMaxLength": MAX_TTS_VOICE_LENGTH,
            "voiceDirectionMaxLength": MAX_TTS_VOICE_DIRECTION_LENGTH,
        },
    }


def main() -> int:
    try:
        catalog = build_tts_catalog()
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"TTS catalogue failed: {exc}"}))
        return 1
    print(json.dumps(catalog, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
