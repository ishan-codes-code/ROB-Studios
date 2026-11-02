"""One-shot, main-process-invoked provider setup operations (JSON stdout).

Provider-aware: ``--provider meta|baseten`` (default ``baseten``) with a
curated model catalogue per provider — no generic model discovery and no
arbitrary base URLs. ``models`` returns the catalogue (every model marked
``unverified`` until the user runs ``verify-vision``). ``connection``
and ``verify-vision`` perform real, minimal provider requests through
the matching adapter; ``verify-vision`` sends a small image request and
may incur provider charges.

Failures are structured, not generic: ``{"ok": false, "error", "code",
"status", "provider", "operation", "detail"}`` where ``error`` is a
secret-free, actionable user message, ``code`` a stable category, and
``detail`` a truncated sanitized note for logs. Provider exception
bodies are never forwarded raw; no secrets are ever printed.
"""
import argparse
import json
import os
import sys

from ai_commentator.errors import ObservationError
from ai_commentator.vision.providers.registry import (
    PROVIDER_BASETEN,
    get_provider_models,
    validate_provider_model,
)

USER_MESSAGES = {
    "auth": "Authentication failed. Check the API key.",
    "model": "The selected model does not support image input.",
    "image": "The provider rejected the image format.",
    "bad_request": "The provider rejected the request. Check the model and key.",
    "rate_limit": "Rate limit reached. Try again later.",
    "timeout": "The provider request timed out.",
    "network": "Could not reach the provider. Check the network connection.",
    "bad_response": "The provider returned an empty or invalid response.",
    "provider_error": "Provider request failed. Check the key, model, and provider compatibility.",
    "unknown": "Provider request failed. Check the key, model, and provider compatibility.",
}

_KNOWN_CODES = frozenset(USER_MESSAGES)


def _key() -> str:
    key = os.environ.get("AI_COMMENTATOR_PROVIDER_API_KEY", "")
    if not key:
        raise ValueError("Provider credential is missing.")
    return key


def _sanitize_detail(exc: BaseException, limit: int = 500) -> str:
    """Truncated secret-free note for logs; adapters already redact keys."""
    try:
        text = str(exc)
    except Exception:
        text = ""
    text = " ".join(text.split())
    if len(text) > limit:
        text = text[:limit] + "…(truncated)"
    return text


def failure_result(operation, provider, exc) -> dict:
    """Build the structured failure document for any setup error."""
    code = getattr(exc, "code", None)
    status = getattr(exc, "status", None)
    if isinstance(exc, ObservationError):
        code = "bad_response"
        message = USER_MESSAGES["bad_response"]
    elif isinstance(exc, ValueError):
        # Local validation (missing key, unsupported provider/model):
        # the message holds only IDs, never secrets.
        code = "config"
        message = str(exc) or USER_MESSAGES["unknown"]
    else:
        if code not in _KNOWN_CODES:
            code = "unknown"
        message = USER_MESSAGES[code]
    return {
        "ok": False,
        "error": message,
        "code": code,
        "status": status if isinstance(status, int) else None,
        "provider": provider,
        "operation": operation,
        "detail": _sanitize_detail(exc),
    }


def run(operation, base_url=None, model="", provider="baseten"):
    provider = (provider or "").strip() or PROVIDER_BASETEN
    if operation == "models":
        names = get_provider_models(provider)
        if model:
            validate_provider_model(provider, model)
        return {
            "ok": True,
            "provider": provider,
            "models": [{"id": name, "vision": "unverified"} for name in names],
        }
    if operation not in ("connection", "verify-vision"):
        raise ValueError("Unsupported provider operation.")
    provider, clean_model = validate_provider_model(
        provider, model or get_provider_models(provider)[0]
    )
    key = _key()
    if provider == "meta":
        from ai_commentator.vision.providers.meta import MetaAdapter

        adapter = MetaAdapter(model=clean_model, api_key=key, timeout=20.0)
    else:
        from ai_commentator.vision.providers.baseten import BasetenAdapter

        adapter = BasetenAdapter(model=clean_model, api_key=key, timeout=20.0)
    try:
        if operation == "connection":
            adapter.verify_connection()
            return {"ok": True, "provider": provider, "connected": True}
        adapter.verify_image()
        return {"ok": True, "provider": provider, "visionVerified": True}
    finally:
        try:
            adapter.close()
        except Exception:
            pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("operation",
                        choices=("connection", "models", "verify-vision"))
    parser.add_argument("--base-url", default="")
    parser.add_argument("--model", default="")
    parser.add_argument("--provider", default="baseten")
    args = parser.parse_args()
    try:
        result = run(args.operation, args.base_url, args.model, args.provider)
    except Exception as exc:
        # Structured, secret-free failure: never forward raw provider
        # exception bodies (they can contain headers or credentials).
        provider = (args.provider or "").strip() or PROVIDER_BASETEN
        result = failure_result(args.operation, provider, exc)
        print(json.dumps(result), flush=True)
        return 1
    print(json.dumps(result), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
