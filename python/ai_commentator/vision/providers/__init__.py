"""Explicit provider adapters for the vision engine.

Three providers are supported: ``meta`` (Meta Model API, Responses
API at ``https://api.meta.ai/v1/responses``), ``baseten``
(OpenAI-compatible Chat Completions at
``https://inference.baseten.co/v1`` with the single pinned model
``meta-models/muse-spark-open``), and ``custom`` (a user-configured
OpenAI-compatible endpoint with an explicit model ID and best-effort
live model discovery).

The pipeline (batch, adaptive, worker) talks only to the
:class:`VisionProviderAdapter` interface here; HTTP protocol details
stay inside the concrete adapters. Observation parsing/validation
stays in :mod:`..observations` and is never duplicated here.
"""

from .base import VisionProviderAdapter, redact_secret
from .baseten import BasetenAdapter
from .custom import CustomAdapter
from .meta import MetaAdapter
from .registry import (
    BASETEN_BASE_URL,
    BASETEN_MODEL,
    META_BASE_URL,
    META_MODELS,
    PROVIDER_BASETEN,
    PROVIDER_CUSTOM,
    PROVIDER_META,
    PROVIDER_MODELS,
    SUPPORTED_PROVIDERS,
    create_adapter,
    get_provider_models,
    is_supported_model,
    resolve_live_adapter,
    resolve_provider_config,
)

__all__ = [
    "VisionProviderAdapter",
    "redact_secret",
    "BasetenAdapter",
    "CustomAdapter",
    "MetaAdapter",
    "BASETEN_BASE_URL",
    "BASETEN_MODEL",
    "META_BASE_URL",
    "META_MODELS",
    "PROVIDER_BASETEN",
    "PROVIDER_CUSTOM",
    "PROVIDER_META",
    "PROVIDER_MODELS",
    "SUPPORTED_PROVIDERS",
    "create_adapter",
    "get_provider_models",
    "is_supported_model",
    "resolve_live_adapter",
    "resolve_provider_config",
]
