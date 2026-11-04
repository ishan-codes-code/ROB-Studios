"""Structured API activity capture for AI-provider requests.

Every actual outbound model request (vision, commentary/script wording,
TTS utterances) records a paired started/terminal event at the request
boundary. Events are buffered in-process; ``python/worker.py`` drains the
buffer onto the NDJSON protocol as ``api_activity`` messages.

Security: activity events never carry API keys, authorization headers,
image bytes, data URLs, or full request bodies. Provider errors are passed
through ``redact_secret`` by the capturing call site (or again here as a
belt-and-braces pass with the known key) and truncated to a bounded size.
"""

from __future__ import annotations

import threading
import time
import uuid

MAX_ERROR_CHARS = 300
MAX_METADATA_KEYS = 12


def _utc_ms_now() -> int:
    return int(time.time() * 1000)


def _clean_text(value, limit: int) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    if len(text) > limit:
        text = text[:limit].rstrip() + "…"
    return text


def _clean_int(value) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int) and value >= 0:
        return value
    return None


def usage_of(response):
    """Return ``(input_tokens, output_tokens)`` reported by the provider.

    Returns ``(None, None)`` when the response carries no usage object.
    Only provider-reported usage is returned; nothing is estimated.
    Supports OpenAI-style ``prompt_tokens``/``completion_tokens`` and
    Responses-style ``input_tokens``/``output_tokens``, as attributes
    or dict keys. A raw response-body dict (Meta) is accepted directly.
    """
    if isinstance(response, dict):
        usage = response.get("usage")
    else:
        usage = getattr(response, "usage", None)
    if isinstance(usage, dict):
        return (usage.get("prompt_tokens", usage.get("input_tokens")),
                usage.get("completion_tokens", usage.get("output_tokens")))
    if usage is None:
        return None, None
    in_tokens = getattr(usage, "prompt_tokens", None)
    out_tokens = getattr(usage, "completion_tokens", None)
    if in_tokens is None:
        in_tokens = getattr(usage, "input_tokens", None)
    if out_tokens is None:
        out_tokens = getattr(usage, "output_tokens", None)
    return in_tokens, out_tokens


def fail_from_error(tracker: "ApiRequestTracker", error: Exception) -> None:
    """Record a terminal failure from a structured provider error.

    Reads the stable ``code``/``status`` fields carried by
    ``VisionAPIError``/``WriterAPIError`` (whose messages are already
    redacted at the raise site); anything else becomes ``unknown``.
    """
    tracker.fail(
        error_code=getattr(error, "code", None) or "unknown",
        message=str(error),
        http_status=getattr(error, "status", None),
    )


def sanitize_metadata(metadata) -> dict:
    """Return a bounded, secret-free metadata dict (never raises)."""
    if not isinstance(metadata, dict):
        return {}
    safe: dict = {}
    for key in list(metadata.keys())[:MAX_METADATA_KEYS]:
        if not isinstance(key, str):
            continue
        lowered = key.lower()
        # Never let secret-bearing or payload-bearing keys through.
        if any(token in lowered for token in (
                "key", "secret", "token", "auth", "credential",
                "image", "base64", "data_url", "dataurl", "body",
                "payload", "prompt", "message")):
            continue
        try:
            text = str(metadata[key])
        except Exception:
            continue
        if len(text) > 120:
            text = text[:120].rstrip() + "…"
        safe[key] = text
    return safe


class ApiRequestTracker:
    """Paired started/terminal recorder for one outbound request.

    The tracker appends plain-dict events to a caller-supplied buffer (the
    module-level buffer by default) so provider adapters stay decoupled
    from transport. Exactly one terminal event is emitted per ``start()``;
    calling ``succeed``/``fail``/``cancel`` twice is a no-op.
    """

    def __init__(self, provider: str, purpose: str, model: str | None = None,
                 frame_count: int = 0, metadata: dict | None = None,
                 buffer: list | None = None) -> None:
        self.request_id = f"req-{uuid.uuid4().hex[:12]}"
        self.provider = str(provider or "unknown")
        self.purpose = str(purpose or "unknown")
        self.model = model if isinstance(model, str) and model else None
        self.frame_count = frame_count if isinstance(frame_count, int) and frame_count > 0 else 0
        self.metadata = sanitize_metadata(metadata)
        self._buffer = buffer if buffer is not None else _BUFFER
        self._started_at: int | None = None
        self._terminal = False

    def start(self) -> str:
        """Emit the started event; return the request id."""
        self._started_at = _utc_ms_now()
        event = {
            "id": self.request_id,
            "event": "started",
            "provider": self.provider,
            "purpose": self.purpose,
            "model": self.model,
            "startedAt": self._started_at,
            "frameCount": self.frame_count,
            "metadata": self.metadata,
        }
        self._append(event)
        return self.request_id

    def _terminal_event(self, status: str, **fields) -> dict:
        completed_at = _utc_ms_now()
        event = {
            "id": self.request_id,
            "event": "terminal",
            "status": status,
            "completedAt": completed_at,
            "durationMs": (completed_at - self._started_at)
            if self._started_at is not None else None,
        }
        for key, value in fields.items():
            if value is not None:
                event[key] = value
        return event

    def succeed(self, http_status=None, input_tokens=None,
                output_tokens=None) -> None:
        """Emit the success terminal event (first call wins)."""
        if self._terminal:
            return
        self._terminal = True
        self._append(self._terminal_event(
            "succeeded",
            httpStatus=_clean_int(http_status),
            inputTokens=_clean_int(input_tokens),
            outputTokens=_clean_int(output_tokens),
        ))

    def fail(self, error_code: str | None = None,
             message: str | None = None, http_status=None) -> None:
        """Emit the failure terminal event (first call wins)."""
        if self._terminal:
            return
        self._terminal = True
        self._append(self._terminal_event(
            "failed",
            errorCode=_clean_text(error_code, 60) or "unknown",
            errorMessage=_clean_text(message, MAX_ERROR_CHARS),
            httpStatus=_clean_int(http_status),
        ))

    def cancel(self) -> None:
        """Emit the cancelled terminal event (first call wins)."""
        if self._terminal:
            return
        self._terminal = True
        self._append(self._terminal_event("cancelled"))

    def _append(self, event: dict) -> None:
        try:
            self._buffer.append(event)
        except Exception:
            # Diagnostics must never break the pipeline.
            pass


_BUFFER: list = []
_BUFFER_LOCK = threading.Lock()


def drain_events() -> list:
    """Pop and return buffered activity events (thread-safe)."""
    with _BUFFER_LOCK:
        events = list(_BUFFER)
        del _BUFFER[:]
    return events


def buffer_size() -> int:
    with _BUFFER_LOCK:
        return len(_BUFFER)
