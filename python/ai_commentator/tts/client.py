"""Gemini TTS client: request formatting, response parsing, error mapping.

Follows the official single-speaker TTS contract
(https://aistudio.google.com/docs/speech-generation): unary
``interactions.create`` with ``response_format {"type": "audio"}`` and a
``speech_config`` voice returns complete ``audio/wav`` bytes (44-byte
RIFF header). WAV bytes are persisted exactly as returned — no header
is ever added or stripped here.
"""

from __future__ import annotations

from ..api_activity import ApiRequestTracker, fail_from_error
from .config import DEFAULT_TTS_MODEL, validate_tts_model


class TtsError(RuntimeError):
    """TTS request failed; the message is already redacted.

    ``code`` is a stable category, ``status`` the HTTP status when
    known, and ``provider`` the TTS provider id.
    """

    def __init__(self, message, *, code="provider_error", status=None,
                 provider="google-gemini-tts"):
        super().__init__(message)
        self.code = code
        self.status = status
        self.provider = provider


def _redact(text: str, api_key: str) -> str:
    if api_key and api_key in text:
        text = text.replace(api_key, "[REDACTED]")
    return text


def classify_tts_status(status: int | None) -> str:
    """Map an HTTP status to a stable TTS error code."""
    if status == 401:
        return "auth"
    if status in (403, 404):
        return "permission"
    if status == 429:
        return "quota"
    if status in (408, 504):
        return "timeout"
    if status == 400:
        return "bad_request"
    if status is not None and 500 <= status < 600:
        return "network"
    return "provider_error"


class GeminiTTSClient:
    """Thin wrapper around the pinned ``google-genai`` SDK surface."""

    PROVIDER_ID = "google-gemini-tts"

    def __init__(self, api_key: str = "", model: str = DEFAULT_TTS_MODEL,
                 timeout: float = 60.0, client=None) -> None:
        validate_tts_model(model)
        if not api_key:
            raise ValueError("TTS API key is required.")
        self.api_key = api_key
        self.model = model
        self.timeout = timeout
        self._owned = client is None
        if client is not None:
            self._client = client
        else:
            from google import genai
            from google.genai import types

            # Gemini TTS models are served on v1beta, not the SDK-default v1.
            self._client = genai.Client(
                api_key=api_key,
                http_options=types.HttpOptions(
                    timeout=int(timeout * 1000), api_version="v1beta"),
            )

    def close(self) -> None:
        if self._owned and self._client is not None:
            try:
                self._client.close()
            except Exception:
                pass
            finally:
                self._client = None

    # -- synthesis ------------------------------------------------------
    def synthesize(self, text: str, *, voice: str, style: str) -> bytes:
        """Synthesize one text turn, returning complete WAV bytes."""
        from .config import validate_tts_voice, validate_tts_voice_direction

        clean_text = text.strip() if isinstance(text, str) else ""
        if not clean_text:
            raise ValueError("TTS text is required.")
        clean_voice = validate_tts_voice(voice)
        clean_style = validate_tts_voice_direction(style)
        tracker = ApiRequestTracker(
            self.PROVIDER_ID, "tts", model=self.model,
            metadata={"voice": clean_voice, "style": clean_style},
        )
        tracker.start()
        try:
            interaction = self._client.interactions.create(
                model=self.model,
                input=[{
                    "type": "user_input",
                    "content": [{
                        "type": "text",
                        "text": clean_text,
                        "annotations": [{
                            "type": "speech_metadata",
                            "style": clean_style,
                        }],
                    }],
                }],
                response_format={"type": "audio"},
                generation_config={
                    "speech_config": [{"voice": clean_voice}],
                },
            )
        except Exception as exc:
            wrapped = self._wrap_error(exc)
            fail_from_error(tracker, wrapped)
            raise wrapped from None
        tracker.succeed()
        return self._extract_wav(interaction)

    def _extract_wav(self, interaction) -> bytes:
        """Pull complete WAV bytes out of an interaction response."""
        import base64

        audio = getattr(interaction, "output_audio", None)
        if audio is None:
            # Fall back to scanning steps for the last audio content block.
            for step in reversed(getattr(interaction, "steps", None) or []):
                candidate = getattr(step, "output_audio", None)
                if candidate is not None and getattr(candidate, "data", None):
                    audio = candidate
                    break
        if audio is None or not getattr(audio, "data", None):
            raise TtsError(
                "Gemini TTS returned no audio for this text.",
                code="bad_response",
                provider=self.PROVIDER_ID,
            )
        mime = (getattr(audio, "mime_type", "") or "").lower()
        if mime and mime != "audio/wav":
            raise TtsError(
                f"Gemini TTS returned unexpected audio type {mime!r}; "
                "expected complete audio/wav.",
                code="bad_response",
                provider=self.PROVIDER_ID,
            )
        try:
            raw = base64.b64decode(audio.data, validate=True)
        except Exception:
            raise TtsError(
                "Gemini TTS returned invalid audio data.",
                code="bad_response",
                provider=self.PROVIDER_ID,
            ) from None
        if len(raw) <= 44 or not raw.startswith(b"RIFF"):
            raise TtsError(
                "Gemini TTS returned an incomplete WAV file.",
                code="bad_response",
                provider=self.PROVIDER_ID,
            )
        return raw

    # -- voice library ---------------------------------------------------
    def list_voices(self, *, page_size: int = 100, page_token=None) -> dict:
        """List Extended Voice Library entries (sanitized plain data)."""
        try:
            response = self._client.voices.list(
                config={"page_size": page_size, **(
                    {"page_token": page_token} if page_token else {})},
            )
        except Exception as exc:
            raise self._wrap_error(exc) from None
        voices = []
        for entry in getattr(response, "voices", None) or []:
            voices.append({
                "id": getattr(entry, "id", None)
                or getattr(entry, "name", None),
                "display_name": getattr(entry, "display_name", None),
                "description": getattr(entry, "description", None),
                "persona": getattr(entry, "persona", None),
                "gender": getattr(entry, "gender", None),
                "language_code": getattr(entry, "language_code", None),
            })
        return {
            "voices": [v for v in voices if v["id"]],
            "next_page_token": getattr(response, "next_page_token", None),
        }

    # -- errors ----------------------------------------------------------
    def _wrap_error(self, exc: Exception) -> TtsError:
        status = getattr(exc, "status_code", None)
        try:
            status = int(status)
        except (TypeError, ValueError):
            response = getattr(exc, "response", None)
            try:
                status = int(getattr(response, "status_code", None))
            except (TypeError, ValueError):
                status = None
        body = getattr(exc, "body", None)
        detail = ""
        if isinstance(body, dict):
            for key in ("message", "error", "detail"):
                value = body.get(key)
                if isinstance(value, str) and value.strip():
                    detail = value.strip()
                    break
        if not detail:
            detail = getattr(exc, "message", None) or str(exc)
        detail = " ".join(str(detail).split())
        if len(detail) > 300:
            detail = detail[:300] + "...(truncated)"
        message = (
            f"Gemini TTS request failed"
            f"{f' (HTTP {status})' if status else ''}: "
            f"{_redact(detail, self.api_key)}"
        )
        return TtsError(
            message,
            code=classify_tts_status(status),
            status=status,
            provider=self.PROVIDER_ID,
        )
