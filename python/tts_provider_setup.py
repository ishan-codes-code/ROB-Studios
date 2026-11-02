"""Google Gemini TTS credential check, isolated from Vision adapters."""
from __future__ import annotations

import os
import socket
import urllib.error

TTS_MODEL_ID = "gemini-3.8-flash-tts"


class GeminiSetupError(Exception):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def _category(exc: BaseException) -> str:
    status = getattr(exc, "code", None) or getattr(exc, "status_code", None)
    try:
        status = int(status)
    except (TypeError, ValueError):
        status = None
    name = type(exc).__name__.lower()
    if status in (400, 401, 403):
        return "permission" if status == 403 else "auth"
    if status == 429:
        return "quota"
    if "timeout" in name or isinstance(exc, TimeoutError):
        return "timeout"
    if isinstance(exc, (ConnectionError, socket.gaierror, urllib.error.URLError)) or any(
        part in name for part in ("connection", "transport", "network")
    ):
        return "network"
    return "unknown"


def verify_tts_api_key(key: str | None = None) -> dict:
    """Check key auth and TTS model metadata access, without generation.

    A successful result does not guarantee inference entitlement; Google
    does not expose a non-generative endpoint that tests that permission.
    """
    api_key = key if key is not None else os.environ.get(
        "AI_COMMENTATOR_PROVIDER_API_KEY", ""
    )
    if not api_key:
        raise ValueError("Provider credential is missing.")
    client = None
    try:
        from google import genai
        from google.genai import types

        client = genai.Client(
            api_key=api_key,
            http_options=types.HttpOptions(timeout=10000),
        )
        client.models.get(model=TTS_MODEL_ID)
        return {
            "ok": True,
            "provider": "google-gemini-tts",
            "connected": True,
            "ttsModelMetadataAvailable": True,
            "capability": "authentication-and-model-metadata",
        }
    except Exception as exc:
        raise GeminiSetupError(_category(exc)) from None
    finally:
        if client is not None:
            try:
                client.close()
            except Exception:
                pass
