"""Provider catalogue and adapter factory.

Meta and Baseten are curated (pinned endpoints, fixed model lists, no
live discovery). ``custom`` is a user-configured OpenAI-compatible
endpoint: no curated models, per-record base URL, best-effort live
``GET /models`` discovery with manual model entry as the fallback.
"""

from __future__ import annotations

import os

from .baseten import (
    BASE_URL as _BASETEN_BASE_URL,
    MODEL as _BASETEN_MODEL,
    normalize_model as _normalize_baseten_model,
)
from .custom import (
    validate_base_url as _validate_custom_base_url,
    validate_model_id as _validate_custom_model_id,
)
from .meta import BASE_URL as _META_BASE_URL, MODELS as _META_MODELS

PROVIDER_META = "meta"
PROVIDER_BASETEN = "baseten"
PROVIDER_CUSTOM = "custom"
SUPPORTED_PROVIDERS = (PROVIDER_META, PROVIDER_BASETEN, PROVIDER_CUSTOM)

CUSTOM_BASE_URL_ENV_VAR = "AI_COMMENTATOR_BASE_URL"

META_BASE_URL = _META_BASE_URL
META_MODELS = _META_MODELS
BASETEN_BASE_URL = _BASETEN_BASE_URL
BASETEN_MODEL = _BASETEN_MODEL

PROVIDER_MODELS: dict[str, tuple[str, ...]] = {
    PROVIDER_META: META_MODELS,
    PROVIDER_BASETEN: (BASETEN_MODEL,),
    # Custom has no curated catalogue: the empty tuple marks "explicit
    # model ID required" (discovery or manual entry), never "any model".
    PROVIDER_CUSTOM: (),
}

PROVIDER_DISPLAY: dict[str, str] = {
    PROVIDER_META: "Meta Model API",
    PROVIDER_BASETEN: "Baseten",
    PROVIDER_CUSTOM: "Custom OpenAI-compatible API",
}


def get_provider_models(provider: str) -> tuple[str, ...]:
    """Return the curated selectable models for ``provider``."""
    if provider not in PROVIDER_MODELS:
        raise ValueError(f"Unsupported provider {provider!r}.")
    return PROVIDER_MODELS[provider]


def is_supported_model(provider: str, model: str) -> bool:
    """True when ``model`` is in the curated catalogue for ``provider``."""
    try:
        return model in PROVIDER_MODELS[provider]
    except KeyError:
        return False


def validate_provider_model(provider: str, model: str) -> tuple[str, str]:
    """Validate and normalize a ``(provider, model)`` pair."""
    if provider not in SUPPORTED_PROVIDERS:
        raise ValueError(f"Unsupported provider {provider!r}.")
    if provider == PROVIDER_CUSTOM:
        # Explicit, never curated: any well-formed model ID is accepted.
        # Image capability is proven only by verify_image, never by the
        # ID or by discovery membership.
        return provider, _validate_custom_model_id(model)
    if not isinstance(model, str) or not model.strip():
        raise ValueError("A vision model ID is required.")
    clean = model.strip()
    if provider == PROVIDER_BASETEN:
        # Saved credentials / environments may still carry the previous
        # pinned identifier; normalize instead of rejecting so existing
        # configurations keep resolving (re-verification still required).
        clean = _normalize_baseten_model(clean)
    if clean not in PROVIDER_MODELS[provider]:
        raise ValueError(
            f"Unsupported model {model!r} for provider {provider!r}."
        )
    return provider, clean


def custom_base_url_from_env() -> str:
    """Return the validated custom endpoint URL from the environment."""
    return _validate_custom_base_url(
        os.environ.get(CUSTOM_BASE_URL_ENV_VAR, "")
    )


def create_adapter(provider: str, model: str, api_key: str,
                   timeout: float = 60.0, base_url: str | None = None):
    """Instantiate the concrete adapter for ``provider`` (no I/O)."""
    provider, model = validate_provider_model(provider, model)
    if not isinstance(api_key, str) or not api_key:
        raise ValueError("A provider API key is required.")
    if provider == PROVIDER_META:
        from .meta import MetaAdapter

        return MetaAdapter(model=model, api_key=api_key, timeout=timeout)
    if provider == PROVIDER_CUSTOM:
        from .custom import CustomAdapter

        return CustomAdapter(model=model, api_key=api_key,
                             base_url=base_url or "", timeout=timeout)
    from .baseten import BasetenAdapter

    return BasetenAdapter(model=model, api_key=api_key, timeout=timeout)


def resolve_provider_config() -> dict:
    """Resolve the active provider runtime config from the environment.

    Explicit contract (preferred)::

        AI_COMMENTATOR_PROVIDER  ``meta`` | ``baseten`` | ``custom``
        AI_COMMENTATOR_MODEL     curated model ID for that provider
                                 (explicit ID for ``custom``)
        AI_COMMENTATOR_BASE_URL  custom endpoint URL (``custom`` only)
        AI_COMMENTATOR_API_KEY   bearer credential (secret)

    Custom resolutions carry an extra validated ``base_url`` key;
    curated resolutions keep the exact historical three-key shape.
    Legacy compatibility: when the explicit provider is absent, fall back
    to ``BASETEN_MODEL``/``BASETEN_API_KEY`` as a Baseten configuration.
    The fallback never guesses across providers: a ``BASETEN_*`` value
    always means Baseten. Raises ``RuntimeError`` when no key is present
    and ``ValueError`` for unsupported provider/model pairs.
    """
    provider = (os.environ.get("AI_COMMENTATOR_PROVIDER") or "").strip()
    model = (os.environ.get("AI_COMMENTATOR_MODEL") or "").strip()
    key = os.environ.get("AI_COMMENTATOR_API_KEY") or ""
    if provider or model or key:
        if not provider:
            raise ValueError("AI_COMMENTATOR_PROVIDER is required.")
        if not key:
            raise RuntimeError("AI_COMMENTATOR_API_KEY is not set in the environment.")
        provider, model = validate_provider_model(
            provider, model or PROVIDER_MODELS.get(provider, ("",))[0]
        )
        if provider == PROVIDER_CUSTOM:
            return {"provider": provider, "model": model, "api_key": key,
                    "base_url": custom_base_url_from_env()}
        return {"provider": provider, "model": model, "api_key": key}
    legacy_key = os.environ.get("BASETEN_API_KEY") or ""
    if not legacy_key:
        raise RuntimeError("AI_COMMENTATOR_API_KEY is not set in the environment.")
    legacy_model = (os.environ.get("BASETEN_MODEL") or "").strip() or BASETEN_MODEL
    provider, legacy_model = validate_provider_model(PROVIDER_BASETEN, legacy_model)
    return {"provider": provider, "model": legacy_model, "api_key": legacy_key}


def resolve_live_adapter(timeout: float = 60.0):
    """Build the active adapter from the environment (may construct I/O)."""
    from ...config import ADAPTIVE_REQUEST_TIMEOUT_S

    config = resolve_provider_config()
    return create_adapter(
        config["provider"],
        config["model"],
        config["api_key"],
        timeout=timeout or ADAPTIVE_REQUEST_TIMEOUT_S,
        base_url=config.get("base_url"),
    )
