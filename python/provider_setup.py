"""One-shot, main-process-invoked provider setup operations (JSON stdout).

Provider-aware: ``--provider meta|baseten`` (default ``baseten``) with a
curated model catalogue per provider — no generic model discovery and no
arbitrary base URLs. ``models`` returns the catalogue (every model marked
``unverified`` until the user runs ``verify-vision``). ``connection``
and ``verify-vision`` perform real, minimal provider requests through
the matching adapter; ``verify-vision`` sends a small image request and
may incur provider charges. Provider exception bodies are never
forwarded; no secrets are ever printed.
"""
import argparse
import json
import os
import sys

from ai_commentator.vision.providers.registry import (
    PROVIDER_BASETEN,
    get_provider_models,
    validate_provider_model,
)


def _key() -> str:
    key = os.environ.get("AI_COMMENTATOR_PROVIDER_API_KEY", "")
    if not key:
        raise ValueError("Provider credential is missing.")
    return key


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
    except Exception:
        # Provider exception bodies can contain headers or credentials.
        result = {"ok": False, "error": "Provider request failed. Check the key, model, and provider compatibility."}
        print(json.dumps(result), flush=True)
        return 1
    print(json.dumps(result), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
